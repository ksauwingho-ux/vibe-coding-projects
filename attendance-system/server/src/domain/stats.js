// 汇总统计。
//
// 口径（02 §7 / D17）：
//   · 总节次 = 该范围已入库且身份有效的考勤记录数（单位是"学生·节"，不是人头）。
//   · 异常节次 = 旷课＋迟到＋早退（由 policy stat.abnormal_definition 决定）。
//   · 待核实（待处理）**单列**，不并入异常。
//   · v4 的"旷课＋待处理"口径另名为「需关注记录」，绝不与异常率混用。
//   · 覆盖率未知时只能称"已导入考勤"，不得称"全院完整到课率"。
//
// 个人、班级、学院三级汇总全部来自同一张事实表 attendance，
// 不用学生课程总表的行数当考勤总数。

import {Table} from '../adapters/table.js';
import {TENANT_ID, JUDGMENTS} from '../config.js';
import {nowUtc} from '../lib/util.js';
import {getList} from './policy.js';

/**
 * 按业务日重建汇总。可重复执行，结果幂等。
 * 这是唯一调用 Table.aggregate 的业务模块 —— 迁移到多维表格时集中替换这里。
 */
export function rebuildStatsForDates(dates) {
  if (!dates?.length) return {rows: 0, dates: 0};
  const watermark = nowUtc();
  const placeholders = dates.map(() => '?').join(',');
  let rows = 0;

  const scopes = [
    {type: 'student', column: 'student_id'},
    {type: 'class', column: 'class_id'},
    {type: 'college', column: 'college_id'},
  ];

  for (const scope of scopes) {
    // 先清掉这些日期下该层级的旧统计，避免结果类别消失后残留旧计数
    Table.aggregate(
      `DELETE FROM daily_stat WHERE tenant_id = ? AND scope_type = ? AND att_date IN (${placeholders})`,
      [TENANT_ID, scope.type, ...dates],
    );
    const grouped = Table.aggregate(
      `SELECT ${scope.column} AS scope_id, att_date, final_judgment AS judgment, COUNT(*) AS count
         FROM attendance
        WHERE tenant_id = ? AND att_date IN (${placeholders})
        GROUP BY ${scope.column}, att_date, final_judgment`,
      [TENANT_ID, ...dates],
    );
    for (const slice of batched(grouped, 400)) {
      Table.transaction(() => {
        for (const g of slice) {
          Table.upsert('daily_stat', {
            stat_key: `${scope.type}|${g.scope_id}|${g.att_date}|${g.judgment}`,
            tenant_id: TENANT_ID,
            scope_type: scope.type,
            scope_id: g.scope_id,
            att_date: g.att_date,
            judgment: g.judgment,
            count: g.count,
            source_watermark: watermark,
            reconciliation_status: 'ok',
            last_rebuilt_at: watermark,
          }, ['stat_key']);
          rows += 1;
        }
      });
    }
  }
  return {rows, dates: dates.length, watermark};
}

function* batched(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * 读取某范围某区间的汇总。
 * @returns {{counts:object, total_imported_periods:number, abnormal_periods:number,
 *   pending_verification_periods:number, needs_attention_periods:number,
 *   coverage_status:string, expected_periods:null, attendance_rate:number|null,
 *   source_watermark:string, updated_at:string}}
 */
export function getSummary({scopeType, scopeId, dateFrom, dateTo}) {
  const rows = Table.all('daily_stat', {
    where: {
      tenant_id: TENANT_ID, scope_type: scopeType, scope_id: scopeId,
      att_date: {op: '>=', value: dateFrom},
    },
    limit: 20000,
  }).filter((r) => r.att_date <= dateTo);

  return summarizeRows(rows);
}

/** 班级/学院看板用：一次取多个范围的按日汇总。 */
export function getDailySeries({scopeType, scopeIds, dateFrom, dateTo}) {
  if (!scopeIds.length) return [];
  return Table.all('daily_stat', {
    where: {
      tenant_id: TENANT_ID, scope_type: scopeType,
      scope_id: {op: 'in', value: scopeIds},
      att_date: {op: '>=', value: dateFrom},
    },
    order: [['att_date', 'ASC']],
    limit: 50000,
  }).filter((r) => r.att_date <= dateTo);
}

export function summarizeRows(rows) {
  const counts = Object.fromEntries(JUDGMENTS.map((j) => [j, 0]));
  let watermark = '';
  let updatedAt = '';
  for (const r of rows) {
    counts[r.judgment] = (counts[r.judgment] ?? 0) + r.count;
    if (r.source_watermark > watermark) watermark = r.source_watermark;
    if (r.last_rebuilt_at > updatedAt) updatedAt = r.last_rebuilt_at;
  }
  const abnormalKinds = getList('stat.abnormal_definition');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const abnormal = abnormalKinds.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
  const pending = counts['待处理'] ?? 0;

  return {
    counts,
    total_imported_periods: total,
    abnormal_periods: abnormal,
    abnormal_definition: abnormalKinds.join('＋'),
    pending_verification_periods: pending,
    // v4 的"旷课＋待处理"口径，单独命名，绝不与异常率混用
    needs_attention_periods: (counts['旷课'] ?? 0) + pending,
    abnormal_rate: total ? Number(((abnormal / total) * 100).toFixed(2)) : null,
    // 应到节次需要权威课表与选课关系；当前来源无法推导，明确返回 null 而不是编一个分母
    expected_periods: null,
    attendance_rate: null,
    rate_definition_id: null,
    source_watermark: watermark || null,
    updated_at: updatedAt || null,
  };
}

/**
 * 覆盖状态：只能由辅导员显式确认，不能由"接入成功"推断。
 * 未确认时统一返回 unknown，界面必须显示"已导入考勤"而非"完整到课率"。
 */
export function coverageFor(classIds, dateFrom, dateTo) {
  if (!classIds.length) return 'unknown';
  const rows = Table.all('data_coverage', {
    where: {
      tenant_id: TENANT_ID, class_id: {op: 'in', value: classIds},
      att_date: {op: '>=', value: dateFrom},
    },
    limit: 20000,
  }).filter((r) => r.att_date <= dateTo);
  if (!rows.length) return 'unknown';
  if (rows.every((r) => r.coverage_status === 'complete')) return 'complete';
  if (rows.some((r) => r.coverage_status !== 'unknown')) return 'partial';
  return 'unknown';
}

/**
 * 对账：明细重新聚合后与 daily_stat 比对。
 * 差异不是"修一下就好"，而是必须进入责任队列，因此这里只报告，由调用方决定重建。
 */
export function reconcile(dates) {
  const placeholders = dates.map(() => '?').join(',');
  const actual = Table.aggregate(
    `SELECT class_id AS scope_id, att_date, final_judgment AS judgment, COUNT(*) AS count
       FROM attendance WHERE tenant_id = ? AND att_date IN (${placeholders})
      GROUP BY class_id, att_date, final_judgment`,
    [TENANT_ID, ...dates],
  );
  const diffs = [];
  for (const a of actual) {
    const key = `class|${a.scope_id}|${a.att_date}|${a.judgment}`;
    const stat = Table.get('daily_stat', key);
    if (!stat || stat.count !== a.count) {
      diffs.push({stat_key: key, expected: a.count, stored: stat?.count ?? 0});
    }
  }
  return {checked: actual.length, diffs};
}
