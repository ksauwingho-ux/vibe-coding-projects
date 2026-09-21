// 待处理核对。对应 03 §3。
//
// 关键约束：
//   · 触发条件是基础判定为"待处理"，界面显示"待核实"；
//   · 副班长/学生干部只核对授权班级，辅导员可处理全院；
//   · 防自审（D18）：本人记录一律不能自核对，转其他授权人或辅导员；
//   · 必须填写说明；
//   · 提交时校验记录版本，已被别人处理则拒绝并提示刷新；
//   · 批量核对必须逐条执行权限与本人排除，不能一键把全部空方式判正常。

import {Table} from '../adapters/table.js';
import {TENANT_ID, RUNTIME} from '../config.js';
import {nowUtc} from '../lib/util.js';
import {manageableClassIds, canVerifyAttendance, counselorForClass, Forbidden} from './authz.js';
import {recordManualJudgment, WriteRejected} from './writer.js';
import {JUDGMENT} from './rules.js';
import {rebuildStatsForDates} from './stats.js';
import {queueNotification} from './notify.js';

/** 本班（或授权范围）待核对队列。默认排除本人记录并说明原因。 */
export function listVerificationQueue(principal, {classId, cursor, limit} = {}) {
  const manageable = manageableClassIds(principal);
  if (!manageable.length) {
    return {items: [], has_more: false, next_cursor: null, scope_classes: []};
  }
  const targetClasses = classId ? [classId] : manageable;
  if (classId && !manageable.includes(classId)) {
    throw new Forbidden('无权查看该班级待核对队列', {class_id: classId});
  }

  const page = Table.query('attendance', {
    where: {
      tenant_id: TENANT_ID,
      class_id: {op: 'in', value: targetClasses},
      final_judgment: JUDGMENT.PENDING,
    },
    order: [['att_date', 'DESC'], ['period', 'ASC'], ['attendance_id', 'ASC']],
    cursor: cursor ?? null,
    limit: Math.min(Number(limit) || RUNTIME.queryPageLimit, RUNTIME.queryMaxLimit),
  });

  const items = page.records.map((r) => {
    const verdict = canVerifyAttendance(principal, r);
    return {
      attendance_id: r.attendance_id,
      student_no: r.student_no_snapshot,
      name: r.name_snapshot,
      class_name: r.class_name_snapshot,
      course_name: r.course_name,
      att_date: r.att_date,
      period: r.period,
      raw_result: r.raw_result,
      raw_way: r.raw_way || null,
      sign_time: r.sign_time,
      pending_reason: r.judgment_reason,
      business_revision: r.business_revision,
      can_verify: verdict.ok,
      blocked_reason: verdict.ok ? null : (
        verdict.reason === 'SELF_REVIEW_FORBIDDEN'
          ? '这是你本人的记录，须由其他授权审核人或辅导员处理'
          : '不在你的授权班级范围内'
      ),
      escalate_to: verdict.reason === 'SELF_REVIEW_FORBIDDEN' ? counselorForClass(r.class_id) : null,
    };
  });

  return {
    items, has_more: page.has_more, next_cursor: page.next_cursor,
    scope_classes: targetClasses,
    updated_at: nowUtc(),
  };
}

/**
 * 核对一条记录。
 * @param {'confirm_present'|'confirm_absent'} action
 */
export async function verifyOne(principal, {attendanceId, action, note, evidenceRefs = [], expectedRevision, idempotencyKey}) {
  if (!note || !String(note).trim()) {
    throw new WriteRejected('VALIDATION_ERROR', '核对说明必填');
  }
  if (!['confirm_present', 'confirm_absent'].includes(action)) {
    throw new WriteRejected('VALIDATION_ERROR', '未知的核对动作');
  }

  const record = Table.get('attendance', attendanceId);
  if (!record) throw new Forbidden('考勤记录不存在或无权处理');

  const verdict = canVerifyAttendance(principal, record);
  if (!verdict.ok) {
    if (verdict.reason === 'SELF_REVIEW_FORBIDDEN') {
      throw new Forbidden('不能核对本人记录，请转交其他授权审核人或辅导员', {
        escalate_to: counselorForClass(record.class_id),
      });
    }
    throw new Forbidden('不在你的授权班级范围内', {class_id: record.class_id});
  }
  if (record.final_judgment !== JUDGMENT.PENDING) {
    throw new WriteRejected('ALREADY_HANDLED',
      `该记录当前结果为「${record.final_judgment}」，已不在待核实状态，请刷新`);
  }

  const toJudgment = action === 'confirm_present' ? JUDGMENT.NORMAL : JUDGMENT.ABSENT;
  const result = await recordManualJudgment(attendanceId, {
    toJudgment,
    action: 'pending_confirm',
    reason: `${action === 'confirm_present' ? '核对确认到场' : '核对确认缺勤'}：${String(note).trim()}`,
    operatorUserId: principal.user_id,
    evidenceRefs,
    expectedRevision,
    eventId: idempotencyKey ? `verify:${idempotencyKey}` : undefined,
  });

  if (result.applied) {
    rebuildStatsForDates([record.att_date]);
    queueNotification({
      kind: 'verification_result',
      receiverUserId: userIdOfStudent(record.student_id),
      studentId: record.student_id,
      businessDate: record.att_date,
      businessRef: attendanceId,
      version: String(result.revision),
      title: '你的一条待核实考勤已处理',
      body: `${record.att_date} 第${record.period}节《${record.course_name}》`
        + `核对结果：${toJudgment}。如有异议可在详情页提交申诉。`,
      link: `/attendance/${attendanceId}`,
    });
  }
  return result;
}

