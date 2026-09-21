// Approval 适配器 —— 对应 04 §3 的 Approval.* 与 §4 的集成分级方案。
//
// 定位：轻审批是**审批过程的权威来源**。业务台账只保存结果投影。
// 业务层永远不能把多维表格里的状态手工改成"已通过"来触发生效。
//
// 本实现对应 04 §4 的「优先级 C」：假定平台只能可靠地创建/结束/查询**单级**实例，
// 两级申诉由业务服务编排两个顺序实例，业务服务维护唯一的下一阶段与版本。
// 同时实现「优先级 B」的查询对账：事件出口只是提示，生效前一律回查权威状态。
//
// 迁移到真实轻审批时需要替换本文件，并按 P08—P10 的实测结果确认：
// 动态选人、排除本人、旧任务失效、撤销已通过实例是否真的支持。

import {Table} from './table.js';
import {newId, nowUtc} from '../lib/util.js';
import {TENANT_ID} from '../config.js';

/** 审批模板。真实模板 ID 由 WPS 管理员提供，此处是本地占位并带版本。 */
export const TEMPLATES = {
  leave: {id: 'tpl_leave', version: 'v1'},
  leave_revoke: {id: 'tpl_leave_revoke', version: 'v1'},
  appeal_first: {id: 'tpl_appeal_first', version: 'v1'},
  appeal_second: {id: 'tpl_appeal_second', version: 'v1'},
};

function emit(instanceId, eventType, version) {
  Table.insert('approval_outbox', {
    instance_id: instanceId,
    event_type: eventType,
    version,
    occurred_at: nowUtc(),
    delivered: 0,
    delivery_count: 0,
  });
}

