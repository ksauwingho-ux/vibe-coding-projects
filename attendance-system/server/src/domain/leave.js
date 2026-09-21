// 请假流程。对应 03 §4。
//
// 分工：轻审批是审批过程的权威来源，业务台账保存结果投影。
// 因此本模块**只**做三件事：受理申请、把权威审批结果投影到台账、按结果重算考勤。
// 任何地方都不允许把 approval_status 直接手工改成 approved 来触发生效。
//
// 状态分离（AT 要求）：
//   approval_status  审批过程状态（权威来自轻审批）
//   apply_status     考勤回写状态（pending/applying/applied/failed）
// 审批通过但回写失败时，页面显示"审批通过，考勤同步异常"，绝不显示"全部完成"。

import {Table} from '../adapters/table.js';
import {Approval} from '../adapters/approval.js';
import {Form} from '../adapters/form.js';
import {Scheduler} from '../adapters/scheduler.js';
import {TENANT_ID, COLLEGE_ID} from '../config.js';
import {newId, nowUtc, parseJson, isValidDate} from '../lib/util.js';
import {Forbidden, counselorForClass, manageableClassIds} from './authz.js';
import {WriteRejected, recomputeForRecords} from './writer.js';
import {invalidateLeaveIndex, attendanceCoveredByLeave} from './leave-index.js';
import {rebuildStatsForDates} from './stats.js';
import {getBool} from './policy.js';
import {queueNotification, notifyTodo} from './notify.js';

const LEAVE_TYPES = ['public', 'sick', 'personal', 'other'];

/**
 * 提交请假。
 * 身份从登录态取，姓名/学号/班级只读 —— 表单里手填的身份一律忽略。
 */
