// 通用工具：ID、摘要、时间。
// 时间约定（docs/baseline/00）：存储一律 UTC ISO 字符串，展示转北京时间；
// 业务日期是不带时区的固定日期字符串 YYYY-MM-DD，不随系统时区漂移。

import {createHash, randomUUID} from 'node:crypto';

export const TZ = 'Asia/Shanghai';

/** 业务 ID：应用生成的不可变字符串，永不使用表格行号或平台 record_id。 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function sha256(input) {
  return createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex');
}

/** 稳定摘要：字段顺序无关，用于 payload_hash 等内容比对。 */
export function stableHash(obj) {
  const keys = Object.keys(obj).sort();
  return sha256(keys.map((k) => `${k}=${obj[k] ?? ''}`).join('\u0001'));
}

export function nowUtc() {
  return new Date().toISOString();
}

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** UTC 时刻 -> 北京时间的业务日期 */
export function businessDate(instant = new Date()) {
  return DATE_FMT.format(instant instanceof Date ? instant : new Date(instant));
}

export function beijingTime(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  return `${DATE_FMT.format(d)} ${TIME_FMT.format(d)}`;
}

/** 北京时间的某日某时分 -> UTC ISO。用于 21:00 日报这类本地时刻调度。 */
export function beijingInstant(dateStr, hour = 0, minute = 0) {
  // 中国全境 UTC+8 且无夏令时，直接换算即可。
  return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`).toISOString();
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addHours(isoInstant, hours) {
  return new Date(new Date(isoInstant).getTime() + hours * 3600_000).toISOString();
}

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * 按 key 串行化异步操作。单一写入通道依赖它保证同一考勤不并发生效。
 * 注意：这是单进程内的串行化。多副本部署必须改用真实的分布式租约，
 * 不能把它当成跨进程锁 —— 见 docs/baseline/04 §5.1。
 */
export function createKeyedLock() {
  const chains = new Map();
  return function withLock(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
