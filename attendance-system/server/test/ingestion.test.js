// 统一接入层测试。覆盖 03 §1 与验收用例 AT-012~AT-018。
//
// 重点验证「来源无关」：同一批数据用两个不同来源适配器送进来，
// 下游产出必须完全一致。

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, Table} from './fixtures.js';
import {ingest} from '../src/ingestion/pipeline.js';
import {createSource, listSources} from '../src/ingestion/registry.js';
import {mapColumns, normalizePeriods, normalizeDate, normalizeText} from '../src/ingestion/normalize.js';
import {rebuildStatsForDates} from '../src/domain/stats.js';
import {newId} from '../src/lib/util.js';

const TERM = '2026-2027-1';

/** 内存来源：证明管线不依赖 Excel。 */
function memorySource(rows, {digest = newId('d'), sourceType = 'excel_file', failAfter = null, chunk = null} = {}) {
  return {
    async describe() {
      return {
        source_type: sourceType, source_system: 'test_system',
        source_ref: 'memory://test', source_digest: digest,
        columns: Object.keys(rows[0] ?? {}), total_rows: rows.length,
      };
    },
    async* read({fromRow = 1, batchSize = 100} = {}) {
      // chunk 让测试自己决定分片大小，以便在中途制造中断
      const size = chunk ?? batchSize;
      let emitted = 0;
      let buf = [];
      for (let i = 0; i < rows.length; i += 1) {
        const rowNo = i + 1;
        if (rowNo < fromRow) continue;
        buf.push({source_row_number: rowNo, source_record_id: null, ...rows[i]});
        if (buf.length >= size) {
          yield buf; emitted += buf.length; buf = [];
          if (failAfter != null && emitted >= failAfter) throw new Error('SOURCE_INTERRUPTED');
        }
      }
      if (buf.length) yield buf;
    },
  };
}

const row = (o = {}) => ({
  name_raw: '学生甲一', class_raw: '测试甲班', course_raw: '高等数学',
  teacher_raw: '张老师', period_raw: '1', room_raw: 'A101', week_raw: '1',
  sign_time_raw: '2026-09-07T08:05:00', raw_result: '正常', raw_way: '刷脸',
  att_date_raw: '2026-09-07', ...o,
});

let world;
beforeEach(() => { world = setupWorld(); });

describe('来源无关性', () => {
  test('同一批数据经不同来源适配器，下游结果完全一致', async () => {
    const rows = [
      row({period_raw: '1', raw_result: '正常', raw_way: '刷脸'}),
      row({period_raw: '2', raw_result: '正常', raw_way: '刷卡'}),
      row({period_raw: '3', raw_result: '正常', raw_way: ''}),
      row({period_raw: '4', raw_result: '迟到', raw_way: 'istudy'}),
    ];

    const a = await ingest(memorySource(rows, {sourceType: 'excel_file', digest: 'd1'}),
      {operatorId: 'u_counselor_t1', termId: TERM});
    const first = snapshot();

    setupWorld();   // 重置世界，换一个来源类型再来一遍
    const b = await ingest(memorySource(rows, {sourceType: 'school_api', digest: 'd2'}),
      {operatorId: 'u_counselor_t1', termId: TERM});
    const second = snapshot();

    assert.equal(a.report.inserted_rows, b.report.inserted_rows);
    assert.deepEqual(first, second, '判定结果不得因来源不同而改变');

    function snapshot() {
      return Table.all('attendance', {order: [['period', 'ASC']], limit: 100})
        .map((r) => [r.period, r.base_judgment, r.final_judgment]);
    }
  });

  test('来源注册表如实标注启用状态与缺失资源', () => {
    const sources = listSources();
    const api = sources.find((s) => s.type === 'school_api');
    assert.equal(api.enabled, false, '学校 API 尚未接通，不得标为已启用');
    assert.ok(api.pending.length > 0, '必须列出接入所需但尚未取得的资源');

    assert.throws(() => createSource('school_api', {}), /SOURCE_DISABLED|尚未启用/);
  });
});

describe('列名识别（AT-012）', () => {
  test('按列名识别，与列顺序无关', () => {
    const a = mapColumns(['姓名', '班级名称', '课程名称', '课程节次', '考勤结果', '生成日期']);
    const b = mapColumns(['生成日期', '考勤结果', '课程节次', '课程名称', '班级名称', '姓名']);
    assert.deepEqual(a.missing, []);
    assert.deepEqual(b.missing, []);
    assert.equal(a.index.name_raw, 0);
    assert.equal(b.index.name_raw, 5);
  });

  test('必需列缺失报错并指明缺哪列', () => {
    const out = mapColumns(['姓名', '班级名称']);
    assert.ok(out.missing.includes('course_raw'));
    assert.ok(out.missing.includes('att_date_raw'));
  });

  test('未知列被忽略但记录下来', () => {
    const out = mapColumns(['姓名', '班级名称', '课程名称', '课程节次', '考勤结果', '生成日期', '某个新列']);
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.unknown, ['某个新列']);
  });
});

