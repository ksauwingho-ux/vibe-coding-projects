// 零依赖 xlsx 读取器。
//
// 仅供 ingestion/sources/excel-file.js 使用 —— 这是整个工程里唯一知道"什么是 Excel"的地方。
// 支持 .xlsx（ZIP + SpreadsheetML）：共享字符串、内联字符串、数值、日期序列号。
// 不支持 .xls（BIFF）与加密工作簿；遇到时明确报错，不做猜测性解析。

import {inflateRawSync} from 'node:zlib';

/* --------------------------------------------------------------- ZIP */

function findEocd(buf) {
  // EOCD 固定 22 字节 + 注释；从尾部向前扫描签名 PK\x05\x06
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('不是有效的 xlsx（未找到 ZIP 目录）');
}

/** 读取 ZIP 中所有条目，返回 name -> Buffer。 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 本地头：签名(4) 版本(2) 标志(2) 方法(2) 时间(4) crc(4) 压缩(4) 原始(4) 名长(2) 扩展长(2)
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}（条目 ${name}）`);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* --------------------------------------------------------------- XML */

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decodeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** 取出某元素内所有 <t> 文本并拼接（富文本 run 会被拆成多个 t）。 */
function joinTextNodes(xml) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>|<t[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const list = [];
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) list.push(m[1] ? joinTextNodes(m[1]) : '');
  return list;
}

/* ---------------------------------------------------- 单元格与日期 */

function colIndex(ref) {
  // "BC12" -> 列号（0 基）
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Excel 日期序列号 -> YYYY-MM-DD。1900 历法含闰年 bug，序列 60 不存在。 */
function serialToDate(serial) {
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * 86400) * 1000;
  // 25569 = 1970-01-01 的 Excel 序列号
  const d = new Date((days - 25569) * 86400000 + ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return ms === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 读取工作簿的第一张（或指定）工作表，返回二维字符串数组。
 * 所有单元格一律转成字符串：学号、班级这类字段必须保留前导零与原文。
 */
export function readSheet(buffer, {sheetIndex = 0} = {}) {
  const zip = readZip(buffer);
  const sharedXml = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  const shared = parseSharedStrings(sharedXml);

  const sheetNames = [...zip.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheetNames.length) throw new Error('工作簿中没有工作表');
  const sheetXml = zip.get(sheetNames[sheetIndex])?.toString('utf8');
  if (!sheetXml) throw new Error(`工作表 #${sheetIndex} 不存在`);

  // 日期格式的 style 索引集合：用于把数值序列号还原成日期
  const dateStyles = collectDateStyles(zip.get('xl/styles.xml')?.toString('utf8'));

  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  const cellRe = /<c\s+([^>]*?)\/>|<c\s+([^>]*?)>([\s\S]*?)<\/c>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const inner = rowMatch[1];
    const cells = [];
    if (inner) {
      let cellMatch;
      cellRe.lastIndex = 0;
      while ((cellMatch = cellRe.exec(inner)) !== null) {
        const attrs = cellMatch[1] ?? cellMatch[2] ?? '';
        const body = cellMatch[3] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
        const style = /s="(\d+)"/.exec(attrs)?.[1];
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push('');
        cells.push(cellValue(type, body, shared, style, dateStyles));
      }
    }
    rows.push(cells);
  }
  return rows;
}

function cellValue(type, body, shared, style, dateStyles) {
  if (type === 's') {
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    return v == null ? '' : (shared[Number(v)] ?? '');
  }
  if (type === 'inlineStr') return joinTextNodes(body);
  if (type === 'str') return decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
  if (type === 'b') return /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
  if (type === 'e') return decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '#ERR');
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw == null || raw === '') return '';
  if (style != null && dateStyles.has(Number(style))) return serialToDate(Number(raw));
  return raw;
}

/** 解析 styles.xml，找出使用日期数字格式的 cellXfs 索引。 */
function collectDateStyles(stylesXml) {
  const result = new Set();
  if (!stylesXml) return result;
  const builtinDateIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const customDateIds = new Set();
  const fmtRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m;
  while ((m = fmtRe.exec(stylesXml)) !== null) {
    if (/[yhdms]/i.test(m[2]) && !/^[@#0.,%]*$/.test(m[2])) customDateIds.add(Number(m[1]));
  }
  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1];
  if (!xfsBlock) return result;
  const xfRe = /<xf[^>]*numFmtId="(\d+)"[^>]*>|<xf[^>]*numFmtId="(\d+)"[^>]*\/>/g;
  let index = 0;
  let xf;
  while ((xf = xfRe.exec(xfsBlock)) !== null) {
    const id = Number(xf[1] ?? xf[2]);
    if (builtinDateIds.has(id) || customDateIds.has(id)) result.add(index);
    index += 1;
  }
  return result;
}
