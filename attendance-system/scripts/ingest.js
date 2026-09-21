#!/usr/bin/env node
// 命令行接入入口。与 HTTP 接口走同一条管线，不存在第二套导入逻辑。
//
//   node scripts/ingest.js --source excel_file --file data/第8周.xlsx
//   node scripts/ingest.js --file data/第8周.xlsx --dry-run
//   node scripts/ingest.js --resume <batch_id>
//   node scripts/ingest.js --list-sources

import {openDb} from '../server/src/db/index.js';
import {createSource, listSources} from '../server/src/ingestion/registry.js';
import {ingest} from '../server/src/ingestion/pipeline.js';
import {rebuildStatsForDates} from '../server/src/domain/stats.js';
import {DEFAULT_TERM} from '../server/src/config.js';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

async function main() {
  if (args.includes('--list-sources')) {
    console.log(JSON.stringify(listSources(), null, 2));
    return;
  }
  openDb();

  const sourceType = getArg('source', 'excel_file');
  const dryRun = args.includes('--dry-run');
  const resumeBatchId = getArg('resume', null);
  const operatorId = getArg('operator', 'u_counselor_01');
  const termId = getArg('term', DEFAULT_TERM);

  const source = createSource(sourceType, {
    filePath: getArg('file', 'data/第8周.xlsx'),
    dateFrom: getArg('from'), dateTo: getArg('to'),
  });

  const started = Date.now();
  let lastLog = 0;
  const result = await ingest(source, {
    operatorId, termId, dryRun, resumeBatchId,
    onProgress(p) {
      if (Date.now() - lastLog > 1000) {
        lastLog = Date.now();
        process.stdout.write(`\r已处理 ${p.total} 行 · 新增 ${p.inserted} · 重复 ${p.duplicate} · 异常 ${p.invalid + p.unmatched}   `);
      }
    },
  });
  process.stdout.write('\r');

  console.log(JSON.stringify(result.report, null, 2));
  if (result.exception_summary && Object.keys(result.exception_summary).length) {
    console.log('异常分类：', result.exception_summary);
  }
  if (result.duplicate_source) console.log('!!', result.message);
  if (dryRun) {
    console.log('\n预览（前 20 条）：');
    console.table(result.preview);
  } else if (result.affected_dates?.length) {
    const t = Date.now();
    const stats = rebuildStatsForDates(result.affected_dates);
    console.log(`汇总重建：${stats.rows} 条统计行，涉及 ${result.affected_dates.length} 个业务日，${Date.now() - t}ms`);
  }
  console.log(`总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('\n接入失败：', err.message);
  if (err.pending) console.error('缺少的资源：\n - ' + err.pending.join('\n - '));
  process.exit(1);
});
