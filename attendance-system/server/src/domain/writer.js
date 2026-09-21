// 受控写入服务 —— 最终考勤结果的唯一产生者。
//
// 04 §5.1：最终判定、审批结果投影、汇总、角色授权只由受控服务写入。
// 表格公式、人工编辑、审批自动化都不得直接写 final_judgment。
//
// 每次生效必须满足：
//   1. 同一 attendance_id 串行处理（withLock），不并发生效；
//   2. 校验 business_revision，版本不符就失败重来，绝不盲目覆盖；
//   3. applied_event_id 幂等：同一事件重复到达只生效一次；
//   4. 公示锁定后拒绝自动改判，改为生成辅导员复核任务；
//   5. 生成 review_event 与 audit_log，撤销用新事件而不是删旧事件。

import {Table, RevisionConflict} from '../adapters/table.js';
import {newId, nowUtc, createKeyedLock, parseJson} from '../lib/util.js';
import {TENANT_ID} from '../config.js';
import {computeBaseJudgment, computeFinalJudgment, RULE_VERSION, JUDGMENT} from './rules.js';
import {rulePolicySnapshot, getBool} from './policy.js';
import {activeLeavesFor} from './leave-index.js';

const withLock = createKeyedLock();

export class WriteRejected extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** 当前生效的人工结论。撤销用新事件（manual_revoke），不删除原事件。 */
function currentManualJudgment(attendanceId) {
  const events = Table.all('review_event', {
    where: {attendance_id: attendanceId, active: 1},
    order: [['created_at', 'ASC']],
    limit: 500,
  });
  let manual = null;
  for (const e of events) {
    if (['pending_confirm', 'manual_override', 'appeal_apply', 'counselor_review'].includes(e.action) && e.to_judgment) {
      manual = {judgment: e.to_judgment, event_id: e.event_id};
    } else if (e.action === 'manual_revoke') {
      manual = null;
    }
  }
  return manual;
}

/**
 * 重算一条考勤并落盘。这是**唯一**修改 attendance 判定字段的函数。
 *
 * @param {string} attendanceId
 * @param {object} ctx
 * @param {string} ctx.eventId        幂等标识；已生效过则跳过
 * @param {string} ctx.action         review_event.action
 * @param {string} ctx.reason
 * @param {string} ctx.operatorUserId
 * @param {string} [ctx.relatedRequestId]
 * @param {number} [ctx.expectedRevision] 调用方读到的版本，用于乐观并发
 * @param {boolean} [ctx.isAutomatic]  自动改判（来源更正、请假联动）在锁定后要转复核
 * @param {object} [ctx.publish]       {publicUntil} 申诉成立后的公示
 */
export async function applyJudgment(attendanceId, ctx) {
  return withLock(attendanceId, () => applyJudgmentSync(attendanceId, ctx));
}

