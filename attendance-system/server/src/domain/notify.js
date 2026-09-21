// 消息与日报。对应 03 §8。
//
// 核心约束：
//   · 个人日报只发本人，群里不推个人旷课或病假材料；
//   · 去重键保证同一业务版本不重复发送；
//   · 没有当日数据时，不拿上一教学日冒充今日日报；
//   · 数据未齐必须在正文里说明"结果可能更新"；
//   · 发送失败不回滚考勤与审批；
//   · unknown（结果不明）单列，核对后才决定是否补发，不承诺严格一次送达；
//   · IM 无法映射接收人时登记映射异常，不用姓名搜到的第一人代发。

import {Table} from '../adapters/table.js';
import {Message} from '../adapters/message.js';
import {Directory} from '../adapters/identity.js';
import {TENANT_ID} from '../config.js';
import {newId, nowUtc, businessDate, sha256} from '../lib/util.js';
import {getNumber, getBool} from './policy.js';
import {JUDGMENTS} from '../config.js';

/** 入队一条待发消息。message_key 唯一，重复入队直接返回已有记录。 */
export function queueNotification({
  kind, receiverUserId, studentId = null, businessDate: bizDate = null,
  businessRef = null, version = '1', title, body, link = null,
}) {
  if (!receiverUserId) {
    // 接收人无法解析：登记为跳过并留原因，不静默丢弃，也不找人代发。
    const id = newId('ntf');
    Table.insert('notification', {
      notification_id: id, tenant_id: TENANT_ID,
      message_key: `unresolved:${kind}:${studentId ?? id}:${version}`,
      receiver_user_id: 'unresolved', student_id: studentId, kind,
      business_date: bizDate, business_ref: businessRef, summary_version: version,
      payload_ref: JSON.stringify({title, body, link}),
      status: 'skipped', attempts: 0, last_error: 'RECEIVER_UNRESOLVED',
      created_at: nowUtc(),
    });
    return {notification_id: id, status: 'skipped', reason: 'RECEIVER_UNRESOLVED'};
  }

  const messageKey = `${kind}:${receiverUserId}:${businessRef ?? bizDate ?? ''}:${version}`;
  const existing = Table.findOne('notification', {message_key: messageKey});
  if (existing) {
    return {notification_id: existing.notification_id, status: existing.status, deduped: true};
  }

  const id = newId('ntf');
  Table.insert('notification', {
    notification_id: id, tenant_id: TENANT_ID, message_key: messageKey,
    receiver_user_id: receiverUserId, student_id: studentId, kind,
    business_date: bizDate, business_ref: businessRef, summary_version: version,
    payload_ref: JSON.stringify({title, body, link}),
    status: 'queued', attempts: 0, created_at: nowUtc(),
  });
  return {notification_id: id, status: 'queued'};
}

/** 发送队列中的消息。失败重试、unknown 单列，都落在 notification 台账上。 */
export function flushNotifications({limit = 200} = {}) {
  const pending = Table.all('notification', {
    where: {tenant_id: TENANT_ID, status: {op: 'in', value: ['queued', 'failed']}},
    order: [['created_at', 'ASC']],
    limit,
  }).filter((n) => !n.next_retry_at || n.next_retry_at <= nowUtc());

  const summary = {sent: 0, failed: 0, unknown: 0, skipped: 0};
  for (const n of pending) {
    const payload = JSON.parse(n.payload_ref);
    const result = Message.send({
      receiverUserId: n.receiver_user_id,
      kind: n.kind,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      dedupKey: sha256(n.message_key).slice(0, 24),
      whitelistOnly: getBool('notify.whitelist_only', true),
    });

    const attempts = n.attempts + 1;
    if (result.status === 'sent') {
      Table.updateRecord('notification', n.notification_id, {
        status: 'sent', attempts, platform_message_id: result.message_id,
        sent_at: nowUtc(), last_error: null, next_retry_at: null,
      });
      summary.sent += 1;
    } else if (result.status === 'unknown') {
      // 结果不明：不重发，等管理员或消息查询核对后决定
      Table.updateRecord('notification', n.notification_id, {
        status: 'unknown', attempts, last_error: result.error, next_retry_at: null,
      });
      summary.unknown += 1;
    } else if (result.status === 'skipped') {
      Table.updateRecord('notification', n.notification_id, {
        status: 'skipped', attempts, last_error: result.error,
      });
      summary.skipped += 1;
    } else {
      const backoffMinutes = Math.min(2 ** attempts, 60);
      Table.updateRecord('notification', n.notification_id, {
        status: 'failed', attempts, last_error: result.error,
        next_retry_at: new Date(Date.now() + backoffMinutes * 60000).toISOString(),
      });
      summary.failed += 1;
    }
  }
  return summary;
}

/* ---------------------------------------------------------- 学生个人日报 */

