// 申诉流程。对应 03 §5。
//
// 两级审核由业务服务编排两个顺序的单级轻审批实例（04 §4 优先级 C）。
// 业务服务维护唯一的下一阶段与版本，保证两个实例不会并行重复生效。
//
// 路由表（03 §5.2）：
//   普通学生申诉      → 本班有效副班长      → 授权该班的学生干部终审
//   副班长本人申诉    → 辅导员代审          → 辅导员终审，不再回到本人
//   学生干部本人申诉  → 本班副班长(非申请人) → 其他有权限干部；没有则辅导员
//   一审无人/角色失效 → 辅导员代审
//   二审无人/全自审冲突 → 辅导员代审终审
//   一审超过 7×24 小时 → 辅导员，原一审人处理权失效，旧页面提交必须拒绝

import {Table} from '../adapters/table.js';
import {Approval} from '../adapters/approval.js';
import {TENANT_ID, COLLEGE_ID} from '../config.js';
import {newId, nowUtc, addHours, parseJson} from '../lib/util.js';
import {
  Forbidden, counselorForClass, monitorsOfClass, cadresOfClass, manageableClassIds,
} from './authz.js';
import {WriteRejected, recordManualJudgment} from './writer.js';
import {getBool, getNumber} from './policy.js';
import {rebuildStatsForDates} from './stats.js';
import {queueNotification, notifyTodo} from './notify.js';
import {JUDGMENT} from './rules.js';

const ACTIVE_STATUSES = ['submitted', 'reviewing'];

/* ---------------------------------------------------------- 提交 */