function applyJudgmentSync(attendanceId, ctx) {
  const record = Table.get('attendance', attendanceId);
  if (!record) throw new WriteRejected('NOT_FOUND', `考勤记录不存在: ${attendanceId}`);

  // --- 幂等：同一事件已生效过，直接返回既有结果，不重复改判
  if (ctx.eventId && record.applied_event_id === ctx.eventId) {
    return {applied: false, reason: 'ALREADY_APPLIED', record, revision: record.business_revision};
  }

  // --- 乐观并发：调用方基于旧版本做的决定必须失效
  if (ctx.expectedRevision != null && ctx.expectedRevision !== record.business_revision) {
    throw new WriteRejected('REVISION_CONFLICT',
      '该记录已被他人处理，请刷新后重试', {
        expected: ctx.expectedRevision, actual: record.business_revision,
      });
  }

  // --- 公示锁定：拒绝自动改判，转复核任务（D21）
  if (record.locked_at && ctx.isAutomatic && getBool('lock.auto_rejudge_forbidden', true)) {
    Table.updateRecord('attendance', attendanceId, {
      needs_review: 1,
      review_reason: `记录已于 ${record.locked_at} 锁定，收到自动更正（${ctx.action}：${ctx.reason}），需辅导员带理由处理`,
      updated_at: nowUtc(),
    });
    Table.insert('review_event', {
      event_id: newId('ev'), tenant_id: TENANT_ID, attendance_id: attendanceId,
      action: 'counselor_review', from_judgment: record.final_judgment, to_judgment: null,
      before_revision: record.business_revision, after_revision: record.business_revision,
      reason: `锁定后收到自动更正，未直接改判：${ctx.reason}`,
      evidence_refs: '[]', operator_user_id: ctx.operatorUserId,
      related_request_id: ctx.relatedRequestId ?? null, active: 1, created_at: nowUtc(),
    });
    audit(ctx, attendanceId, 'locked_change_deferred', record, record);
    return {applied: false, reason: 'LOCKED_DEFERRED_TO_REVIEW', record, revision: record.business_revision};
  }

  const policy = rulePolicySnapshot();
  const base = computeBaseJudgment(
    {raw_result: record.raw_result, raw_way: record.raw_way}, policy,
  );
  const leaves = activeLeavesFor(record.student_id, record.att_date, record.period);
  const manual = currentManualJudgment(attendanceId);
  const outcome = computeFinalJudgment({base, activeLeaves: leaves, manual}, policy);

  const nextRevision = record.business_revision + 1;
  const changes = {
    base_judgment: base.judgment,
    leave_ids: JSON.stringify(outcome.leaveIds),
    manual_judgment: manual?.judgment ?? null,
    manual_event_id: manual?.event_id ?? null,
    final_judgment: outcome.final,
    judgment_reason: outcome.reason,
    rule_version: RULE_VERSION,
    business_revision: nextRevision,
    applied_event_id: ctx.eventId ?? `sys:${newId('ev')}`,
    needs_review: outcome.needsReview ? 1 : record.needs_review,
    review_reason: outcome.reviewReason ?? (outcome.needsReview ? record.review_reason : null),
    updated_at: nowUtc(),
  };
  if (ctx.publish?.publicUntil) {
    changes.public_until = ctx.publish.publicUntil;
    changes.locked_at = null;
  }
  if (ctx.lock) changes.locked_at = nowUtc();
  if (ctx.clearReview) { changes.needs_review = 0; changes.review_reason = null; }

  // 「无变化」必须把复核标记也算进去：
  // 人工结论与请假冲突时最终结果不变（人工结论优先），但冲突本身必须落库并进入复核，
  // 否则就成了静默吞掉冲突 —— 03 §2.2 明确禁止。
  const reviewUnchanged = outcome.needsReview
    ? record.needs_review === 1 && record.review_reason === outcome.reviewReason
    : true;
  const unchanged = record.final_judgment === outcome.final
    && record.base_judgment === base.judgment
    && record.judgment_reason === outcome.reason
    && reviewUnchanged
    && !ctx.publish && !ctx.lock && !ctx.clearReview;

  if (unchanged) {
    // 结果没变也要记下幂等标识，避免同一事件反复重算
    if (ctx.eventId) Table.updateRecord('attendance', attendanceId, {applied_event_id: ctx.eventId});
    return {applied: false, reason: 'NO_CHANGE', record, revision: record.business_revision};
  }

  try {
    Table.updateRecord('attendance', attendanceId, changes, {
      expectedRevision: record.business_revision,
    });
  } catch (err) {
    if (err instanceof RevisionConflict) {
      throw new WriteRejected('REVISION_CONFLICT', '写入时记录版本已变化，请重试', {
        expected: err.expected, actual: err.actual,
      });
    }
    throw err;
  }

  Table.insert('review_event', {
    event_id: ctx.eventId ?? newId('ev'),
    tenant_id: TENANT_ID,
    attendance_id: attendanceId,
    action: ctx.action,
    from_judgment: record.final_judgment,
    to_judgment: outcome.final,
    before_revision: record.business_revision,
    after_revision: nextRevision,
    reason: ctx.reason,
    evidence_refs: JSON.stringify(ctx.evidenceRefs ?? []),
    operator_user_id: ctx.operatorUserId,
    related_request_id: ctx.relatedRequestId ?? null,
    active: ctx.recordAsManual ? 1 : 0,
    created_at: nowUtc(),
  });

  const after = Table.get('attendance', attendanceId);
  audit(ctx, attendanceId, ctx.action, record, after);
  return {applied: true, record: after, revision: nextRevision, from: record.final_judgment, to: outcome.final};
}

/**
 * 登记一个人工结论（待处理核对、申诉成立、辅导员改判），随后重算。
 * 人工结论以 review_event(active=1) 的形式存在，只能被显式撤销事件替换。
 */