/** 批量核对：逐条执行权限与防自审，任何一条不合规只跳过该条并说明。 */
export async function verifyBatch(principal, {items = [], note}) {
  const results = [];
  const dates = new Set();
  for (const item of items) {
    try {
      const out = await verifyOne(principal, {...item, note: item.note ?? note});
      const record = Table.get('attendance', item.attendanceId);
      if (record) dates.add(record.att_date);
      results.push({attendance_id: item.attendanceId, ok: true, applied: out.applied});
    } catch (err) {
      results.push({
        attendance_id: item.attendanceId, ok: false,
        code: err.code ?? 'ERROR', message: err.message, detail: err.detail,
      });
    }
  }
  if (dates.size) rebuildStatsForDates([...dates]);
  return {
    total: items.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/** 辅导员复核队列：来源更正冲突、锁定后变动、人工结论与请假冲突。 */
export function listCounselorReviewQueue(principal, {cursor, limit} = {}) {
  if (!principal.isCounselor) throw new Forbidden('仅辅导员可处理复核任务');
  const classes = manageableClassIds(principal);
  if (!classes.length) return {items: [], has_more: false, next_cursor: null};

  const page = Table.query('attendance', {
    where: {tenant_id: TENANT_ID, class_id: {op: 'in', value: classes}, needs_review: 1},
    order: [['updated_at', 'DESC'], ['attendance_id', 'ASC']],
    cursor: cursor ?? null,
    limit: Math.min(Number(limit) || RUNTIME.queryPageLimit, RUNTIME.queryMaxLimit),
  });
  return {
    items: page.records.map((r) => ({
      attendance_id: r.attendance_id,
      name: r.name_snapshot, student_no: r.student_no_snapshot,
      class_name: r.class_name_snapshot, course_name: r.course_name,
      att_date: r.att_date, period: r.period,
      final_judgment: r.final_judgment,
      review_reason: r.review_reason,
      locked_at: r.locked_at,
      business_revision: r.business_revision,
    })),
    has_more: page.has_more, next_cursor: page.next_cursor,
  };
}

/** 辅导员复核处理：可改判（含锁定记录），必须填理由并留事件。 */
export async function resolveCounselorReview(principal, {attendanceId, decision, toJudgment, reason, expectedRevision}) {
  if (!principal.isCounselor) throw new Forbidden('仅辅导员可处理复核任务');
  if (!reason?.trim()) throw new WriteRejected('VALIDATION_ERROR', '复核理由必填');
  const record = Table.get('attendance', attendanceId);
  if (!record) throw new Forbidden('考勤记录不存在');
  if (!manageableClassIds(principal).includes(record.class_id)) {
    throw new Forbidden('不在你的负责范围内');
  }

  if (decision === 'keep') {
    // 维持原判：清掉复核标记，但保留事件历史
    Table.updateRecord('attendance', attendanceId, {
      needs_review: 0, review_reason: null, updated_at: nowUtc(),
    });
    Table.insert('review_event', {
      event_id: `rev_keep_${attendanceId}_${Date.now()}`, tenant_id: TENANT_ID,
      attendance_id: attendanceId, action: 'counselor_review',
      from_judgment: record.final_judgment, to_judgment: record.final_judgment,
      before_revision: record.business_revision, after_revision: record.business_revision,
      reason: `复核维持原判：${reason.trim()}`, evidence_refs: '[]',
      operator_user_id: principal.user_id, related_request_id: null,
      active: 0, created_at: nowUtc(),
    });
    return {applied: false, reason: 'KEPT', record};
  }

  const result = await recordManualJudgment(attendanceId, {
    toJudgment,
    action: 'counselor_review',
    reason: `辅导员复核改判：${reason.trim()}`,
    operatorUserId: principal.user_id,
    expectedRevision,
  });
  if (result.applied) rebuildStatsForDates([record.att_date]);
  return result;
}

function userIdOfStudent(studentId) {
  const link = Table.findOne('identity_link', {tenant_id: TENANT_ID, student_id: studentId});
  return link?.wps_user_id ?? null;
}