export function submitLeave(principal, input) {
  const {
    leaveType, startDate, endDate, periods = [], reason,
    evidenceRefs = [], memberStudentIds, submissionId,
  } = input;

  if (!LEAVE_TYPES.includes(leaveType)) throw new WriteRejected('VALIDATION_ERROR', '请假类型不合法');
  if (!isValidDate(startDate) || !isValidDate(endDate)) throw new WriteRejected('VALIDATION_ERROR', '日期格式不合法');
  if (endDate < startDate) throw new WriteRejected('VALIDATION_ERROR', '结束日期不能早于开始日期');
  if (!reason?.trim()) throw new WriteRejected('VALIDATION_ERROR', '请假事由必填');

  const normPeriods = [...new Set(periods.map(Number))].filter((p) => Number.isInteger(p) && p >= 1 && p <= 12).sort((a, b) => a - b);
  if (periods.length && normPeriods.length !== [...new Set(periods.map(Number))].length) {
    throw new WriteRejected('VALIDATION_ERROR', '节次必须是 1—12 的整数');
  }
  // 病假必传附件
  if (leaveType === 'sick' && !evidenceRefs.length) {
    throw new WriteRejected('VALIDATION_ERROR', '病假必须上传证明材料');
  }

  // ---- 受益学生的确定与权限
  const onBehalf = Array.isArray(memberStudentIds) && memberStudentIds.length > 0;
  let studentIds;
  if (!onBehalf) {
    if (!principal.student_id) throw new Forbidden('当前账号未关联学生身份，无法为本人请假');
    if (!getBool('leave.normal_student_can_apply_single', true)
        && !principal.isCounselor && !principal.roles.has('student_cadre')) {
      throw new Forbidden('当前配置不允许普通学生自助请假');
    }
    studentIds = [principal.student_id];
  } else {
    // 多人公假：仅学生干部与辅导员可发起，且人员限制在授权范围内
    const canBatch = principal.isCounselor || principal.roles.has('student_cadre');
    if (!canBatch) throw new Forbidden('只有学生干部或辅导员可以发起多人公假');
    const scope = manageableClassIds(principal);
    const students = Table.all('student_profile', {
      where: {tenant_id: TENANT_ID, student_id: {op: 'in', value: memberStudentIds}},
      limit: 1000,
    });
    if (students.length !== memberStudentIds.length) {
      throw new WriteRejected('VALIDATION_ERROR', '存在无效的学生 ID');
    }
    const outOfScope = students.filter((s) => !scope.includes(s.current_class_id));
    if (outOfScope.length) {
      throw new Forbidden('名单中包含你无权发起的学生', {
        out_of_scope: outOfScope.map((s) => ({student_id: s.student_id, name: s.name})),
      });
    }
    studentIds = students.map((s) => s.student_id);
  }

  // ---- 跨辅导员范围检查（D22）：一单默认只含同一负责辅导员的学生
  const members = Table.all('student_profile', {
    where: {tenant_id: TENANT_ID, student_id: {op: 'in', value: studentIds}},
    limit: 1000,
  });
  const counselorGroups = new Map();
  for (const s of members) {
    const c = counselorForClass(s.current_class_id);
    if (!counselorGroups.has(c)) counselorGroups.set(c, []);
    counselorGroups.get(c).push(s);
  }
  if (counselorGroups.size > 1 && getBool('leave.cross_counselor_requires_split', true)) {
    throw new WriteRejected('SPLIT_REQUIRED',
      '名单跨越多名负责辅导员，请按辅导员拆成多张单提交', {
        groups: [...counselorGroups.entries()].map(([c, list]) => ({
          counselor_user_id: c,
          students: list.map((s) => ({student_id: s.student_id, name: s.name, class_id: s.current_class_id})),
        })),
      });
  }
  const approverUserId = [...counselorGroups.keys()][0];
  if (!approverUserId) throw new WriteRejected('NO_APPROVER', '未找到负责辅导员，无法提交');

  // ---- 表单幂等：同一 submission 重复提交返回已有单号
  const accepted = Form.acceptSubmission({
    formKey: 'leave_apply',
    submitterUserId: principal.user_id,
    submissionId,
    businessTable: 'leave_request',
  });
  if (accepted.existing) {
    return {leave_id: accepted.existing.leave_id, duplicate_submission: true};
  }

  const leaveId = newId('lv');
  const ts = nowUtc();
  Table.insert('leave_request', {
    leave_id: leaveId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
    applicant_user_id: principal.user_id, on_behalf: onBehalf ? 1 : 0,
    leave_type: leaveType, start_date: startDate, end_date: endDate,
    periods: JSON.stringify(normPeriods), reason: reason.trim(),
    evidence_refs: JSON.stringify(evidenceRefs),
    external_instance_id: null, approval_template_version: null,
    approval_status: 'submitted', approval_version: 0, apply_status: 'pending',
    revoke_status: 'none', submission_id: accepted.submission_id,
    created_at: ts, updated_at: ts,
  });

  for (const s of members) {
    Table.insert('leave_member', {
      member_id: newId('lm'), tenant_id: TENANT_ID, leave_id: leaveId,
      student_id: s.student_id, student_no_snapshot: s.student_no,
      class_id_snapshot: s.current_class_id, apply_status: 'pending', affected_record_count: 0,
    });
  }

  // ---- 发起轻审批
  const instance = Approval.start({
    templateKey: 'leave',
    businessType: 'leave',
    businessId: leaveId,
    applicantUserId: principal.user_id,
    assignee: approverUserId,
    stage: 'counselor',
  });
  Table.updateRecord('leave_request', leaveId, {
    external_instance_id: instance.instance_id,
    approval_template_version: instance.template_version,
    updated_at: nowUtc(),
  });

  notifyTodo({
    receiverUserId: approverUserId,
    instanceId: instance.instance_id,
    stage: 'counselor',
    title: '有一条请假待审批',
    body: `${principal.display_name} 提交${onBehalf ? `多人公假（${members.length} 人）` : '请假'}：`
      + `${startDate} 至 ${endDate}${normPeriods.length ? ` 第 ${normPeriods.join('、')} 节` : '（全天）'}`,
    link: `/approvals/${instance.instance_id}`,
  });

  return {
    leave_id: leaveId,
    instance_id: instance.instance_id,
    members: members.length,
    approver_user_id: approverUserId,
  };
}

/**
 * 投影一条请假审批结果并回写考勤。由任务处理器调用，不由前端直接调用。
 * 事件重复/乱序在此拦截：只接受比已记录版本更新的权威状态。
 */
