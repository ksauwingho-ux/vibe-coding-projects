// Table 适配器 —— 业务台账的唯一访问入口。
//
// 契约对应 docs/baseline/04 §3：Table.query / Table.createBatch / Table.updateRecord。
// 当前实现后端为本地 SQLite；迁移到 WPS 多维表格时只替换本文件，业务层不改。
//
// 刻意保留的能力边界（不要在业务层依赖本地实现的额外能力）：
//   · 分页一律 keyset 游标，不用 offset —— 多维表格大表 offset 翻页不可行。
//   · createBatch 返回逐条结果，部分成功必须逐条可见，不允许只报整批成功。
//   · updateRecord 必须传 expectedRevision，用条件更新实现乐观并发；
//     WPS 侧若无条件更新能力，由 domain/writer.js 的串行写入通道兜底（见 04 §5.1），
//     届时本函数的 revisionMismatch 语义不变。
//   · aggregate() 是明确标注的逃生口，只允许统计重建使用；
//     WPS 侧需改为多维表格的汇总视图或由 daily_stat 直接承载。

import {getDb} from '../db/index.js';
import {parseJson} from '../lib/util.js';

/** 各逻辑表的主键字段。 */
const PRIMARY_KEY = {
  student_profile: 'student_id', identity_link: 'link_id', class_profile: 'class_id',
  directory_user: 'wps_user_id',
  class_alias: 'alias_id', student_class: 'membership_id', role_assignment: 'assignment_id',
  course_session: 'session_id', enrollment: 'enrollment_id',
  import_batch: 'batch_id', raw_attendance: 'raw_id', import_exception: 'exception_id',
  data_coverage: 'coverage_id', attendance: 'attendance_id',
  leave_request: 'leave_id', leave_member: 'member_id',
  appeal: 'appeal_id', appeal_step: 'step_id', review_event: 'event_id',
  audit_log: 'audit_id', daily_stat: 'stat_key', event_job: 'event_id',
  notification: 'notification_id', approval_instance: 'instance_id',
  approval_event: 'event_id', approval_outbox: 'outbox_id', policy_setting: 'key', data_partition: 'partition_id',
  app_session: 'session_token', evidence_file: 'evidence_id',
};

/** 平台侧批量写入上限。真实 WPS 上限必须实测后回填，不得沿用此值。 */
export const BATCH_LIMIT = Number(process.env.TABLE_BATCH_LIMIT || 500);

export class RevisionConflict extends Error {
  constructor(tableName, pk, expected, actual) {
    super(`REVISION_CONFLICT ${tableName}:${pk} expected=${expected} actual=${actual}`);
    this.code = 'REVISION_CONFLICT';
    this.expected = expected;
    this.actual = actual;
  }
}

function pkOf(tableName) {
  const pk = PRIMARY_KEY[tableName];
  if (!pk) throw new Error(`未登记的逻辑表: ${tableName}`);
  return pk;
}

/**
 * where 支持的形式：
 *   {field: value}                     等值
 *   {field: {op: 'in', value: [...]}}  在集合内
 *   {field: {op: '>=', value: x}}      比较
 *   {field: {op: 'like', value: '%x%'}}
 *   {field: {op: 'isNull'}} / {op: 'notNull'}
 */
function buildWhere(where = {}) {
  const parts = [];
  const params = [];
  for (const [field, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (cond === null) { parts.push(`${field} IS NULL`); continue; }
    if (typeof cond === 'object' && cond.op) {
      const op = cond.op;
      if (op === 'in') {
        if (!cond.value.length) { parts.push('0 = 1'); continue; }
        parts.push(`${field} IN (${cond.value.map(() => '?').join(',')})`);
        params.push(...cond.value);
      } else if (op === 'isNull') parts.push(`${field} IS NULL`);
      else if (op === 'notNull') parts.push(`${field} IS NOT NULL`);
      else if (['=', '!=', '>', '>=', '<', '<=', 'like'].includes(op)) {
        parts.push(`${field} ${op.toUpperCase()} ?`);
        params.push(cond.value);
      } else throw new Error(`不支持的查询运算符: ${op}`);
    } else {
      parts.push(`${field} = ?`);
      params.push(cond);
    }
  }
  return {clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params};
}

function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  return cursor ? parseJson(Buffer.from(cursor, 'base64url').toString('utf8'), null) : null;
}

/**
 * keyset 分页：order 形如 [['att_date','DESC'], ['attendance_id','ASC']]。
 * 末位必须是唯一列（主键），否则翻页会漏记录。
 */
function buildKeyset(order, cursorValues) {
  if (!cursorValues) return {clause: '', params: []};
  // (a,b) 在 a DESC,b ASC 下的"继续"条件：a<a0 OR (a=a0 AND b>b0)
  const ors = [];
  const params = [];
  for (let i = 0; i < order.length; i += 1) {
    const eqs = [];
    for (let j = 0; j < i; j += 1) {
      eqs.push(`${order[j][0]} = ?`);
      params.push(cursorValues[j]);
    }
    const [col, dir] = order[i];
    eqs.push(`${col} ${dir.toUpperCase() === 'DESC' ? '<' : '>'} ?`);
    params.push(cursorValues[i]);
    ors.push(`(${eqs.join(' AND ')})`);
  }
  return {clause: `(${ors.join(' OR ')})`, params};
}