export function submitAppeal(principal, {attendanceId, reason, evidenceRefs = [], onBehalfStudentId, submissionId}) {
  if (!reason?.trim()) throw new WriteRejected('VALIDATION_ERROR', '申诉理由必填');
  if (!evidenceRefs.length) throw new WriteRejected('VALIDATION_ERROR', '申诉证据必填');

  const record = Table.get('attendance', attendanceId);
  if (!record) throw new Forbidden('考勤记录不存在或无权申诉');

  // 归属校验：普通学生只能申诉自己的；辅导员代提须记载受益学生
  let studentId = principal.student_id;
  let onBehalf = false;
  if (onBehalfStudentId && onBehalfStudentId !== principal.student_id) {
    if (!principal.isCounselor) throw new Forbidden('只有辅导员可以代学生提交申诉');
    if (!manageableClassIds(principal).includes(record.class_id)) {
      throw new Forbidden('该记录不在你的负责范围内');
    }
    studentId = onBehalfStudentId;
    onBehalf = true;
  }
  if (record.student_id !== studentId) throw new Forbidden('只能申诉本人的考勤记录');

  // 公示与锁定先判：它们给出的是"该走哪条路"的具体指引，
  // 比"当前结果不可申诉"的通用提示更有用，顺序不能颠倒。
  if (record.locked_at) {
    throw new WriteRejected('LOCKED', '该记录公示已结束并锁定，只能由辅导员复核');
  }
  if (record.public_until && Date.parse(record.public_until) > Date.now()
      && getBool('appeal.no_parallel_during_public', true)) {
    throw new WriteRejected('IN_PUBLIC_PERIOD',
      '该记录正在公示期内，不再新开申诉。如有新异议，请通过"申请复核"联系辅导员');
  }

  // 可申诉结果范围
  const allowEarly = getBool('appeal.allow_early_leave', false);
  const appealable = ['旷课', '迟到', ...(allowEarly ? ['早退'] : [])];
  if (!appealable.includes(record.final_judgment)) {
    const hint = record.final_judgment === '待处理' ? '待核实记录请等待核对，或联系副班长/辅导员'
      : record.final_judgment === '早退' ? '当前配置未开放早退申诉'
        : record.final_judgment === '请假' ? '请假记录无需申诉'
          : record.final_judgment === '正常' ? '该记录已是正常，无需申诉' : '该状态不支持申诉';
    throw new WriteRejected('NOT_APPEALABLE', `「${record.final_judgment}」不在可申诉范围：${hint}`);
  }

  // 同一记录最多一张活动申诉；重复点击返回同一受理结果
  const active = Table.all('appeal', {
    where: {attendance_id: attendanceId, status: {op: 'in', value: ACTIVE_STATUSES}},
    limit: 5,
  })[0];
  if (active) return {appeal_id: active.appeal_id, duplicate: true, status: active.status, stage: active.stage};

  // approved 但尚未完成回写的也算进行中
  const pendingApply = Table.all('appeal', {
    where: {attendance_id: attendanceId, status: 'approved', apply_status: {op: '!=', value: 'applied'}},
    limit: 5,
  })[0];
  if (pendingApply) {
    return {appeal_id: pendingApply.appeal_id, duplicate: true, status: 'approved', stage: pendingApply.stage,
      note: '上一张申诉已终审通过，考勤同步中'};
  }

  const route = routeFirstStage(record, principal, studentId);
  const appealId = newId('ap');
  const ts = nowUtc();
  const deadline = addHours(ts, getNumber('appeal.first_stage_hours', 168));

  Table.insert('appeal', {
    appeal_id: appealId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
    attendance_id: attendanceId, student_id: studentId,
    applicant_user_id: principal.user_id, on_behalf: onBehalf ? 1 : 0,
    reason: reason.trim(), evidence_refs: JSON.stringify(evidenceRefs),
    requested_judgment: JUDGMENT.NORMAL,
    original_judgment: record.final_judgment,
    original_revision: record.business_revision,
    status: 'submitted', stage: route.stage,
    first_deadline: deadline,
    reviewer_scope: record.class_id,
    current_assignee: route.assignee,
    external_instance_id: null, approval_template_version: null,
    source_approval_version: 0, apply_status: 'pending',
    created_at: ts, updated_at: ts,
  });

  const instance = Approval.start({
    templateKey: route.stage === 'first' ? 'appeal_first' : 'appeal_second',
    businessType: 'appeal',
    businessId: appealId,
    applicantUserId: principal.user_id,
    assignee: route.assignee,
    stage: route.stage,
  });
  Table.updateRecord('appeal', appealId, {
    external_instance_id: instance.instance_id,
    approval_template_version: instance.template_version,
    status: 'reviewing',
    updated_at: nowUtc(),
  });
  Table.insert('appeal_step', {
    step_id: newId('st'), appeal_id: appealId, stage: route.stage,
    assignee_user_id: route.assignee, assignee_role: route.role,
    decision: null, comment: null, decided_at: null, created_at: nowUtc(),
  });

  notifyTodo({
    receiverUserId: route.assignee, instanceId: instance.instance_id, stage: route.stage,
    title: `有一条考勤申诉待${route.stage === 'first' ? '一审' : '审核'}`,
    body: `${record.name_snapshot}（${record.class_name_snapshot}）对 ${record.att_date} 第 ${record.period} 节`
      + `《${record.course_name}》的「${record.final_judgment}」提出申诉。`,
    link: `/approvals/${instance.instance_id}`,
  });

  return {
    appeal_id: appealId, instance_id: instance.instance_id,
    stage: route.stage, assignee: route.assignee, assignee_role: route.role,
    first_deadline: deadline, route_note: route.note,
  };
}

/**
 * 一审路由。防自审是硬约束：任何情况下申请人都不能成为自己的审核人。
 */
function routeFirstStage(record, principal, studentId) {
  const applicantUser = principal.user_id;
  const monitors = monitorsOfClass(record.class_id, {excludeUserId: applicantUser});

  if (monitors.length) {
    return {stage: 'first', assignee: monitors[0], role: 'monitor', note: '由本班副班长一审'};
  }
  // 副班长本人申诉，或本班无有效副班长 → 辅导员代审并作终审结论
  const counselor = counselorForClass(record.class_id);
  if (!counselor) throw new WriteRejected('NO_REVIEWER', '本班没有可用的审核人，请联系管理员配置角色');
  return {
    stage: 'counselor',
    assignee: counselor,
    role: 'counselor',
    note: monitorsOfClass(record.class_id).length
      ? '申请人本人是本班副班长，转辅导员代审并作终审结论'
      : '本班没有有效副班长，转辅导员代审',
  };
}

