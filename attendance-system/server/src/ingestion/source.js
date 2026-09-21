// 考勤数据来源适配器契约。
//
// 【架构约束】考勤数据只经由本接入层进入系统。
// Excel 文件是当前实现的一个来源；学校考勤 API 是后续扩展的另一个来源。
// 两者都必须产出同一份标准化记录 SourceAttendanceRecord，
// 下游（判定 rules、审批 leave/appeal、统计 stats、推送 notify）
// 只认标准化记录与 raw_attendance / attendance 表，
// **不得出现文件名、工作表、单元格、列序号或任何来源特有概念**。
//
// 新增来源时要做的事只有三件：
//   1. 实现下面的 AttendanceSource 接口；
//   2. 在 registry.js 注册；
//   3. 在 normalize.js 补充该来源的字段别名（若列名不同）。
// 不需要改动 pipeline.js 与任何下游模块。

/**
 * @typedef {object} SourceAttendanceRecord 标准化考勤记录
 * @property {number} source_row_number  来源内序号（Excel 行号 / API 记录序号），仅供追溯
 * @property {string|null} source_record_id 来源系统自己的记录 ID（有则填，用于更强的去重）
 * @property {string} name_raw       学生姓名原文
 * @property {string} class_raw      班级名称原文
 * @property {string} course_raw     课程名称原文
 * @property {string} teacher_raw    授课教师原文
 * @property {string} period_raw     节次原文（可能是 "5" 或 "1-4节"）
 * @property {string} room_raw       教室原文
 * @property {string} week_raw       周次原文
 * @property {string} sign_time_raw  签到时间原文
 * @property {string} raw_result     考勤结果原文（正常/迟到/早退/旷课/…）
 * @property {string} raw_way        考勤方式原文（刷脸/istudy/二维码/刷卡/空）
 * @property {string} att_date_raw   日期原文
 */

/**
 * @typedef {object} SourceDescriptor
 * @property {string} source_type    excel_file | school_api | manual
 * @property {string} source_system  来源系统标识
 * @property {string|null} source_ref    来源定位（文件名 / 拉取区间），仅供追溯
 * @property {string|null} source_digest 来源内容摘要，用于重复接入提示
 * @property {string[]} columns      来源提供的字段名，用于列名校验
 */

/**
 * @typedef {object} AttendanceSource
 * @property {() => Promise<SourceDescriptor>} describe
 *   返回来源描述。在真正读取数据前调用，用于建批次与重复接入检查。
 * @property {(opts:{fromRow?:number, batchSize?:number}) => AsyncIterable<SourceAttendanceRecord[]>} read
 *   分片读取标准化记录。必须支持 fromRow 续读 —— 断点续传依赖它。
 */

/** 所有来源必须提供的标准字段。缺任何一个都不能进入管线。 */
export const REQUIRED_FIELDS = [
  'name_raw', 'class_raw', 'course_raw', 'period_raw', 'raw_result', 'att_date_raw',
];

/** 标准化记录的完整字段集，用于建 raw_attendance 行。 */
export const RECORD_FIELDS = [
  'source_row_number', 'source_record_id',
  'name_raw', 'class_raw', 'course_raw', 'teacher_raw', 'period_raw',
  'room_raw', 'week_raw', 'sign_time_raw', 'raw_result', 'raw_way', 'att_date_raw',
];

export function emptyRecord(sourceRowNumber) {
  const r = {source_row_number: sourceRowNumber, source_record_id: null};
  for (const f of RECORD_FIELDS) if (!(f in r)) r[f] = '';
  return r;
}