describe('值规范化', () => {
  test('节次单节、范围、非法分别处理', () => {
    assert.deepEqual(normalizePeriods('5'), {periods: [5], granularity: 'single', sourceText: '5'});
    assert.deepEqual(normalizePeriods('3节').periods, [3]);
    assert.equal(normalizePeriods('1-4').granularity, 'range');
    assert.deepEqual(normalizePeriods('1-4').periods, [1, 2, 3, 4]);
    assert.equal(normalizePeriods('0').granularity, 'invalid');
    assert.equal(normalizePeriods('13').granularity, 'invalid');
    assert.equal(normalizePeriods('').granularity, 'missing');
  });

  test('日期多种写法归一，识别不了返回 null 而不是用今天兜底', () => {
    assert.equal(normalizeDate('2026-09-07'), '2026-09-07');
    assert.equal(normalizeDate('2026/9/7'), '2026-09-07');
    assert.equal(normalizeDate('2026年9月7日'), '2026-09-07');
    assert.equal(normalizeDate('2026-09-07T08:00:00'), '2026-09-07');
    assert.equal(normalizeDate('上周三'), null);
    assert.equal(normalizeDate(''), null);
  });

  test('全角与多余空格被规范化', () => {
    assert.equal(normalizeText('　学生甲一　'), '学生甲一');
    assert.equal(normalizeText('ＡＢＣ'), 'ABC');
  });
});