/* ---------------------------------------------------------- 审核 */

/**
 * 审核人做出决定。
 * 先在轻审批侧落权威决定（平台会拒绝非当前处理人、已结束实例），
 * 再由业务服务推进阶段 —— 这样"旧页面超时后提交"会在平台层就被拒。
 */
export async function decideAppeal(principal, {appealId, decision, comment, expectedRevision}) {
  const appeal = Table.get('appeal', appealId);
  if (!appeal) throw new Forbidden('申诉单不存在');
  if (!['approved', 'rejected'].includes(decision)) {
    throw new WriteRejected('VALIDATION_ERROR', '审核结论只能是通过或驳回');
  }
  if (decision === 'rejected' && !comment?.trim()) {
    throw new WriteRejected('VALIDATION_ERROR', '驳回必须填写理由');
  }
  if (!ACTIVE_STATUSES.includes(appeal.status)) {
    throw new WriteRejected('ALREADY_FINISHED', `该申诉当前状态为「${appeal.status}」，不可再操作`);
  }
  // 防自审：兜底再查一次，不依赖路由时的判断
  if (appeal.applicant_user_id === principal.user_id) {
    throw new Forbidden('不能审核自己提交的申诉');
  }
  // 一审时限：接口提交时实时检查截止时刻，不依赖后台扫描
  if (appeal.stage === 'first' && Date.parse(appeal.first_deadline) <= Date.now()) {
    await escalateOverdue(appealId, '一审已超过 7×24 小时时限');
    throw new WriteRejected('DEADLINE_PASSED',
      '一审时限已过，你的处理权已失效，该申诉已转交辅导员代审');
  }

  const platform = Approval.decide(appeal.external_instance_id, {
    actorUserId: principal.user_id, decision, comment,
  });
  if (!platform.ok) {
    const map = {
      NOT_CURRENT_ASSIGNEE: '你已不是该申诉的当前处理人，可能已被转办',
      INSTANCE_FINISHED: '该审批实例已结束，请刷新后查看最新状态',
      INSTANCE_NOT_FOUND: '审批实例不存在',
    };
    throw new Forbidden(map[platform.code] ?? '审批平台拒绝了该操作', {code: platform.code});
  }

  Table.updateRecord('appeal_step', latestStepId(appealId), {
    decision, comment: comment ?? null, decided_at: nowUtc(),
  });

  if (decision === 'rejected') {
    Table.updateRecord('appeal', appealId, {
      status: 'rejected', stage: 'done',
      source_approval_version: platform.version,
      final_at: nowUtc(), current_assignee: null, updated_at: nowUtc(),
    });
    notifyStudent(appeal, '申诉未通过', `你的申诉被驳回。理由：${comment?.trim()}。可补充证据后重新提交。`);
    return {appeal_id: appealId, status: 'rejected', stage: 'done'};
  }

  // ---- 通过：一审通过要进二审；辅导员代审即终审
  if (appeal.stage === 'first') {
    return advanceToSecondStage(appeal, principal, platform.version, comment);
  }
  return finalizeApproved(appeal, platform.version, comment, principal.user_id);
}