export async function projectLeaveApproval(leaveId, {eventId, sourceVersion} = {}) {
  const leave = Table.get('leave_request', leaveId);
  if (!leave) throw new WriteRejected('NOT_FOUND', '请假单不存在');
  if (!leave.external_instance_id) throw new WriteRejected('NO_INSTANCE', '请假单尚未发起审批');

  // 不信任事件内容，回查权威状态
  const state = Approval.fetchState(leave.external_instance_id);
  if (!state) throw new WriteRejected('INSTANCE_NOT_FOUND', '审批实例不存在');

  // 乱序/重复：版本不前进就不处理
  if (state.version <= leave.approval_version) {
    return {applied: false, reason: 'STALE_OR_DUPLICATE', version: state.version, recorded: leave.approval_version};
  }

  recordApprovalEvent({eventId, leaveId, instanceId: leave.external_instance_id, sourceVersion: state.version, state: state.state});

  if (state.state === 'running') {
    Table.updateRecord('leave_request', leaveId, {approval_version: state.version, updated_at: nowUtc()});
    return {applied: false, reason: 'STILL_RUNNING'};
  }

  if (state.state === 'rejected' || state.state === 'cancelled') {
    Table.updateRecord('leave_request', leaveId, {
      approval_status: state.state === 'rejected' ? 'rejected' : 'cancelled',
      approval_version: state.version, updated_at: nowUtc(),
    });
    notifyMembers(leave, state.state === 'rejected' ? '请假申请未通过' : '请假申请已作废',
      `${leave.start_date} 至 ${leave.end_date} 的请假申请${state.state === 'rejected' ? '被驳回' : '已作废'}。`);
    return {applied: true, state: state.state};
  }

  // ---- 批准：先记录批准事实，再回写考勤。回写失败不影响批准事实。
  Table.updateRecord('leave_request', leaveId, {
    approval_status: 'approved',
    approval_version: state.version,
    approver_user_id: state.current_assignee ?? null,
    approved_at: nowUtc(),
    apply_status: 'applying',
    updated_at: nowUtc(),
  });
  invalidateLeaveIndex();

  return applyLeaveToAttendance(leaveId, {eventId: eventId ?? `leave_approved:${leaveId}:${state.version}`});
}

/** 把已批准请假应用到考勤。逐人生效，部分失败不能标为全部已应用。 */
export async function applyLeaveToAttendance(leaveId, {eventId}) {
  const leave = Table.get('leave_request', leaveId);
  const members = Table.all('leave_member', {where: {leave_id: leaveId}, limit: 1000});
  const dates = new Set();
  let anyFailed = false;
  let totalApplied = 0;

  for (const member of members) {
    const records = attendanceCoveredByLeave(
      {...leave, periods: leave.periods}, [member.student_id],
    );
    const result = await recomputeForRecords(records, {
      action: 'leave_apply',
      reason: `已批准请假 ${leaveId} 生效`,
      operatorUserId: 'system:leave',
      relatedRequestId: leaveId,
      eventPrefix: `${eventId}:${member.student_id}`,
    });
    records.forEach((r) => dates.add(r.att_date));
    totalApplied += result.applied;

    const failed = result.failed > 0;
    if (failed) anyFailed = true;
    Table.updateRecord('leave_member', member.member_id, {
      apply_status: failed ? 'failed' : 'applied',
      affected_record_count: result.applied,
      last_error: failed ? JSON.stringify(result.details.filter((d) => d.error).slice(0, 3)) : null,
    });
  }

  Table.updateRecord('leave_request', leaveId, {
    apply_status: anyFailed ? 'failed' : 'applied',
    updated_at: nowUtc(),
  });

  if (dates.size) rebuildStatsForDates([...dates]);

  if (anyFailed) {
    // 回写失败：保留批准事实，创建重试任务。绝不重发一张新的请假单。
    Scheduler.enqueue({
      idempotencyKey: `leave_retry:${leaveId}:${Date.now()}`,
      entityType: 'leave_request', entityId: leaveId,
      eventType: 'leave_apply_retry', payload: {leaveId},
    });
  }

  notifyMembers(leave, '请假申请已通过',
    `${leave.start_date} 至 ${leave.end_date} 的请假已批准`
    + (anyFailed ? '，考勤同步异常，系统正在重试。' : `，已更新 ${totalApplied} 条考勤记录。`));

  return {
    applied: true, state: 'approved',
    attendance_updated: totalApplied,
    apply_status: anyFailed ? 'failed' : 'applied',
    members_applied: members.filter((m) => Table.get('leave_member', m.member_id).apply_status === 'applied').length,
    members_failed: members.filter((m) => Table.get('leave_member', m.member_id).apply_status === 'failed').length,
  };
}

/* ---------------------------------------------------------- 撤销 */

