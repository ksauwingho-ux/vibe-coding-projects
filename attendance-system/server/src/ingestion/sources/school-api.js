// 学校考勤 API 来源适配器（二期接入项）。
//
// 现状：学校尚未提供接口文档、鉴权方式、分页语义与字段定义。
// 因此这里**不编造端点、参数或字段名**，只落定这个来源在架构中的位置与契约。
//
// 接入时要做的事：
//   1. 填入 fetchPage()：真实鉴权、真实分页、真实字段。
//   2. 若 API 字段名与 normalize.js 的 COLUMN_ALIASES 不同，在那里补别名即可。
//   3. 在 registry.js 里把 enabled 改成 true。
// 管线、判定、审批、统计、推送**都不需要改动** —— 这正是统一接入层的目的。

export const SOURCE_TYPE = 'school_api';

/** 接入所需、但当前尚未取得的资源。列在这里以免被当成"已打通"。 */
export const PENDING_REQUIREMENTS = [
  '接口基址与鉴权方式（凭证由密钥管理注入，不写入代码或前端）',
  '按日期/班级拉取的分页语义与单页上限',
  '字段定义：是否提供学号（有学号可省去姓名+班级匹配）、是否提供稳定记录 ID',
  '考勤结果与考勤方式的完整值域（不得沿用 Excel 的值域假设）',
  '增量拉取游标或更新时间字段，用于识别学校侧的更正',
  '历史数据可回溯范围与调用频率限制',
];

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {() => Promise<string>} opts.getToken  凭证获取函数，由部署配置注入
 * @param {string} opts.dateFrom
 * @param {string} opts.dateTo
 * @returns {import('../source.js').AttendanceSource}
 */
export function createSchoolApiSource({baseUrl, getToken, dateFrom, dateTo} = {}) {
  function notReady() {
    const err = new Error(
      'SOURCE_NOT_AVAILABLE: 学校考勤 API 尚未提供接口文档与授权，'
      + '该来源仅有契约占位。所需资源见 PENDING_REQUIREMENTS。',
    );
    err.code = 'SOURCE_NOT_AVAILABLE';
    err.pending = PENDING_REQUIREMENTS;
    throw err;
  }

  return {
    async describe() {
      if (!baseUrl || !getToken) notReady();
      return {
        source_type: SOURCE_TYPE,
        source_system: 'school_attendance_api',
        source_ref: `${dateFrom}..${dateTo}`,
        source_digest: null,       // 由首次拉取的响应摘要回填
        columns: [],               // 由真实响应回填
        total_rows: null,          // API 通常无法预先知道总数
      };
    },

    async* read() {
      notReady();
      // 真实实现形如：
      //   let cursor = null;
      //   do {
      //     const page = await fetchPage({baseUrl, token, dateFrom, dateTo, cursor});
      //     yield page.items.map(toStandardRecord);   // toStandardRecord 输出 SourceAttendanceRecord
      //     cursor = page.next_cursor;
      //   } while (cursor);
      // 其中 source_row_number 用"本次拉取内的序号"，
      // source_record_id 用学校侧稳定 ID —— 有它就不必依赖姓名+班级匹配。
    },
  };
}
