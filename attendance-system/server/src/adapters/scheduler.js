// Scheduler 适配器 —— 对应 04 §3 的 Scheduler.enqueue 与 §5.2 的"先持久受理，再逐步生效"。
//
// 任务一律落库（event_job），不是进程内数组或 setTimeout：
// 进程重启后必须能恢复，这正是 AT-017「中断恢复」的依据。
//
// 租约（lease）在本地由单进程 + 条件更新保证唯一执行者。
// 多副本部署必须改用真实支持原子操作的任务支撑 —— 见 04 §5.1，不要直接照搬。

import {Table} from './table.js';
import {newId, nowUtc, addHours} from '../lib/util.js';
import {TENANT_ID, RUNTIME} from '../config.js';

export const Scheduler = {
  /**
   * 持久入队。idempotencyKey 已存在则返回已有任务，不重复受理。
   * @returns {{job_id:string, created:boolean}}
   */
  enqueue({idempotencyKey, entityType, entityId, eventType, payload = {}, sourceVersion = 0, runAfter = null}) {
    const existing = Table.findOne('event_job', {idempotency_key: idempotencyKey});
    if (existing) return {job_id: existing.event_id, created: false, status: existing.status};

    const jobId = newId('job');
    try {
      Table.insert('event_job', {
        event_id: jobId,
        tenant_id: TENANT_ID,
        idempotency_key: idempotencyKey,
        entity_type: entityType,
        entity_id: entityId,
        event_type: eventType,
        source_version: sourceVersion,
        status: 'queued',
        payload_ref: JSON.stringify(payload),
        attempts: 0,
        run_after: runAfter ?? nowUtc(),
        created_at: nowUtc(),
      });
    } catch (err) {
      if (/UNIQUE constraint/i.test(err.message)) {
        const raced = Table.findOne('event_job', {idempotency_key: idempotencyKey});
        return {job_id: raced.event_id, created: false, status: raced.status};
      }
      throw err;
    }
    return {job_id: jobId, created: true, status: 'queued'};
  },

  /** 取一批可执行任务并加租约。条件更新失败说明被别的执行者抢走，跳过。 */
  lease(owner, {limit = 10} = {}) {
    const now = nowUtc();
    const candidates = Table.all('event_job', {
      where: {
        status: {op: 'in', value: ['queued', 'retry']},
        run_after: {op: '<=', value: now},
      },
      order: [['run_after', 'ASC'], ['event_id', 'ASC']],
      limit,
    });
    const leased = [];
    for (const job of candidates) {
      try {
        Table.updateRecord('event_job', job.event_id, {
          status: 'running',
          lease_owner: owner,
          lease_until: addHours(now, RUNTIME.jobLeaseSeconds / 3600),
        }, {expectedRevision: job.status, revisionField: 'status'});
        leased.push({...job, status: 'running'});
      } catch {
        // 已被他人领取，正常跳过。
      }
    }
    return leased;
  },

  /** 回收过期租约：执行者崩溃后任务必须能被重新领取。 */
  reclaimExpired() {
    const stale = Table.all('event_job', {
      where: {status: 'running', lease_until: {op: '<', value: nowUtc()}},
      limit: 100,
    });
    for (const job of stale) {
      Table.updateRecord('event_job', job.event_id, {
        status: 'retry', lease_owner: null, lease_until: null,
        last_error: 'LEASE_EXPIRED',
      });
    }
    return stale.length;
  },

  succeed(jobId, checkpoint = null) {
    Table.updateRecord('event_job', jobId, {
      status: 'succeeded', finished_at: nowUtc(), lease_owner: null, lease_until: null,
      checkpoint, last_error: null,
    });
  },

  /** 失败重试；超过上限进入 dead，交人工处理并给出业务原因，不静默丢弃。 */
  fail(jobId, error) {
    const job = Table.get('event_job', jobId);
    if (!job) return;
    const attempts = job.attempts + 1;
    const dead = attempts >= RUNTIME.jobMaxAttempts;
    const backoffSeconds = Math.min(2 ** attempts, 300);
    Table.updateRecord('event_job', jobId, {
      status: dead ? 'dead' : 'retry',
      attempts,
      last_error: String(error).slice(0, 500),
      lease_owner: null,
      lease_until: null,
      run_after: dead ? null : addHours(nowUtc(), backoffSeconds / 3600),
      next_retry_at: dead ? null : addHours(nowUtc(), backoffSeconds / 3600),
      finished_at: dead ? nowUtc() : null,
    });
  },

  updateCheckpoint(jobId, checkpoint) {
    Table.updateRecord('event_job', jobId, {checkpoint: JSON.stringify(checkpoint)});
  },
};