export const Table = {
  /** 单条读取。 */
  get(tableName, id) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE ${pkOf(tableName)} = ?`).get(id);
    return row ?? null;
  },

  /** 按条件取第一条。 */
  findOne(tableName, where) {
    const {clause, params} = buildWhere(where);
    return getDb().prepare(`SELECT * FROM ${tableName} ${clause} LIMIT 1`).get(...params) ?? null;
  },

  /**
   * 分页查询。返回 {records, next_cursor, has_more}。
   * total 刻意不默认返回：大表 count 在多维表格侧代价不可控，需要时显式 countApprox。
   */
  query(tableName, {where = {}, order, limit = 50, cursor = null, fields} = {}) {
    const db = getDb();
    const sortOrder = order ?? [[pkOf(tableName), 'ASC']];
    const w = buildWhere(where);
    const k = buildKeyset(sortOrder, decodeCursor(cursor));
    const clauses = [w.clause.replace(/^WHERE /, ''), k.clause].filter(Boolean);
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderSql = sortOrder.map(([c, d]) => `${c} ${d.toUpperCase()}`).join(', ');
    const cols = fields?.length ? fields.join(', ') : '*';
    const rows = db.prepare(
      `SELECT ${cols} FROM ${tableName} ${whereSql} ORDER BY ${orderSql} LIMIT ?`,
    ).all(...w.params, ...k.params, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      records: page,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor(sortOrder.map(([c]) => last[c])) : null,
    };
  },

  /** 取全部匹配行。仅用于结果集有界的场景（角色、班级、某学生某日）。 */
  all(tableName, {where = {}, order, limit = 5000} = {}) {
    const {clause, params} = buildWhere(where);
    const orderSql = order?.length ? `ORDER BY ${order.map(([c, d]) => `${c} ${d.toUpperCase()}`).join(', ')}` : '';
    return getDb().prepare(`SELECT * FROM ${tableName} ${clause} ${orderSql} LIMIT ?`).all(...params, limit);
  },

  count(tableName, where = {}) {
    const {clause, params} = buildWhere(where);
    return getDb().prepare(`SELECT COUNT(*) AS n FROM ${tableName} ${clause}`).get(...params).n;
  },

  insert(tableName, record) {
    const cols = Object.keys(record);
    getDb().prepare(
      `INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).run(...cols.map((c) => record[c]));
    return record[pkOf(tableName)];
  },

  /**
   * 批量写入。逐条返回成功/失败，部分成功如实反映。
   * 超出 BATCH_LIMIT 直接报错，避免业务层依赖一个平台侧并不存在的上限。
   */
  createBatch(tableName, records, {ignoreDuplicates = false} = {}) {
    if (records.length > BATCH_LIMIT) {
      throw new Error(`批量超限: ${records.length} > ${BATCH_LIMIT}，请由调用方分片`);
    }
    const db = getDb();
    const results = [];
    db.exec('BEGIN');
    try {
      for (const record of records) {
        try {
          this.insert(tableName, record);
          results.push({ok: true, id: record[pkOf(tableName)]});
        } catch (err) {
          const duplicate = /UNIQUE constraint/i.test(err.message);
          if (duplicate && ignoreDuplicates) {
            results.push({ok: false, id: record[pkOf(tableName)], code: 'DUPLICATE'});
          } else if (duplicate) {
            results.push({ok: false, id: record[pkOf(tableName)], code: 'DUPLICATE', error: err.message});
          } else {
            results.push({ok: false, id: record[pkOf(tableName)], code: 'WRITE_FAILED', error: err.message});
          }
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return {
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  },

  /**
   * 条件更新。expectedRevision 为 null 时表示不做版本校验（仅限本身无版本概念的表）。
   * 版本不符抛 RevisionConflict —— 调用方必须重新读取后再决定，不得盲目重试覆盖。
   */
  updateRecord(tableName, id, changes, {expectedRevision = null, revisionField = 'business_revision'} = {}) {
    const db = getDb();
    const pk = pkOf(tableName);
    const cols = Object.keys(changes);
    if (!cols.length) return 0;
    const sets = cols.map((c) => `${c} = ?`);
    const params = cols.map((c) => changes[c]);
    let sql = `UPDATE ${tableName} SET ${sets.join(', ')} WHERE ${pk} = ?`;
    params.push(id);
    if (expectedRevision !== null) {
      sql += ` AND ${revisionField} = ?`;
      params.push(expectedRevision);
    }
    const info = db.prepare(sql).run(...params);
    if (info.changes === 0 && expectedRevision !== null) {
      const current = this.get(tableName, id);
      throw new RevisionConflict(tableName, id, expectedRevision, current?.[revisionField] ?? null);
    }
    return info.changes;
  },

  /** upsert：仅用于 daily_stat、policy_setting 这类幂等覆盖表。 */
  upsert(tableName, record, conflictCols) {
    const cols = Object.keys(record);
    const updates = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = excluded.${c}`);
    getDb().prepare(
      `INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON CONFLICT(${conflictCols.join(',')}) DO UPDATE SET ${updates.join(', ')}`,
    ).run(...cols.map((c) => record[c]));
  },

  remove(tableName, id) {
    return getDb().prepare(`DELETE FROM ${tableName} WHERE ${pkOf(tableName)} = ?`).run(id).changes;
  },

  /**
   * 聚合逃生口。只允许 domain/stats.js 的汇总重建调用。
   * WPS 侧没有等价的自由聚合，迁移时改为按明细分页扫描后在服务内累计，
   * 或直接由 daily_stat 承载 —— 所以调用点必须集中且可替换。
   */
  aggregate(sql, params = []) {
    return getDb().prepare(sql).all(...params);
  },

  /**
   * 本地事务。WPS 多维表格没有跨表事务，
   * 因此业务正确性不得建立在它之上 —— 一致性由幂等键、版本校验和对账保证。
   * 这里仅用于降低本地导入的写放大。
   */
  transaction(fn) {
    const db = getDb();
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};
