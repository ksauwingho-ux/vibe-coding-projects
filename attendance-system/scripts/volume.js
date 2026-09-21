#!/usr/bin/env node
// 容量与性能验证（AT-063 / AT-064）。
//
// 做法：以真实一周数据的分布为模板，按教学周复制生成合成容量数据，
// 填充到目标行数后，用**真实的查询代码路径**（domain/attendance.js 等）测端到端耗时。
//
// 诚实声明：
//   · 合成数据只用于容量与查询性能，**不**用于业务口径验证；
//   · 它们写入独立的数据库文件，不污染生产/演示库；
//   · 本地 SQLite 的性能数字**不能**推断 WPS 多维表格的性能，
//     多维表格侧的容量与查询必须按 P13 在真实租户重测。
//
//   node scripts/volume.js --rows 600000
//   node scripts/volume.js --rows 1000000 --db data/volume-1m.db

import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rmSync, existsSync} from 'node:fs';
import {openDb, closeDb} from '../server/src/db/index.js';
import {Table} from '../server/src/adapters/table.js';
import {principalOf} from '../server/test/fixtures.js';
import {listAttendance, getScopeSummary, getAttendanceDetail} from '../server/src/domain/attendance.js';
import {listVerificationQueue} from '../server/src/domain/review.js';
import {rebuildStatsForDates} from '../server/src/domain/stats.js';
import {TENANT_ID, COLLEGE_ID, DEFAULT_TERM} from '../server/src/config.js';
import {newId, nowUtc, addDays, sha256} from '../server/src/lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const TARGET = Number(getArg('rows', 600000));
const DB = join(ROOT, getArg('db', `data/volume-${Math.round(TARGET / 1000)}k.db`));
const SOURCE_DB = join(ROOT, 'data/attendance.db');
const CONCURRENCY = Number(getArg('concurrency', 30));