export async function recordManualJudgment(attendanceId, {
  toJudgment, action, reason, operatorUserId, evidenceRefs = [], relatedRequestId = null,
  expectedRevision, eventId, publish, lock,
}) {
  return withLock(attendanceId, () => {
    const record = Table.get('attendance', attendanceId);
    if (!record) throw new WriteRejected('NOT_FOUND', '考勤记录不存在');
    if (expectedRevision != null && expectedRevision !== record.business_revision) {
      throw new WriteRejected('REVISION_CONFLICT', '该记录已被他人处理，请刷新后重试', {
        expected: expectedRevision, actual: record.business_revision,
      });
    }
    const evId = eventId ?? newId('ev');
    if (record.applied_event_id === evId) {
      return {applied: false, reason: 'ALREADY_APPLIED', record};
    }
    Table.insert('review_event', {
      event_id: evId, tenant_id: TENANT_ID, attendance_id: attendanceId,
      action, from_judgment: record.final_judgment, to_judgment: toJudgment,
      before_revision: record.business_revision, after_revision: record.business_revision + 1,
      reason, evidence_refs: JSON.stringify(evidenceRefs),
      operator_user_id: operatorUserId, related_request_id: relatedRequestId,
      active: 1, created_at: nowUtc(),
    });
    // 人工结论已登记，重算时会被 currentManualJudgment 读到并优先采用
    return applyJudgmentSync(attendanceId, {
      eventId: `apply:${evId}`, action, reason, operatorUserId,
      relatedRequestId, evidenceRefs, publish, lock, clearReview: true,
    });
  });
}

/** 撤销人工结论：新增 manual_revoke 事件，不删原事件，随后重算回自动结果。 */
export async function revokeManualJudgment(attendanceId, {reason, operatorUserId, expectedRevision}) {
  return withLock(attendanceId, () => {
    const record = Table.get('attendance', attendanceId);
    if (!record) throw new WriteRejected('NOT_FOUND', '考勤记录不存在');
    if (expectedRevision != null && expectedRevision !== record.business_revision) {
      throw new WriteRejected('REVISION_CONFLICT', '该记录已被他人处理，请刷新后重试');
    }
    const evId = newId('ev');
    Table.insert('review_event', {
      event_id: evId, tenant_id: TENANT_ID, attendance_id: attendanceId,
      action: 'manual_revoke', from_judgment: record.final_judgment, to_judgment: null,
      before_revision: record.business_revision, after_revision: record.business_revision + 1,
      reason, evidence_refs: '[]', operator_user_id: operatorUserId,
      related_request_id: null, active: 1, created_at: nowUtc(),
    });
    return applyJudgmentSync(attendanceId, {
      eventId: `apply:${evId}`, action: 'manual_revoke', reason, operatorUserId, clearReview: true,
    });
  });
}

/** 按请假单重算受影响考勤。批准、撤销确认都走这里。 */
export async function recomputeForRecords(records, ctx) {
  const results = {applied: 0, skipped: 0, deferred: 0, failed: 0, details: []};
  for (const record of records) {
    try {
      const out = await applyJudgment(record.attendance_id, {
        ...ctx,
        eventId: `${ctx.eventPrefix}:${record.attendance_id}`,
        isAutomatic: true,
      });
      if (out.applied) results.applied += 1;
      else if (out.reason === 'LOCKED_DEFERRED_TO_REVIEW') results.deferred += 1;
      else results.skipped += 1;
      results.details.push({attendance_id: record.attendance_id, ...out, record: undefined});
    } catch (err) {
      results.failed += 1;
      results.details.push({attendance_id: record.attendance_id, error: err.code ?? err.message});
    }
  }
  return results;
}

export function audit(ctx, entityId, action, before, after) {
  Table.insert('audit_log', {
    audit_id: newId('aud'),
    tenant_id: TENANT_ID,
    actor_user_id: ctx.operatorUserId ?? 'system',
    actor_role_snapshot: ctx.actorRole ?? null,
    scope_snapshot: ctx.actorScope ?? null,
    action,
    entity_type: 'attendance',
    entity_id: entityId,
    // 只存判定字段快照，病历等敏感内容不进普通审计日志
    before_ref: before ? JSON.stringify(judgmentSnapshot(before)) : null,
    after_ref: after ? JSON.stringify(judgmentSnapshot(after)) : null,
    reason: ctx.reason ?? null,
    source_event_id: ctx.eventId ?? null,
    result: 'ok',
    occurred_at: nowUtc(),
  });
}

function judgmentSnapshot(r) {
  return {
    final_judgment: r.final_judgment, base_judgment: r.base_judgment,
    manual_judgment: r.manual_judgment, leave_ids: parseJson(r.leave_ids, []),
    business_revision: r.business_revision, locked_at: r.locked_at, public_until: r.public_until,
  };
}

export {JUDGMENT};