function advanceToSecondStage(appeal, principal, version, comment) {
  const record = Table.get('attendance', appeal.attendance_id);
  // 二审人：授权该班的学生干部，排除申请人与一审人
  let cadres = cadresOfClass(appeal.reviewer_scope, {excludeUserId: appeal.applicant_user_id})
    .filter((u) => u !== principal.user_id);

  let stage = 'second';
  let assignee = cadres[0];
  let role = 'student_cadre';
  let note = '由本班学生干部终审';

  if (!assignee) {
    stage = 'counselor';
    assignee = counselorForClass(appeal.reviewer_scope);
    role = 'counselor';
    note = '本班没有可用且无自审冲突的学生干部，转辅导员代审终审';
    if (!assignee) throw new WriteRejected('NO_REVIEWER', '没有可用的终审人');
  }

  const instance = Approval.start({
    templateKey: 'appeal_second',
    businessType: 'appeal',
    businessId: appeal.appeal_id,
    applicantUserId: appeal.applicant_user_id,
    assignee,
    stage,
  });

  Table.updateRecord('appeal', appeal.appeal_id, {
    stage, current_assignee: assignee,
    external_instance_id: instance.instance_id,
    approval_template_version: instance.template_version,
    source_approval_version: version,
    updated_at: nowUtc(),
  });
  Table.insert('appeal_step', {
    step_id: newId('st'), appeal_id: appeal.appeal_id, stage,
    assignee_user_id: assignee, assignee_role: role,
    decision: null, comment: null, decided_at: null, created_at: nowUtc(),
  });

  notifyTodo({
    receiverUserId: assignee, instanceId: instance.instance_id, stage,
    title: '有一条考勤申诉待终审',
    body: `${record.name_snapshot}（${record.class_name_snapshot}）${record.att_date} 第 ${record.period} 节`
      + `《${record.course_name}》的申诉已通过一审，请终审。`,
    link: `/approvals/${instance.instance_id}`,
  });
  notifyStudent(appeal, '申诉已通过一审', `你的申诉已通过一审，进入终审。${comment ? `一审意见：${comment}` : ''}`);

  return {appeal_id: appeal.appeal_id, status: 'reviewing', stage, assignee, route_note: note};
}

/**
 * 终审通过：更正考勤、开始公示。
 * D16：公示自**考勤实际更正生效**起算，不是终审时刻；两者都保留。
 */
async function finalizeApproved(appeal, version, comment, operatorUserId) {
  const record = Table.get('attendance', appeal.attendance_id);
  if (!record) throw new WriteRejected('NOT_FOUND', '考勤记录不存在');

  // 二审重新检查当前版本与已生效请假，发现目标记录已变更则进入复核
  if (record.business_revision !== appeal.original_revision) {
    Table.updateRecord('appeal', appeal.appeal_id, {
      status: 'approved', stage: 'done', apply_status: 'failed',
      source_approval_version: version, final_at: nowUtc(),
      current_assignee: null, updated_at: nowUtc(),
    });
    Table.updateRecord('attendance', appeal.attendance_id, {
      needs_review: 1,
      review_reason: `申诉 ${appeal.appeal_id} 终审通过，但记录在申诉期间已被更新`
        + `（申诉时版本 ${appeal.original_revision}，当前 ${record.business_revision}），需辅导员确认后更正`,
      updated_at: nowUtc(),
    });
    notifyStudent(appeal, '申诉已通过，待辅导员确认',
      '你的申诉已终审通过，但该记录在此期间发生过变更，正由辅导员复核确认后更正。');
    return {appeal_id: appeal.appeal_id, status: 'approved', stage: 'done',
      apply_status: 'failed', reason: 'CONCURRENT_CHANGE_NEEDS_REVIEW'};
  }

  Table.updateRecord('appeal', appeal.appeal_id, {
    status: 'approved', stage: 'done',
    source_approval_version: version,
    final_at: nowUtc(),            // 保留轻审批终审时间
    apply_status: 'applying',
    current_assignee: null,
    updated_at: nowUtc(),
  });

  const publicDays = getNumber('appeal.public_days', 7);
  let result;
  try {
    result = await recordManualJudgment(appeal.attendance_id, {
      toJudgment: JUDGMENT.NORMAL,
      action: 'appeal_apply',
      reason: `申诉 ${appeal.appeal_id} 终审通过${comment ? `：${comment}` : ''}`,
      operatorUserId,
      evidenceRefs: parseJson(appeal.evidence_refs, []),
      relatedRequestId: appeal.appeal_id,
      eventId: `appeal_apply:${appeal.appeal_id}:${version}`,
    });
  } catch (err) {
    Table.updateRecord('appeal', appeal.appeal_id, {apply_status: 'failed', updated_at: nowUtc()});
    notifyStudent(appeal, '申诉已通过，考勤同步异常',
      '你的申诉已终审通过，但考勤更正尚未生效，系统正在重试。');
    return {appeal_id: appeal.appeal_id, status: 'approved', apply_status: 'failed', error: err.code};
  }

  // 公示自实际生效时点起算
  const effectiveAt = nowUtc();
  const publicUntil = addHours(effectiveAt, publicDays * 24);
  Table.updateRecord('attendance', appeal.attendance_id, {
    public_until: publicUntil, last_appeal_id: appeal.appeal_id, updated_at: nowUtc(),
  });
  Table.updateRecord('appeal', appeal.appeal_id, {
    apply_status: 'applied', public_until: publicUntil, updated_at: nowUtc(),
  });

  rebuildStatsForDates([record.att_date]);
  notifyStudent(appeal, '申诉成立',
    `你的申诉已终审通过，${record.att_date} 第 ${record.period} 节《${record.course_name}》`
    + `已更正为「正常」，公示至 ${publicUntil.slice(0, 10)}。`);

  return {
    appeal_id: appeal.appeal_id, status: 'approved', stage: 'done',
    apply_status: 'applied',
    final_at: appeal.final_at, effective_at: effectiveAt, public_until: publicUntil,
    note: '公示期自考勤实际更正生效时起算，审批终审时间单独保留',
    applied: result.applied,
  };
}

