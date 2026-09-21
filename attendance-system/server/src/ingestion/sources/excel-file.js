// Excel 文件来源适配器。
//
// 这是整个工程里唯一知道"数据来自一个 xlsx 文件"的业务文件。
// 它把文件内容翻译成标准化记录后就退场；下游看不到文件、工作表或列下标。

import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {readSheet} from '../../lib/xlsx.js';
import {sha256} from '../../lib/util.js';
import {mapColumns} from '../normalize.js';

export const SOURCE_TYPE = 'excel_file';

/**
 * @param {object} opts
 * @param {string} [opts.filePath]  文件路径
 * @param {Buffer} [opts.buffer]    直接给内容（HTTP 上传走这条）
 * @param {string} [opts.fileName]  展示用文件名
 * @returns {import('../source.js').AttendanceSource}
 */
export function createExcelSource({filePath, buffer, fileName, sheetIndex = 0}) {
  const bytes = buffer ?? readFileSync(filePath);
  const name = fileName ?? (filePath ? basename(filePath) : 'upload.xlsx');
  let cache = null;

  function load() {
    if (cache) return cache;
    const rows = readSheet(bytes, {sheetIndex});
    if (!rows.length) throw new Error('INGEST_EMPTY_SOURCE');
    const header = rows[0].map((c) => String(c ?? ''));
    const mapping = mapColumns(header);
    if (mapping.missing.length) {
      const err = new Error(`INGEST_MISSING_COLUMNS: ${mapping.missing.join(', ')}`);
      err.code = 'INGEST_MISSING_COLUMNS';
      err.missing = mapping.missing;
      err.header = header;
      throw err;
    }
    cache = {rows, header, mapping};
    return cache;
  }

  return {
    async describe() {
      const {header, mapping, rows} = load();
      return {
        source_type: SOURCE_TYPE,
        source_system: 'school_attendance_export',
        source_ref: name,
        source_digest: sha256(bytes),
        columns: header,
        unknown_columns: mapping.unknown,
        total_rows: rows.length - 1,
      };
    },

    /** 分片产出标准化记录。fromRow 是来源内序号（1 基，对应表头之后的第 1 行）。 */
    async* read({fromRow = 1, batchSize = 1000} = {}) {
      const {rows, mapping} = load();
      const idx = mapping.index;
      const pick = (row, field) => (idx[field] == null ? '' : String(row[idx[field]] ?? ''));

      let buf = [];
      for (let i = fromRow; i < rows.length; i += 1) {
        const row = rows[i];
        // 整行为空的填充行直接跳过，不计入错误。
        if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
        buf.push({
          source_row_number: i,               // 与文件行号一致（含表头），便于人工定位
          source_record_id: pick(row, 'source_record_id') || null,
          name_raw: pick(row, 'name_raw'),
          class_raw: pick(row, 'class_raw'),
          course_raw: pick(row, 'course_raw'),
          teacher_raw: pick(row, 'teacher_raw'),
          period_raw: pick(row, 'period_raw'),
          room_raw: pick(row, 'room_raw'),
          week_raw: pick(row, 'week_raw'),
          sign_time_raw: pick(row, 'sign_time_raw'),
          raw_result: pick(row, 'raw_result'),
          raw_way: pick(row, 'raw_way'),
          att_date_raw: pick(row, 'att_date_raw'),
        });
        if (buf.length >= batchSize) { yield buf; buf = []; }
      }
      if (buf.length) yield buf;
    },
  };
}
