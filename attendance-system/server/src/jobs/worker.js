// 持久任务处理器。对应 04 §5.2「先持久受理，再逐步生效」。
//
// 任务落在 event_job 表，不是进程内数组或定时器：
// 进程重启后靠租约回收继续做，这正是"中断恢复"的依据。
//
// 审批事件的处理顺序：
//   1. 从事件出口拿到"有变化"的提示（不可信）；
//   2. 写入持久任务（幂等键 = 实例＋版本，重复到达只受理一次）；
//   3. 执行时回查 Approval.fetchState 的权威状态；
//   4. 版本不前进就丢弃（乱序/重复）；
//   5. 生效、对账、建通知。

import {Table} from '../adapters/table.js';
import {Approval} from '../adapters/approval.js';
import {Scheduler} from '../adapters/scheduler.js';
import {RUNTIME} from '../config.js';
import {nowUtc, beijingInstant, businessDate, addDays} from '../lib/util.js';
import {projectLeaveApproval, projectRevokeApproval, applyLeaveToAttendance} from '../domain/leave.js';
import {scanDeadlines} from '../domain/appeal.js';
import {flushNotifications, buildStudentDailyDigest, buildCounselorDailyDigest, digestHour} from '../domain/notify.js';
import {reconcile, rebuildStatsForDates} from '../domain/stats.js';

const WORKER_ID = `worker_${process.pid}`;

/* ------------------------------------------------ 审批事件摄取 */

/**
 * 把审批平台的事件提示转成持久任务。
 * 幂等键含实例与版本，所以"同一批准事件收到两次"只会产生一个任务。
 */
export function ingestApprovalEvents({limit = 100} = {}) {
  const events = Approval.drainEvents({limit});
  let accepted = 0;
  let duplicate = 0;

  for (const ev of events) {
    const inst = Table.get('approval_instance', ev.source_instance_id);
    if (!inst) { Approval.ackEvent(ev.outbox_id); continue; }

    const entityType = inst.business_type;   // leave / leave_revoke / appeal
    const out = Scheduler.enqueue({
      idempotencyKey: `approval:${ev.source_instance_id}:${ev.source_version}`,
      entityType,
      entityId: inst.business_id,
      eventType: 'approval_state_changed',
      sourceVersion: ev.source_version,
      payload: {instance_id: ev.source_instance_id, business_type: entityType},
    });
    if (out.created) accepted += 1; else duplicate += 1;
    Approval.ackEvent(ev.outbox_id);
  }
  return {drained: events.length, accepted, duplicate};
}

/* ------------------------------------------------ 任务执行 */

const HANDLERS = {
  async approval_state_changed(job) {
    const payload = JSON.parse(job.payload_ref);
    if (payload.business_type === 'leave') {
      return projectLeaveApproval(job.entity_id, {
        eventId: job.idempotency_key, sourceVersion: job.source_version,
      });
    }
    if (payload.business_type === 'leave_revoke') {
      return projectRevokeApproval(job.entity_id, {eventId: job.idempotency_key});
    }
    if (payload.business_type === 'appeal') {
      // 申诉的推进由审核动作同步完成；这里只做状态对账，不重复生效。
      const appeal = Table.get('appeal', job.entity_id);
      return {checked: true, status: appeal?.status, apply_status: appeal?.apply_status};
    }
    return {skipped: true, reason: 'UNKNOWN_BUSINESS_TYPE'};
  },

  async leave_apply_retry(job) {
    const payload = JSON.parse(job.payload_ref);
    return applyLeaveToAttendance(payload.leaveId, {eventId: `retry:${job.event_id}`});
  },

  async student_daily_digest(job) {
    const payload = JSON.parse(job.payload_ref);
    const result = buildStudentDailyDigest(payload.date);
    flushNotifications({limit: 5000});
    return result;
  },

  async counselor_daily_digest(job) {
    const payload = JSON.parse(job.payload_ref);
    const result = buildCounselorDailyDigest(payload.date);
    flushNotifications({limit: 500});
    return result;
  },

  async deadline_scan() {
    return scanDeadlines();
  },

  async reconcile_stats(job) {
    const payload = JSON.parse(job.payload_ref);
    const out = reconcile(payload.dates);
    if (out.diffs.length) rebuildStatsForDates(payload.dates);
    return {...out, rebuilt: out.diffs.length > 0};
  },
};

/** 执行一轮：回收过期租约 -> 摄取审批事件 -> 领取并执行任务。 */
export async function runOnce({limit = 20} = {}) {
  const reclaimed = Scheduler.reclaimExpired();
  const ingested = ingestApprovalEvents();
  const jobs = Scheduler.lease(WORKER_ID, {limit});
  const results = [];

  for (const job of jobs) {
    const handler = HANDLERS[job.event_type];
    if (!handler) {
      Scheduler.fail(job.event_id, `NO_HANDLER:${job.event_type}`);
      results.push({event_id: job.event_id, ok: false, error: 'NO_HANDLER'});
      continue;
    }
    try {
      const out = await handler(job);
      Scheduler.succeed(job.event_id, JSON.stringify(out ?? {}).slice(0, 2000));
      results.push({event_id: job.event_id, type: job.event_type, ok: true, out});
    } catch (err) {
      Scheduler.fail(job.event_id, err.message);
      results.push({event_id: job.event_id, type: job.event_type, ok: false, error: err.message});
    }
  }
  return {reclaimed, ingested, executed: results.length, results};
}

/* ------------------------------------------------ 定时调度 */

/**
 * 排入当日的定时任务。幂等键含日期，重复调用不会重复排。
 * 日报时刻用北京时间换算成 UTC 时刻，不依赖进程时区。
 */
export function scheduleDailyJobs(date = businessDate()) {
  const out = [];
  out.push(Scheduler.enqueue({
    idempotencyKey: `student_digest:${date}`,
    entityType: 'digest', entityId: date, eventType: 'student_daily_digest',
    payload: {date},
    runAfter: beijingInstant(date, digestHour('student'), 0),
  }));
  out.push(Scheduler.enqueue({
    idempotencyKey: `counselor_digest:${date}`,
    entityType: 'digest', entityId: date, eventType: 'counselor_daily_digest',
    payload: {date},
    runAfter: beijingInstant(date, digestHour('counselor'), 5),
  }));
  out.push(Scheduler.enqueue({
    idempotencyKey: `reconcile:${date}`,
    entityType: 'stats', entityId: date, eventType: 'reconcile_stats',
    payload: {dates: [date, addDays(date, -1)]},
    runAfter: beijingInstant(date, 23, 30),
  }));
  return out;
}

/** 一审超时巡检：建议每 10 分钟一次。 */
export function scheduleDeadlineScan() {
  const slot = Math.floor(Date.now() / (RUNTIME.appealScanMinutes * 60000));
  return Scheduler.enqueue({
    idempotencyKey: `deadline_scan:${slot}`,
    entityType: 'system', entityId: 'deadline', eventType: 'deadline_scan',
    payload: {},
  });
}

/** 常驻循环。单副本运行；多副本必须换成真实分布式租约（见 04 §5.1）。 */
export function startWorker() {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      scheduleDeadlineScan();
      await runOnce();
    } catch (err) {
      console.error('[worker] 轮次失败:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, RUNTIME.jobPollMs);
  timer.unref?.();
  tick();

  return {
    stop() { stopped = true; clearInterval(timer); },
    runOnce,
  };
}

export {WORKER_ID};