/* ---------------------------------------------------------- 撤回与超时 */

/** 学生撤回。只允许未终审生效的申请；必须同步作废审批实例。 */
export function withdrawAppeal(principal, appealId, reason) {
  const appeal = Table.get('appeal', appealId);
  if (!appeal) throw new Forbidden('申诉单不存在');
  if (appeal.applicant_user_id !== principal.user_id) throw new Forbidden('只能撤回自己提交的申诉');
  if (!ACTIVE_STATUSES.includes(appeal.status)) {
    throw new WriteRejected('ALREADY_FINISHED',
      '该申诉已终审，终审通过后不能以撤回还原结果');
  }

  const cancelled = Approval.cancel(appeal.external_instance_id, reason ?? '申请人撤回');
  if (!cancelled.ok) {
    // 平台无法可靠取消：先停止后续业务生效并转人工，不显示"已完成取消"
    Table.updateRecord('appeal', appealId, {
      status: 'withdrawn', stage: 'done', current_assignee: null,
      updated_at: nowUtc(),
    });
    return {
      appeal_id: appealId, status: 'withdrawn',
      approval_instance_cancelled: false,
      warning: '业务侧已停止后续生效，但审批平台实例未能可靠取消，已转人工处理该实例',
    };
  }

  Table.updateRecord('appeal', appealId, {
    status: 'withdrawn', stage: 'done', current_assignee: null,
    final_at: nowUtc(), updated_at: nowUtc(),
  });
  return {appeal_id: appealId, status: 'withdrawn', approval_instance_cancelled: true};
}

/** 一审超时转办。原一审人处理权失效，旧页面再提交会被平台拒绝。 */
export async function escalateOverdue(appealId, reason) {
  const appeal = Table.get('appeal', appealId);
  if (!appeal || appeal.stage !== 'first' || !ACTIVE_STATUSES.includes(appeal.status)) {
    return {escalated: false, reason: 'NOT_APPLICABLE'};
  }
  const counselor = counselorForClass(appeal.reviewer_scope);
  if (!counselor) return {escalated: false, reason: 'NO_COUNSELOR'};

  const routed = Approval.changeRoute(appeal.external_instance_id, {
    newAssignee: counselor, reason,
  });
  if (!routed.ok) return {escalated: false, reason: routed.code};

  Table.updateRecord('appeal', appealId, {
    stage: 'counselor', current_assignee: counselor, updated_at: nowUtc(),
  });
  Table.updateRecord('appeal_step', latestStepId(appealId), {
    decision: 'timeout', comment: reason, decided_at: nowUtc(),
  });
  Table.insert('appeal_step', {
    step_id: newId('st'), appeal_id: appealId, stage: 'counselor',
    assignee_user_id: counselor, assignee_role: 'counselor',
    decision: null, comment: null, decided_at: null, created_at: nowUtc(),
  });

  notifyTodo({
    receiverUserId: counselor, instanceId: appeal.external_instance_id, stage: 'counselor',
    title: '有一条申诉一审超时待你代审',
    body: `申诉 ${appealId} 一审超过时限，已转你代审。`,
    link: `/approvals/${appeal.external_instance_id}`,
  });

  return {
    escalated: true, assignee: counselor,
    old_task_invalidated: routed.old_task_invalidated,
  };
}

