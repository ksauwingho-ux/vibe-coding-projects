// 字段标准化 —— 接入层唯一负责"把各来源的写法拉齐"的地方。
//
// 下游拿到的永远是同一套标准字段与同一套规范值域；
// 来源之间的列名差异、别名差异、节次写法差异全部在这里消化。

import {BASE_RULE_TABLE} from '../config.js';
import {isValidDate} from '../lib/util.js';
import {REQUIRED_FIELDS} from './source.js';

/**
 * 列名 -> 标准字段。按**列名**识别，与列顺序无关（AT-012）。
 * 新来源列名不同，只需在这里补别名。
 */
export const COLUMN_ALIASES = {
  name_raw: ['姓名', '学生姓名', 'studentName', 'name'],
  class_raw: ['班级名称', '班级', 'className', 'class'],
  course_raw: ['课程名称', '课程', 'courseName', 'course'],
  teacher_raw: ['上课老师', '授课教师', '教师', '任课教师', 'teacher'],
  period_raw: ['课程节次', '节次', '节次号', 'period'],
  room_raw: ['教室位置', '教室', '上课地点', '地点', 'room'],
  week_raw: ['周次', '教学周', 'week'],
  sign_time_raw: ['签到时间', '打卡时间', 'signTime'],
  raw_result: ['考勤结果', '结果', '考勤状态', 'result'],
  att_date_raw: ['生成日期', '上课日期', '日期', 'date', 'attDate'],
  raw_way: ['考勤方式', '方式', '签到方式', 'way'],
  source_record_id: ['记录ID', '记录编号', 'recordId', 'id'],
};

/** 表头 -> {标准字段: 列下标}。未知列忽略但记录，必需列缺失报错。 */
export function mapColumns(header) {
  const index = {};
  const unknown = [];
  header.forEach((cellRaw, i) => {
    const cell = String(cellRaw ?? '').trim();
    if (!cell) return;
    const field = Object.keys(COLUMN_ALIASES).find(
      (f) => COLUMN_ALIASES[f].some((a) => a.toLowerCase() === cell.toLowerCase()),
    );
    if (field) {
      if (!(field in index)) index[field] = i;
    } else unknown.push(cell);
  });
  const missing = REQUIRED_FIELDS.filter((f) => !(f in index));
  return {index, unknown, missing};
}

const FULLWIDTH = /[！-～]/g;

/** 去首尾空格、全角转半角、合并内部空白。所有原文字段都先过这一步。 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 考勤结果规范化。未登记的结果返回 null，由判定规则落入待处理，不猜。 */
export function normalizeResult(raw) {
  const t = normalizeText(raw);
  if (!t) return null;
  return BASE_RULE_TABLE.resultAliases[t] ?? null;
}

/** 考勤方式规范化。保留原始字符串；未登记的方式返回 null，不自行扩展有效方式集合。 */
export function normalizeWay(raw) {
  const t = normalizeText(raw);
  if (!t) return '';                       // 空方式是明确的一种情形，不等于未知方式
  return BASE_RULE_TABLE.wayAliases[t] ?? BASE_RULE_TABLE.wayAliases[t.toLowerCase()] ?? null;
}

/**
 * 节次规范化。
 * 返回 {periods:[1..12], granularity:'single'|'range', sourceText}
 * range 表示来源一行覆盖多节（如 "1-4节"）。
 * 是否可以展开成多条，由 pipeline 依据 policy 决定 —— 默认不展开而是隔离，
 * 因为无法证明一次签到覆盖了每一节（03 §4 明确禁止直接复制成四条正常）。
 */
export function normalizePeriods(raw) {
  const text = normalizeText(raw);
  if (!text) return {periods: [], granularity: 'missing', sourceText: text};

  const single = /^(\d{1,2})\s*节?$/.exec(text);
  if (single) {
    const p = Number(single[1]);
    return inRange(p)
      ? {periods: [p], granularity: 'single', sourceText: text}
      : {periods: [], granularity: 'invalid', sourceText: text};
  }
  const range = /^(\d{1,2})\s*[-—~至]\s*(\d{1,2})\s*节?$/.exec(text);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (!inRange(from) || !inRange(to) || to < from) {
      return {periods: [], granularity: 'invalid', sourceText: text};
    }
    const periods = [];
    for (let p = from; p <= to; p += 1) periods.push(p);
    return {periods, granularity: periods.length === 1 ? 'single' : 'range', sourceText: text};
  }
  const list = /^(\d{1,2})(\s*[,，]\s*\d{1,2})+\s*节?$/.exec(text);
  if (list) {
    const periods = text.replace(/节/g, '').split(/[,，]/).map((s) => Number(s.trim()));
    if (periods.every(inRange)) {
      return {periods, granularity: periods.length === 1 ? 'single' : 'range', sourceText: text};
    }
  }
  return {periods: [], granularity: 'invalid', sourceText: text};
}

function inRange(p) {
  return Number.isInteger(p) && p >= 1 && p <= 12;
}

/** 日期规范化，输出 YYYY-MM-DD。识别不了返回 null，绝不用今天兜底。 */
export function normalizeDate(raw) {
  const t = normalizeText(raw);
  if (!t) return null;
  if (isValidDate(t)) return t;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(t);
  if (iso) return t.slice(0, 10);
  const slash = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t);
  if (slash) {
    const d = `${slash[1]}-${String(slash[2]).padStart(2, '0')}-${String(slash[3]).padStart(2, '0')}`;
    return isValidDate(d) ? d : null;
  }
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(t);
  if (cn) {
    const d = `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}`;
    return isValidDate(d) ? d : null;
  }
  return null;
}

/** 签到时间规范化，输出 ISO 或 null（"未打卡"这类占位文本不是时间）。 */
export function normalizeSignTime(raw) {
  const t = normalizeText(raw);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(t)) return t.replace(' ', 'T');
  return null;
}

export function normalizeWeek(raw) {
  const t = normalizeText(raw).replace(/第|周/g, '');
  const n = Number(t);
  return Number.isInteger(n) && n > 0 && n <= 30 ? n : null;
}