/**
 * 生成某业务日的学生个人日报。
 * 只发当日有本人记录的学生；没有当日数据的学生不发，也不补昨天的冒充今日。
 * @returns {{date:string, students:number, queued:number, deduped:number, data_complete:boolean}}
 */
export function buildStudentDailyDigest(attDate, {force = false} = {}) {
  const rows = Table.aggregate(
    `SELECT student_id, class_id, final_judgment, COUNT(*) AS n
       FROM attendance WHERE tenant_id = ? AND att_date = ?
      GROUP BY student_id, class_id, final_judgment`,
    [TENANT_ID, attDate],
  );

  if (!rows.length) {
    return {
      date: attDate, students: 0, queued: 0, deduped: 0,
      data_complete: false,
      note: '当日没有任何考勤数据，未向学生发送日报；应提醒数据管理员确认是否尚未导入',
      alert_data_manager: true,
    };
  }

  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) {
      byStudent.set(r.student_id, {class_id: r.class_id, counts: Object.fromEntries(JUDGMENTS.map((j) => [j, 0]))});
    }
    byStudent.get(r.student_id).counts[r.final_judgment] = r.n;
  }

  // 数据是否齐全：必须由辅导员显式确认，不能由"导入成功"推断
  const classIds = [...new Set(rows.map((r) => r.class_id))];
  const coverage = Table.all('data_coverage', {
    where: {tenant_id: TENANT_ID, att_date: attDate, class_id: {op: 'in', value: classIds}},
    limit: 5000,
  });
  const confirmedComplete = new Set(
    coverage.filter((c) => c.coverage_status === 'complete').map((c) => c.class_id),
  );

  let queued = 0;
  let deduped = 0;
  for (const [studentId, info] of byStudent) {
    const receiver = userIdOfStudent(studentId);
    const complete = confirmedComplete.has(info.class_id);
    const {title, body} = renderStudentDigest(attDate, studentId, info.counts, complete);
    // 版本键包含结果摘要：结果变了会产生新版本，从而允许发"重要更正"通知
    const version = force
      ? `manual-${Date.now()}`
      : sha256(JSON.stringify(info.counts) + String(complete)).slice(0, 12);
    const out = queueNotification({
      kind: 'student_daily',
      receiverUserId: receiver,
      studentId,
      businessDate: attDate,
      businessRef: `student_daily:${studentId}:${attDate}`,
      version,
      title, body,
      link: `/my-attendance?date=${attDate}`,
    });
    if (out.deduped) deduped += 1; else queued += 1;
  }

  return {
    date: attDate,
    students: byStudent.size,
    queued,
    deduped,
    data_complete: confirmedComplete.size === classIds.length && classIds.length > 0,
    classes_confirmed_complete: confirmedComplete.size,
    classes_total: classIds.length,
  };
}

function renderStudentDigest(attDate, studentId, counts, complete) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const md = attDate.slice(5).replace('-', ' 月 ') + ' 日';
  const parts = [];
  for (const j of ['正常', '旷课', '迟到', '早退', '请假']) {
    if (counts[j]) parts.push(`${j} ${counts[j]} 节`);
  }
  if (counts['待处理']) parts.push(`待核实 ${counts['待处理']} 节`);

  const details = [];
  if (counts['旷课'] || counts['迟到'] || counts['早退'] || counts['待处理']) {
    const rows = Table.all('attendance', {
      where: {
        tenant_id: TENANT_ID, student_id: studentId, att_date: attDate,
        final_judgment: {op: 'in', value: ['旷课', '迟到', '早退', '待处理']},
      },
      order: [['period', 'ASC']],
      limit: 30,
    });
    for (const r of rows) {
      const label = r.final_judgment === '待处理' ? '待核实' : r.final_judgment;
      details.push(`${label}：第 ${r.period} 节《${r.course_name}》`);
    }
  }

  let body = `${md}课堂考勤：已导入 ${total} 节，${parts.join('、')}。`;
  if (details.length) body += `\n${details.join('\n')}`;
  if (!complete) body += '\n当日数据尚未齐全，结果可能更新。';
  body += '\n如有异议，请查看详情提交申诉。';

  return {title: `${md} 课堂考勤`, body};
}

/* ---------------------------------------------------------- 辅导员日报 */