/** 定时巡检：一审超时转办 + 公示到期锁定。 */
export async function scanDeadlines() {
  const now = nowUtc();
  const overdue = Table.all('appeal', {
    where: {
      tenant_id: TENANT_ID, stage: 'first',
      status: {op: 'in', value: ACTIVE_STATUSES},
      first_deadline: {op: '<=', value: now},
    },
    limit: 500,
  });
  const escalated = [];
  for (const a of overdue) {
    const out = await escalateOverdue(a.appeal_id, '一审超过 7×24 小时时限，自动转辅导员代审');
    if (out.escalated) escalated.push(a.appeal_id);
  }

  // 公示到期 -> 锁定。锁定后只能辅导员复核。
  const expiring = Table.all('attendance', {
    where: {tenant_id: TENANT_ID, public_until: {op: '<=', value: now}, locked_at: null},
    limit: 500,
  });
  const locked = [];
  for (const r of expiring) {
    Table.updateRecord('attendance', r.attendance_id, {
      locked_at: nowUtc(), updated_at: nowUtc(),
    }, {expectedRevision: r.business_revision});
    if (r.last_appeal_id) {
      Table.updateRecord('appeal', r.last_appeal_id, {
        status: 'locked', locked_at: nowUtc(), updated_at: nowUtc(),
      });
    }
    locked.push(r.attendance_id);
  }

  // 二审逾期提醒（无硬性期限，只提醒）
  const reminderHours = getNumber('appeal.second_stage_reminder_hours', 168);
  const stale = Table.all('appeal', {
    where: {
      tenant_id: TENANT_ID, stage: 'second', status: 'reviewing',
      updated_at: {op: '<=', value: addHours(now, -reminderHours)},
    },
    limit: 200,
  });
  for (const a of stale) {
    notifyTodo({
      receiverUserId: a.current_assignee, instanceId: a.external_instance_id, stage: 'second_reminder',
      title: '有一条申诉终审已逾期', body: `申诉 ${a.appeal_id} 终审已超过提醒阈值，请尽快处理。`,
      link: `/approvals/${a.external_instance_id}`,
    });
  }

  return {escalated: escalated.length, locked: locked.length, reminded: stale.length};
}

/* ---------------------------------------------------------- 查询 */

export function listMyAppeals(principal, {limit = 50} = {}) {
  const rows = Table.all('appeal', {
    where: {tenant_id: TENANT_ID, applicant_user_id: principal.user_id},
    order: [['created_at', 'DESC']], limit,
  });
  return rows.map((a) => toAppealView(a, principal));
}

/** 待我审核的申诉。范围由服务端算，不接受前端传入的 assignee。 */
export function listAppealTodos(principal, {limit = 50} = {}) {
  const rows = Table.all('appeal', {
    where: {
      tenant_id: TENANT_ID,
      current_assignee: principal.user_id,
      status: {op: 'in', value: ACTIVE_STATUSES},
    },
    order: [['first_deadline', 'ASC']], limit,
  }).filter((a) => a.applicant_user_id !== principal.user_id);   // 防自审兜底

  return rows.map((a) => {
    const record = Table.get('attendance', a.attendance_id);
    const overdue = a.stage === 'first' && Date.parse(a.first_deadline) <= Date.now();
    return {
      ...toAppealView(a, principal),
      overdue,
      overdue_note: overdue ? '一审时限已过，你的处理权已失效，提交将被拒绝' : null,
      attendance: record && {
        name: record.name_snapshot, student_no: record.student_no_snapshot,
        class_name: record.class_name_snapshot, course_name: record.course_name,
        att_date: record.att_date, period: record.period,
        final_judgment: record.final_judgment,
        raw_result: record.raw_result, raw_way: record.raw_way,
        sign_time: record.sign_time,
        business_revision: record.business_revision,
        // 已请假提示：审核人需要知道该记录是否已被请假覆盖
        has_active_leave: parseJson(record.leave_ids, []).length > 0,
      },
    };
  });
}