async function main() {
  if (!existsSync(SOURCE_DB)) {
    console.error('缺少基准库 data/attendance.db，请先执行 npm run seed && npm run ingest');
    process.exit(1);
  }

  // ---- 1. 读取真实模板（组织结构与一周考勤分布）
  closeDb();
  openDb(SOURCE_DB);
  const classes = Table.all('class_profile', {limit: 5000});
  const students = Table.all('student_profile', {limit: 100000});
  const users = Table.all('directory_user', {limit: 200000});
  const links = Table.all('identity_link', {limit: 200000});
  const roles = Table.all('role_assignment', {limit: 200000});
  const memberships = Table.all('student_class', {limit: 200000});
  const template = Table.all('attendance', {limit: 200000});
  const baseCount = template.length;
  closeDb();

  console.log(`模板：${classes.length} 班 / ${students.length} 学生 / ${baseCount} 条考勤`);
  const weeks = Math.ceil(TARGET / baseCount);
  console.log(`目标 ${TARGET.toLocaleString()} 行 → 复制 ${weeks} 个教学周\n`);

  // ---- 2. 建容量库
  if (existsSync(DB)) rmSync(DB, {force: true});
  rmSync(`${DB}-wal`, {force: true});
  rmSync(`${DB}-shm`, {force: true});
  openDb(DB);

  const t0 = Date.now();
  Table.transaction(() => {
    for (const c of classes) Table.insert('class_profile', c);
    for (const u of users) Table.insert('directory_user', u);
    for (const s of students) Table.insert('student_profile', s);
    for (const l of links) Table.insert('identity_link', l);
    for (const r of roles) Table.insert('role_assignment', r);
    for (const m of memberships) Table.insert('student_class', m);
  });
  console.log(`组织结构导入完成 ${Date.now() - t0}ms`);

  // ---- 3. 按周复制生成合成考勤
  const batchId = newId('batch');
  Table.insert('import_batch', {
    batch_id: batchId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
    source_type: 'manual', source_system: 'synthetic_volume',
    source_ref: `volume-${TARGET}`, source_digest: sha256(`volume-${TARGET}`),
    file_name: null, file_hash: null, term_id: DEFAULT_TERM,
    status: 'completed', checkpoint: 0, operator_id: 'system:volume',
    started_at: nowUtc(), coverage_status: 'unknown', date_semantics: 'unconfirmed',
  });

  const ts = nowUtc();
  let written = 0;
  const gen = Date.now();
  const dates = new Set();

  for (let w = 0; w < weeks && written < TARGET; w += 1) {
    const shift = w * 7;
    for (let i = 0; i < template.length && written < TARGET; i += 5000) {
      const slice = template.slice(i, i + 5000);
      Table.transaction(() => {
        for (const r of slice) {
          if (written >= TARGET) break;
          const attDate = addDays(r.att_date, shift);
          dates.add(attDate);
          Table.insert('attendance', {
            ...r,
            attendance_id: `att_v${w}_${written}`,
            business_key: `${r.business_key}|w${w}`,
            att_date: attDate,
            week: (r.week ?? 1) + w,
            batch_id: batchId,
            raw_id: `raw_v${w}_${written}`,
            applied_event_id: `volume:${w}:${written}`,
            created_at: ts, updated_at: ts,
          });
          written += 1;
        }
      });
    }
    if ((w + 1) % 5 === 0 || w === weeks - 1) {
      process.stdout.write(`\r  已生成 ${written.toLocaleString()} 行（第 ${w + 1}/${weeks} 周）`);
    }
  }
  const genMs = Date.now() - gen;
  console.log(`\n合成数据写入完成：${written.toLocaleString()} 行，${(genMs / 1000).toFixed(1)}s`
    + `（${Math.round(written / (genMs / 1000)).toLocaleString()} 行/秒）\n`);

  // ---- 4. 汇总重建（只对首周，避免统计耗时压过查询测试）
  const firstWeek = [...dates].sort().slice(0, 5);
  const statT = Date.now();
  const stats = rebuildStatsForDates(firstWeek);
  console.log(`汇总重建：${firstWeek.length} 个业务日 → ${stats.rows} 条统计行，${Date.now() - statT}ms\n`);

  // ---- 5. 查询性能：真实代码路径
  const counselor = principalOf('u_counselor_01');
  const sampleStudents = students.slice(0, CONCURRENCY);
  const sampleClass = classes[0].class_id;
  const sampleRecord = Table.all('attendance', {limit: 1})[0];
  const total = Table.count('attendance');

  console.log(`背景数据 ${total.toLocaleString()} 行，并发 ${CONCURRENCY} 用户\n`);

  const scenarios = [
    {
      name: '学生查本人考勤（首页）',
      fn: (i) => listAttendance(principalOf(`u_${sampleStudents[i % sampleStudents.length].student_id}`),
        {scope_type: 'self', limit: 50}),
    },
    {
      name: '学生按结果筛选',
      fn: (i) => listAttendance(principalOf(`u_${sampleStudents[i % sampleStudents.length].student_id}`),
        {scope_type: 'self', judgments: ['旷课'], limit: 50}),
    },
    {
      name: '学生个人汇总',
      fn: (i) => getScopeSummary(principalOf(`u_${sampleStudents[i % sampleStudents.length].student_id}`),
        {scope_type: 'self'}),
    },
    {
      name: '考勤详情',
      fn: () => getAttendanceDetail(counselor, sampleRecord.attendance_id),
    },
    {
      name: '管理端班级+日期筛选',
      fn: () => listAttendance(counselor, {
        scope_type: 'class', scope_id: sampleClass,
        date_from: firstWeek[0], date_to: firstWeek[firstWeek.length - 1], limit: 50,
      }),
    },
    {
      name: '学院待核实队列（分页）',
      fn: () => listVerificationQueue(counselor, {limit: 50}),
    },
    {
      name: '学院汇总看板',
      fn: () => getScopeSummary(counselor, {scope_type: 'college', scope_id: COLLEGE_ID}),
    },
  ];

  const results = [];
  for (const s of scenarios) {
    // 预热
    for (let i = 0; i < 3; i += 1) s.fn(i);
    const samples = [];
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < CONCURRENCY; i += 1) {
        const t = process.hrtime.bigint();
        s.fn(i);
        samples.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
    results.push({
      场景: s.name,
      请求数: samples.length,
      P50: `${p(0.5).toFixed(1)}ms`,
      P95: `${p(0.95).toFixed(1)}ms`,
      最大: `${samples[samples.length - 1].toFixed(1)}ms`,
      达标: p(0.95) <= 3000 ? '✓' : '✗',
    });
  }

  console.table(results);
  const allPass = results.every((r) => r.达标 === '✓');
  console.log(`\n验收目标：60 万条背景数据、${CONCURRENCY} 并发查询用户，端到端 P95 ≤ 3 秒`);
  console.log(`结论：${allPass ? '全部达标' : '存在未达标场景'}（本地 SQLite 实现；`
    + 'WPS 多维表格侧必须按 P13 在真实租户重测，本数字不可外推）');

  closeDb();

  return {
    target: TARGET, actual: total, weeks,
    write_rows_per_sec: Math.round(written / (genMs / 1000)),
    stats_rows: stats.rows,
    concurrency: CONCURRENCY,
    scenarios: results,
    all_pass: allPass,
  };
}

const out = await main();
console.log('\n--- JSON ---');
console.log(JSON.stringify(out));