/** 学生申请撤销。撤销待确认期间，原请假**仍然有效**。 */
export function requestRevoke(principal, leaveId, reason) {
  const leave = Table.get('leave_request', leaveId);
  if (!leave) throw new WriteRejected('NOT_FOUND', '请假单不存在');
  if (leave.approval_status !== 'approved') {
    throw new WriteRejected('VALIDATION_ERROR', '只有已批准的请假才需要撤销流程');
  }
  const members = Table.all('leave_member', {where: {leave_id: leaveId}, limit: 1000});
  const isMember = members.some((m) => m.student_id === principal.student_id);
  if (!isMember && leave.applicant_user_id !== principal.user_id && !principal.isCounselor) {
    throw new Forbidden('无权撤销该请假单');
  }
  if (leave.revoke_status === 'requested') {
    return {leave_id: leaveId, revoke_status: 'requested', duplicate: true};
  }

  const classId = members[0]?.class_id_snapshot;
  const approver = counselorForClass(classId);
  const instance = Approval.start({
    templateKey: 'leave_revoke',
    businessType: 'leave_revoke',
    businessId: leaveId,
    applicantUserId: principal.user_id,
    assignee: approver,
    stage: 'counselor',
  });

  Table.updateRecord('leave_request', leaveId, {
    revoke_status: 'requested',
    revoke_instance_id: instance.instance_id,
    revoke_reason: reason ?? null,
    updated_at: nowUtc(),
  });

  notifyTodo({
    receiverUserId: approver, instanceId: instance.instance_id, stage: 'revoke',
    title: '有一条请假撤销待确认',
    body: `${principal.display_name} 申请撤销 ${leave.start_date} 至 ${leave.end_date} 的请假。`,
    link: `/approvals/${instance.instance_id}`,
  });

  return {
    leave_id: leaveId, revoke_instance_id: instance.instance_id, revoke_status: 'requested',
    note: '撤销确认前，原请假仍然有效',
  };
}

/** 投影撤销审批结果。确认后才排除该请假单并重算剩余有效请假。 */
export async function projectRevokeApproval(leaveId, {eventId} = {}) {
  const leave = Table.get('leave_request', leaveId);
  if (!leave?.revoke_instance_id) throw new WriteRejected('NOT_FOUND', '没有进行中的撤销流程');
  const state = Approval.fetchState(leave.revoke_instance_id);
  if (!state || state.state === 'running') return {applied: false, reason: 'STILL_RUNNING'};

  if (state.state !== 'approved') {
    Table.updateRecord('leave_request', leaveId, {revoke_status: 'rejected', updated_at: nowUtc()});
    return {applied: true, revoke_status: 'rejected'};
  }

  const members = Table.all('leave_member', {where: {leave_id: leaveId}, limit: 1000});
  const affected = attendanceCoveredByLeave(leave, members.map((m) => m.student_id));

  Table.updateRecord('leave_request', leaveId, {
    revoke_status: 'confirmed', revoked_at: nowUtc(), updated_at: nowUtc(),
  });
  invalidateLeaveIndex();   // 该单失效后，重算会自动检查其余仍有效的请假单

  const result = await recomputeForRecords(affected, {
    action: 'leave_apply',
    reason: `请假 ${leaveId} 撤销已确认，重新检查其余有效请假`,
    operatorUserId: 'system:leave_revoke',
    relatedRequestId: leaveId,
    eventPrefix: eventId ?? `leave_revoked:${leaveId}`,
  });
  const dates = [...new Set(affected.map((r) => r.att_date))];
  if (dates.length) rebuildStatsForDates(dates);

  notifyMembers(leave, '请假撤销已确认',
    `${leave.start_date} 至 ${leave.end_date} 的请假已撤销，相关考勤已重新计算。`);

  return {applied: true, revoke_status: 'confirmed', recomputed: result.applied, deferred: result.deferred};
}

/* ---------------------------------------------------------- 查询 */

/** 我的申请：请假与撤销进度，审批状态与同步状态分别显示。 */
export function listMyLeaves(principal, {limit = 50} = {}) {
  const asApplicant = Table.all('leave_request', {
    where: {tenant_id: TENANT_ID, applicant_user_id: principal.user_id},
    order: [['created_at', 'DESC']], limit,
  });
  let asMember = [];
  if (principal.student_id) {
    const memberships = Table.all('leave_member', {
      where: {tenant_id: TENANT_ID, student_id: principal.student_id}, limit,
    });
    const ids = memberships.map((m) => m.leave_id).filter((id) => !asApplicant.some((l) => l.leave_id === id));
    if (ids.length) {
      asMember = Table.all('leave_request', {where: {leave_id: {op: 'in', value: ids}}, limit});
    }
  }
  return [...asApplicant, ...asMember]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((l) => toLeaveView(l, principal));
}

