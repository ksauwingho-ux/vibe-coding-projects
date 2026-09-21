// 业务政策读取。
//
// 01 决策表里"待业务确认"的口径都存在 policy_setting 里，带 confirmed 标记。
// 规则引擎从这里取值，绝不硬编码政策 —— 政策变化只改配置并提升规则版本。

import {Table} from '../adapters/table.js';
import {nowUtc} from '../lib/util.js';
import {REQUIRE_CONFIRMED_POLICY} from '../config.js';

export function getPolicyRow(key) {
  return Table.get('policy_setting', key);
}

export function getPolicy(key, fallback = null) {
  return getPolicyRow(key)?.value ?? fallback;
}

export function getBool(key, fallback = false) {
  const v = getPolicy(key);
  if (v == null) return fallback;
  return v === 'true' || v === '1';
}

export function getNumber(key, fallback = 0) {
  const v = Number(getPolicy(key));
  return Number.isFinite(v) ? v : fallback;
}

export function getList(key) {
  return (getPolicy(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 规则引擎需要的政策快照。一次判定期间保持一致，避免中途变更导致同批结果不一致。 */
export function rulePolicySnapshot() {
  return {
    cardSwipeIsAbsent: getBool('rule.card_swipe_is_absent', true),
    manualWins: getBool('rule.manual_judgment_wins', true),
    leaveCoversBaseAbsentOnly: getBool('rule.leave_covers_base_absent_only', true),
  };
}

export function listPolicies() {
  return Table.all('policy_setting', {order: [['key', 'ASC']]});
}

/** 尚未经业务确认的口径。验收报告与管理页都会展示它。 */
export function unconfirmedPolicies() {
  return listPolicies().filter((p) => !p.confirmed);
}

export function setPolicy(key, value, {confirmed, note, actor} = {}) {
  const existing = getPolicyRow(key);
  if (!existing) throw new Error(`未知政策项: ${key}`);
  const changes = {value: String(value), updated_at: nowUtc()};
  if (confirmed !== undefined) changes.confirmed = confirmed ? 1 : 0;
  if (note !== undefined) changes.note = note;
  Table.updateRecord('policy_setting', key, changes);
  return {key, ...changes, actor};
}

/**
 * 对真实学生执行自动改判/推送前的闸门。
 * REQUIRE_CONFIRMED_POLICY=1 时，任何未确认口径都会阻断该动作 ——
 * 这是 00/06 中"未确认政策不得用于真实学生自动改判"的强制实现。
 */
export function assertPolicyConfirmed(keys, action) {
  if (!REQUIRE_CONFIRMED_POLICY) return {ok: true, enforced: false};
  const pending = keys.filter((k) => !getPolicyRow(k)?.confirmed);
  if (pending.length) {
    const err = new Error(`POLICY_UNCONFIRMED: ${action} 依赖未确认口径 ${pending.join(', ')}`);
    err.code = 'POLICY_UNCONFIRMED';
    err.pending = pending;
    throw err;
  }
  return {ok: true, enforced: true};
}