export function getAppeal(principal, appealId) {
  const appeal = Table.get('appeal', appealId);
  if (!appeal) throw new Forbidden('申诉单不存在');
  const record = Table.get('attendance', appeal.attendance_id);
  const isMine = appeal.applicant_user_id === principal.user_id || appeal.student_id === principal.student_id;
  const isReviewer = appeal.current_assignee === principal.user_id;
  const inScope = record && manageableClassIds(principal).includes(record.class_id);
  if (!isMine && !isReviewer && !inScope) throw new Forbidden('无权查看该申诉');

  const steps = Table.all('appeal_step', {where: {appeal_id: appealId}, order: [['created_at', 'ASC']], limit: 50});
  return {
    ...toAppealView(appeal, principal),
    reason: appeal.reason,
    evidence_refs: (isMine || isReviewer || principal.isCounselor) ? parseJson(appeal.evidence_refs, []) : [],
    steps: steps.map((s) => ({
      stage: s.stage, assignee_role: s.assignee_role,
      decision: s.decision, comment: s.comment,
      decided_at: s.decided_at, created_at: s.created_at,
    })),
    attendance: record && {
      attendance_id: record.attendance_id,
      att_date: record.att_date, period: record.period, course_name: record.course_name,
      final_judgment: record.final_judgment, business_revision: record.business_revision,
    },
  };
}

function toAppealView(a, principal) {
  const statusLabels = {
    submitted: '已提交，待一审',
    reviewing: a.stage === 'first' ? '待一审' : (a.stage === 'second' ? '一审通过，待终审' : '待辅导员代审'),
    approved: a.apply_status === 'applied'
      ? (a.locked_at ? '已成立，公示结束已锁定' : '已成立，公示中')
      : (a.apply_status === 'failed' ? '终审通过，考勤同步异常' : '终审通过，同步中'),
    rejected: '已驳回',
    withdrawn: '已撤回',
    locked: '公示结束，已锁定',
  };
  return {
    appeal_id: a.appeal_id,
    attendance_id: a.attendance_id,
    status: a.status,
    stage: a.stage,
    status_label: statusLabels[a.status] ?? a.status,
    // 审批状态与考勤更正状态分开：终审通过 ≠ 已生效
    approval_status: a.status,
    apply_status: a.apply_status,
    attendance_corrected: a.status === 'approved' && a.apply_status === 'applied',
    original_judgment: a.original_judgment,
    requested_judgment: a.requested_judgment,
    first_deadline: a.first_deadline,
    final_at: a.final_at,
    public_until: a.public_until,
    public_countdown_days: a.public_until
      ? Math.max(0, Math.ceil((Date.parse(a.public_until) - Date.now()) / 86400000))
      : null,
    locked_at: a.locked_at,
    is_mine: a.applicant_user_id === principal.user_id,
    created_at: a.created_at,
  };
}

function latestStepId(appealId) {
  const steps = Table.all('appeal_step', {
    where: {appeal_id: appealId}, order: [['created_at', 'DESC']], limit: 1,
  });
  return steps[0]?.step_id;
}

function notifyStudent(appeal, title, body) {
  const link = Table.findOne('identity_link', {tenant_id: TENANT_ID, student_id: appeal.student_id});
  queueNotification({
    kind: 'appeal_result',
    receiverUserId: link?.wps_user_id ?? null,
    studentId: appeal.student_id,
    businessRef: `appeal_result:${appeal.appeal_id}`,
    version: `${appeal.status}:${appeal.stage}:${nowUtc().slice(0, 16)}`,
    title, body,
    link: `/my-applications/${appeal.appeal_id}`,
  });
}