describe('去重、更正与错误隔离', () => {
  test('重复文件不新增正式考勤（AT-013）', async () => {
    const rows = [row(), row({period_raw: '2'})];
    const first = await ingest(memorySource(rows, {digest: 'same'}), {operatorId: 'u_counselor_t1', termId: TERM});
    assert.equal(first.report.inserted_rows, 2);

    const second = await ingest(memorySource(rows, {digest: 'same'}), {operatorId: 'u_counselor_t1', termId: TERM});
    assert.equal(second.duplicate_source, true, '相同来源内容应被识别为重复接入');
    assert.equal(Table.count('attendance'), 2);
  });

  test('重叠日期文件只新增真正新增的行（AT-014）', async () => {
    await ingest(memorySource([row({period_raw: '1'}), row({period_raw: '2'})], {digest: 'a'}),
      {operatorId: 'u_counselor_t1', termId: TERM});
    const out = await ingest(memorySource(
      [row({period_raw: '2'}), row({period_raw: '3'})], {digest: 'b'},
    ), {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.inserted_rows, 1, '只有第 3 节是新增');
    assert.equal(out.report.duplicate_rows, 1);
    assert.equal(Table.count('attendance'), 3);
  });

  test('同业务键内容变化进入来源更正复核，不静默覆盖（AT-015）', async () => {
    await ingest(memorySource([row({raw_result: '正常', raw_way: '刷脸'})], {digest: 'v1'}),
      {operatorId: 'u_counselor_t1', termId: TERM});
    const before = Table.all('attendance', {limit: 1})[0];
    assert.equal(before.final_judgment, '正常');

    const out = await ingest(memorySource([row({raw_result: '旷课', raw_way: ''})], {digest: 'v2'}),
      {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.conflict_rows, 1);
    const after = Table.get('attendance', before.attendance_id);
    assert.equal(after.final_judgment, '正常', '不得静默改判');
    assert.equal(after.needs_review, 1, '应转辅导员复核');
    assert.match(after.review_reason, /来源更正/);
    assert.equal(Table.count('raw_attendance'), 2, '保留两个原始版本');
  });

  test('错误行分类隔离，不伪装成待处理或旷课（AT-016）', async () => {
    const out = await ingest(memorySource([
      row(),
      row({att_date_raw: '', period_raw: '2'}),
      row({period_raw: '99'}),
      row({class_raw: '不存在的班级', period_raw: '3'}),
      row({name_raw: '查无此人', period_raw: '4'}),
    ], {digest: 'err'}), {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.inserted_rows, 1);
    assert.equal(out.exception_summary.missing_date, 1);
    assert.equal(out.exception_summary.invalid_period, 1);
    assert.equal(out.exception_summary.unknown_class, 1);
    assert.equal(out.exception_summary.unmatched_student, 1);
    assert.equal(Table.count('attendance'), 1, '错误行不得生成考勤记录');
    assert.equal(Table.count('attendance', {final_judgment: '待处理'}), 0,
      '数据错误与业务状态「待处理」是两回事');
  });

  test('同班同名隔离，不随机归属也不发消息（AT-003）', async () => {
    const {mkStudent} = await import('./fixtures.js');
    mkStudent('stu_dup', 'T9999', '学生甲一', 'cls_test_a');   // 制造同班同名

    const out = await ingest(memorySource([row()], {digest: 'dup'}),
      {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.inserted_rows, 0);
    assert.equal(out.exception_summary.ambiguous_student, 1);
    assert.equal(Table.count('notification'), 0, '不得因未匹配行发送学生消息');
  });

  test('一行覆盖多节时隔离待确认，不复制成多条正常', async () => {
    const out = await ingest(memorySource([row({period_raw: '1-4'})], {digest: 'range'}),
      {operatorId: 'u_counselor_t1', termId: TERM});
    assert.equal(out.report.inserted_rows, 0);
    assert.equal(out.exception_summary.ambiguous_period_range, 1);
    assert.equal(Table.count('attendance'), 0);
  });
});

describe('日期语义取证（AT-018）', () => {
  test('签到日期与来源日期一致时给出确认结论及证据', async () => {
    const out = await ingest(memorySource([
      row({period_raw: '1', sign_time_raw: '2026-09-07T08:05:00'}),
      row({period_raw: '2', sign_time_raw: '2026-09-07T09:05:00'}),
    ], {digest: 'ok'}), {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.date_semantics, 'confirmed_same');
    assert.equal(out.report.date_evidence.date_mismatch, 0);
    assert.equal(out.report.date_evidence.signed_checked, 2);
    assert.match(out.report.date_evidence.basis, /零反例/);
  });

  test('存在不一致时结论为待确认，并留样本', async () => {
    const out = await ingest(memorySource([
      row({period_raw: '1', sign_time_raw: '2026-09-07T08:05:00'}),
      row({period_raw: '2', sign_time_raw: '2026-09-06T09:05:00'}),
    ], {digest: 'bad'}), {operatorId: 'u_counselor_t1', termId: TERM});

    assert.equal(out.report.date_semantics, 'unconfirmed');
    assert.equal(out.report.date_evidence.date_mismatch, 1);
    assert.equal(out.report.date_evidence.samples.length, 1);
    assert.match(out.report.date_evidence.basis, /不能认定/);
  });

  test('全部无签到时间时不下确认结论', async () => {
    const out = await ingest(memorySource([
      row({raw_result: '旷课', raw_way: '', sign_time_raw: '未打卡'}),
    ], {digest: 'nosign'}), {operatorId: 'u_counselor_t1', termId: TERM});
    assert.equal(out.report.date_semantics, 'unconfirmed');
    assert.match(out.report.date_evidence.basis, /无法佐证/);
  });
});

describe('中断恢复（AT-017）', () => {
  test('中断后按检查点续做，不丢失不重复', async () => {
    const rows = Array.from({length: 250}, (_, i) => row({
      period_raw: String((i % 12) + 1),
      course_raw: `课程${Math.floor(i / 12)}`,
      att_date_raw: '2026-09-07',
    }));

    let batchId;
    await assert.rejects(async () => {
      const out = await ingest(memorySource(rows, {digest: 'resume', chunk: 50, failAfter: 100}), {
        operatorId: 'u_counselor_t1', termId: TERM,
        onProgress: (p) => { /* 观察进度 */ },
      });
      batchId = out.batch_id;
    }, /SOURCE_INTERRUPTED/);

    const batch = Table.all('import_batch', {order: [['started_at', 'DESC']], limit: 1})[0];
    assert.ok(batch.checkpoint > 0, '应记录检查点');
    assert.equal(batch.status, 'processing');
    const partial = Table.count('attendance');
    assert.ok(partial > 0 && partial < rows.length, `部分完成: ${partial}`);

    // 续传
    const resumed = await ingest(memorySource(rows, {digest: 'resume', chunk: 50}), {
      operatorId: 'u_counselor_t1', termId: TERM, resumeBatchId: batch.batch_id,
    });
    assert.equal(resumed.report.status, 'completed');
    assert.equal(Table.count('attendance'), rows.length, '续传后总数正确，无丢失');
    assert.equal(Table.count('raw_attendance'), rows.length, '原始行不重复');
  });
});

describe('接入后统计联动', () => {
  test('接入完成后汇总可重建且与明细一致', async () => {
    await ingest(memorySource([
      row({period_raw: '1', raw_result: '正常', raw_way: '刷脸'}),
      row({period_raw: '2', raw_result: '正常', raw_way: '刷卡'}),
      row({period_raw: '3', raw_result: '正常', raw_way: ''}),
    ], {digest: 'stat'}), {operatorId: 'u_counselor_t1', termId: TERM});

    rebuildStatsForDates(['2026-09-07']);
    const {reconcile} = await import('../src/domain/stats.js');
    const out = reconcile(['2026-09-07']);
    assert.equal(out.diffs.length, 0, '汇总与明细必须一致');

    const stats = Table.all('daily_stat', {where: {scope_type: 'class'}, limit: 20});
    const byJudgment = Object.fromEntries(stats.map((s) => [s.judgment, s.count]));
    assert.equal(byJudgment['正常'], 1);
    assert.equal(byJudgment['旷课'], 1);
    assert.equal(byJudgment['待处理'], 1);
  });
});