export const Approval = {
  /**
   * 发起单级审批实例。
   * assignee 为空表示"无人可路由"，调用方必须自行兜底到辅导员 —— 不产生无人待办。
   */
  start({templateKey, businessType, businessId, applicantUserId, assignee, stage}) {
    const template = TEMPLATES[templateKey];
    if (!template) throw new Error(`未知审批模板: ${templateKey}`);
    if (!assignee) throw new Error('APPROVAL_NO_ASSIGNEE');
    if (assignee === applicantUserId) throw new Error('APPROVAL_SELF_REVIEW');

    const instanceId = newId('inst');
    const ts = nowUtc();
    Table.insert('approval_instance', {
      instance_id: instanceId,
      tenant_id: TENANT_ID,
      template_id: template.id,
      template_version: template.version,
      business_type: businessType,
      business_id: businessId,
      applicant_user_id: applicantUserId,
      state: 'running',
      stage: stage ?? null,
      current_assignee: assignee,
      version: 1,
      created_at: ts,
      updated_at: ts,
    });
    emit(instanceId, 'instance_started', 1);
    return {instance_id: instanceId, template_version: template.version};
  },

  /** 权威状态查询。生效前必须调用它，不信任事件内容。 */
  fetchState(instanceId) {
    const inst = Table.get('approval_instance', instanceId);
    if (!inst) return null;
    return {
      instance_id: inst.instance_id,
      state: inst.state,
      stage: inst.stage,
      current_assignee: inst.current_assignee,
      version: inst.version,
      business_type: inst.business_type,
      business_id: inst.business_id,
      applicant_user_id: inst.applicant_user_id,
      template_version: inst.template_version,
      updated_at: inst.updated_at,
    };
  },

  /**
   * 审批人做出决定。相当于在轻审批界面点通过/驳回。
   * 权限在这里由平台自身校验：只有当前处理人能操作，实例结束后再提交一律拒绝。
   * 这正是 AT「旧审批页面超时后提交被拒绝」的落点。
   */
  decide(instanceId, {actorUserId, decision, comment}) {
    const inst = Table.get('approval_instance', instanceId);
    if (!inst) return {ok: false, code: 'INSTANCE_NOT_FOUND'};
    if (inst.state !== 'running') return {ok: false, code: 'INSTANCE_FINISHED', state: inst.state};
    if (inst.current_assignee !== actorUserId) return {ok: false, code: 'NOT_CURRENT_ASSIGNEE'};
    if (!['approved', 'rejected'].includes(decision)) return {ok: false, code: 'INVALID_DECISION'};

    const version = inst.version + 1;
    Table.updateRecord('approval_instance', instanceId, {
      state: decision,
      version,
      current_assignee: null,
      updated_at: nowUtc(),
    }, {expectedRevision: inst.version, revisionField: 'version'});
    emit(instanceId, decision === 'approved' ? 'instance_approved' : 'instance_rejected', version);
    return {ok: true, state: decision, version, comment};
  },

  /**
   * 转办：一审超时换人。返回值明确说明旧任务是否真的失效。
   * 真实平台若不支持，必须返回 supported:false，由业务层走替代流程并如实展示。
   */
  changeRoute(instanceId, {newAssignee, reason}) {
    const inst = Table.get('approval_instance', instanceId);
    if (!inst) return {ok: false, code: 'INSTANCE_NOT_FOUND'};
    if (inst.state !== 'running') return {ok: false, code: 'INSTANCE_FINISHED'};
    const version = inst.version + 1;
    Table.updateRecord('approval_instance', instanceId, {
      current_assignee: newAssignee,
      version,
      updated_at: nowUtc(),
    }, {expectedRevision: inst.version, revisionField: 'version'});
    emit(instanceId, 'instance_rerouted', version);
    // 旧处理人不再是 current_assignee，其再次提交会被 decide 以 NOT_CURRENT_ASSIGNEE 拒绝。
    return {ok: true, supported: true, old_task_invalidated: true, version, reason};
  },

  /** 撤销/作废实例。用于学生撤回申诉、请假撤销。 */
  cancel(instanceId, reason) {
    const inst = Table.get('approval_instance', instanceId);
    if (!inst) return {ok: false, code: 'INSTANCE_NOT_FOUND'};
    if (inst.state !== 'running') {
      // 已终审的实例不能"取消"。业务层不得因此显示"已完成取消"。
      return {ok: false, code: 'INSTANCE_FINISHED', state: inst.state};
    }
    const version = inst.version + 1;
    Table.updateRecord('approval_instance', instanceId, {
      state: 'cancelled', version, current_assignee: null, updated_at: nowUtc(),
    }, {expectedRevision: inst.version, revisionField: 'version'});
    emit(instanceId, 'instance_cancelled', version);
    return {ok: true, version, reason};
  },

  /**
   * 拉取事件出口。返回的是"有变化"的提示，不是可信结论。
   * duplicate/乱序在此可被刻意制造（见 test），业务侧必须自行去重。
   */
  drainEvents({limit = 100} = {}) {
    const rows = Table.all('approval_outbox', {
      where: {delivered: 0}, order: [['outbox_id', 'ASC']], limit,
    });
    return rows.map((r) => ({
      event_id: `apev_${r.instance_id}_${r.version}`,   // 平台无事件 ID 时由实例＋版本构造稳定摘要
      event_type: r.event_type,
      source_instance_id: r.instance_id,
      source_version: r.version,
      occurred_at: r.occurred_at,
      received_at: nowUtc(),
      outbox_id: r.outbox_id,
    }));
  },

  ackEvent(outboxId) {
    const row = Table.get('approval_outbox', outboxId);
    if (!row) return;
    Table.updateRecord('approval_outbox', outboxId, {
      delivered: 1, delivery_count: row.delivery_count + 1,
    });
  },

  /** 测试钩子：把某事件重投一次，用于验证"同一批准事件收到两次只生效一次"。 */
  redeliverForTest(outboxId) {
    const row = Table.get('approval_outbox', outboxId);
    if (!row) return false;
    Table.updateRecord('approval_outbox', outboxId, {delivered: 0});
    return true;
  },
};