export function buildCounselorDailyDigest(attDate) {
  const counselors = Table.all('role_assignment', {
    where: {tenant_id: TENANT_ID, role: 'counselor', scope_type: 'class', enabled: 1},
    limit: 2000,
  });
  const byUser = new Map();
  for (const a of counselors) {
    if (!byUser.has(a.wps_user_id)) byUser.set(a.wps_user_id, []);
    byUser.get(a.wps_user_id).push(a.scope_id);
  }

  let queued = 0;
  for (const [userId, classIds] of byUser) {
    const rows = Table.aggregate(
      `SELECT final_judgment AS j, COUNT(*) AS n FROM attendance
        WHERE tenant_id = ? AND att_date = ? AND class_id IN (${classIds.map(() => '?').join(',')})
        GROUP BY final_judgment`,
      [TENANT_ID, attDate, ...classIds],
    );
    if (!rows.length) continue;

    const counts = Object.fromEntries(rows.map((r) => [r.j, r.n]));
    const total = rows.reduce((a, r) => a + r.n, 0);
    const pendingAppeals = Table.count('appeal', {
      tenant_id: TENANT_ID, status: {op: 'in', value: ['submitted', 'reviewing']},
    });
    const unconfirmedClasses = classIds.filter((c) => {
      const cov = Table.findOne('data_coverage', {tenant_id: TENANT_ID, class_id: c, att_date: attDate});
      return !cov || cov.coverage_status !== 'complete';
    });

    const body = [
      `${attDate} 负责班级考勤汇总（${classIds.length} 个班，共 ${total} 节）`,
      `正常 ${counts['正常'] ?? 0}、旷课 ${counts['旷课'] ?? 0}、迟到 ${counts['迟到'] ?? 0}、`
      + `早退 ${counts['早退'] ?? 0}、请假 ${counts['请假'] ?? 0}、待核实 ${counts['待处理'] ?? 0}`,
      `待处理申诉：${pendingAppeals} 件`,
      unconfirmedClasses.length
        ? `数据完整性未确认的班级：${unconfirmedClasses.length} 个，统计口径为"已导入考勤"`
        : '所有负责班级当日数据已确认齐全',
    ].join('\n');

    const version = sha256(JSON.stringify(counts) + unconfirmedClasses.length).slice(0, 12);
    const out = queueNotification({
      kind: 'counselor_daily',
      receiverUserId: userId,
      businessDate: attDate,
      businessRef: `counselor_daily:${userId}:${attDate}`,
      version,
      title: `${attDate} 班级考勤日报`,
      body,
      link: `/dashboard?date=${attDate}`,
    });
    if (!out.deduped) queued += 1;
  }
  return {date: attDate, counselors: byUser.size, queued};
}

/** 日报之后的重要更正：结果变化时单独通知，带独立标识，不混入今日日报。 */
export function notifyCorrection(record, {fromJudgment, toJudgment, reason}) {
  const alreadyDigested = Table.findOne('notification', {
    tenant_id: TENANT_ID, kind: 'student_daily',
    business_ref: `student_daily:${record.student_id}:${record.att_date}`,
    status: 'sent',
  });
  if (!alreadyDigested) return {skipped: true, reason: 'DIGEST_NOT_SENT_YET'};

  return queueNotification({
    kind: 'correction',
    receiverUserId: userIdOfStudent(record.student_id),
    studentId: record.student_id,
    businessDate: record.att_date,
    businessRef: `correction:${record.attendance_id}`,
    version: String(record.business_revision),
    title: '考勤结果更正通知',
    body: `${record.att_date} 第 ${record.period} 节《${record.course_name}》`
      + `结果由「${fromJudgment}」更正为「${toJudgment}」。原因：${reason}`,
    link: `/attendance/${record.attendance_id}`,
  });
}

/** 补导历史数据的通知：带真实日期，明确标为补充通知，不混入今日日报。 */
export function notifySupplementalImport(attDate, studentIds) {
  let queued = 0;
  for (const studentId of studentIds) {
    const out = queueNotification({
      kind: 'supplemental_import',
      receiverUserId: userIdOfStudent(studentId),
      studentId,
      businessDate: attDate,
      businessRef: `supplemental:${studentId}:${attDate}`,
      version: '1',
      title: `${attDate} 考勤补充通知`,
      body: `系统补充导入了 ${attDate}（非今日）的考勤数据，请查看该日记录。`,
      link: `/my-attendance?date=${attDate}`,
    });
    if (!out.deduped) queued += 1;
  }
  return {date: attDate, queued};
}

/** 待办消息：申诉/请假审核指派。 */
export function notifyTodo({receiverUserId, instanceId, stage, title, body, link}) {
  return queueNotification({
    kind: 'review_todo',
    receiverUserId,
    businessRef: `${instanceId}:${stage}`,
    version: receiverUserId,
    title, body, link,
  });
}

export function todayBusinessDate() {
  return businessDate();
}

export function digestHour(kind) {
  return kind === 'counselor'
    ? getNumber('notify.counselor_daily_hour', 21)
    : getNumber('notify.student_daily_hour', 21);
}

function userIdOfStudent(studentId) {
  const link = Table.findOne('identity_link', {tenant_id: TENANT_ID, student_id: studentId});
  return link?.wps_user_id ?? null;
}