export function getLeave(principal, leaveId) {
  const leave = Table.get('leave_request', leaveId);
  if (!leave) throw new Forbidden('请假单不存在或无权查看');
  const members = Table.all('leave_member', {where: {leave_id: leaveId}, limit: 1000});
  const isMine = leave.applicant_user_id === principal.user_id
    || members.some((m) => m.student_id === principal.student_id);
  const inScope = members.some((m) => manageableClassIds(principal).includes(m.class_id_snapshot));
  if (!isMine && !inScope) throw new Forbidden('无权查看该请假单');

  return {
    ...toLeaveView(leave, principal),
    members: members.map((m) => ({
      student_id: m.student_id, student_no: m.student_no_snapshot,
      class_id: m.class_id_snapshot,
      name: Table.get('student_profile', m.student_id)?.name,
      apply_status: m.apply_status, affected_record_count: m.affected_record_count,
      last_error: m.last_error,
    })),
    // 证据引用只给可见者；普通同学与副班长即使看到进度也拿不到病假材料
    evidence_refs: (isMine || principal.isCounselor) ? parseJson(leave.evidence_refs, []) : [],
    evidence_visible: isMine || principal.isCounselor,
  };
}

function toLeaveView(leave, principal) {
  const applied = leave.apply_status === 'applied';
  return {
    leave_id: leave.leave_id,
    leave_type: leave.leave_type,
    start_date: leave.start_date,
    end_date: leave.end_date,
    periods: parseJson(leave.periods, []),
    reason: leave.reason,
    on_behalf: !!leave.on_behalf,
    applicant_user_id: leave.applicant_user_id,
    is_applicant: leave.applicant_user_id === principal.user_id,
    // 审批状态与同步状态分开展示，避免"审批通过=全部完成"的误导
    approval_status: leave.approval_status,
    apply_status: leave.apply_status,
    status_label: statusLabel(leave),
    sync_warning: leave.approval_status === 'approved' && !applied
      ? (leave.apply_status === 'failed' ? '审批通过，考勤同步异常' : '审批通过，考勤同步中')
      : null,
    revoke_status: leave.revoke_status,
    revoke_note: leave.revoke_status === 'requested' ? '撤销确认前，原请假仍然有效' : null,
    approved_at: leave.approved_at,
    created_at: leave.created_at,
  };
}

function statusLabel(leave) {
  if (leave.revoke_status === 'confirmed') return '已撤销';
  if (leave.revoke_status === 'requested') return '撤销待确认（原请假仍有效）';
  if (leave.approval_status === 'approved') {
    if (leave.apply_status === 'applied') return '已批准，考勤已更新';
    if (leave.apply_status === 'failed') return '已批准，考勤同步异常';
    return '已批准，考勤同步中';
  }
  if (leave.approval_status === 'rejected') return '已驳回';
  if (leave.approval_status === 'cancelled') return '已作废';
  return '审批中';
}

/* ---------------------------------------------------------- 内部 */

function recordApprovalEvent({eventId, leaveId, instanceId, sourceVersion, state}) {
  const id = eventId ?? `apev_${instanceId}_${sourceVersion}`;
  if (Table.get('approval_event', id)) return false;
  try {
    Table.insert('approval_event', {
      event_id: id, tenant_id: TENANT_ID, event_type: `leave_${state}`,
      entity_id: leaveId, source_instance_id: instanceId, source_version: sourceVersion,
      occurred_at: nowUtc(), received_at: nowUtc(), actor_id: null,
      payload_ref: '{}', accepted: 1,
    });
    return true;
  } catch {
    return false;   // 唯一约束命中 = 重复事件
  }
}

function notifyMembers(leave, title, body) {
  const members = Table.all('leave_member', {where: {leave_id: leave.leave_id}, limit: 1000});
  for (const m of members) {
    const link = Table.findOne('identity_link', {tenant_id: TENANT_ID, student_id: m.student_id});
    queueNotification({
      kind: 'leave_result',
      receiverUserId: link?.wps_user_id ?? null,
      studentId: m.student_id,
      businessRef: `leave_result:${leave.leave_id}:${m.student_id}`,
      version: `${leave.approval_status}:${leave.revoke_status}`,
      title, body,
      link: `/my-applications/${leave.leave_id}`,
    });
  }
}
