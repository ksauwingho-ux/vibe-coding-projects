// 判定规则单元测试。覆盖 03 §2 的完整规则表与最终判定顺序。

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, mkAttendance, Table} from './fixtures.js';
import {computeBaseJudgment, computeFinalJudgment, leaveCovers, JUDGMENT} from '../src/domain/rules.js';
import {rulePolicySnapshot, setPolicy} from '../src/domain/policy.js';

describe('基础判定规则表（03 §2.1）', () => {
  setupWorld();
  const policy = rulePolicySnapshot();
  const base = (r, w) => computeBaseJudgment({raw_result: r, raw_way: w}, policy).judgment;

  test('正常 + 有效方式 -> 正常', () => {
    assert.equal(base('正常', '刷脸'), JUDGMENT.NORMAL);
    assert.equal(base('正常', 'istudy'), JUDGMENT.NORMAL);
    assert.equal(base('正常', '二维码'), JUDGMENT.NORMAL);
  });

  test('正常 + 刷卡 -> 旷课（D06 业务政策）', () => {
    assert.equal(base('正常', '刷卡'), JUDGMENT.ABSENT);
  });

  test('正常 + 空方式 -> 待处理，不猜正常也不猜旷课', () => {
    assert.equal(base('正常', ''), JUDGMENT.PENDING);
    assert.equal(base('正常', '   '), JUDGMENT.PENDING);
  });

  test('正常 + 未知方式 -> 待处理，不自行扩展有效方式集合', () => {
    assert.equal(base('正常', '指纹'), JUDGMENT.PENDING);
    assert.equal(base('正常', '蓝牙'), JUDGMENT.PENDING);
  });

  test('迟到/早退/旷课 与方式无关', () => {
    for (const way of ['刷脸', '刷卡', '', '指纹']) {
      assert.equal(base('迟到', way), JUDGMENT.LATE);
      assert.equal(base('早退', way), JUDGMENT.EARLY);
      assert.equal(base('旷课', way), JUDGMENT.ABSENT);
    }
  });

  test('未识别结果 -> 待处理', () => {
    assert.equal(base('请假', '刷脸'), JUDGMENT.PENDING);
    assert.equal(base('', '刷脸'), JUDGMENT.PENDING);
    assert.equal(base('异常', '刷脸'), JUDGMENT.PENDING);
  });

  test('方式别名规范化，原始字符串保留', () => {
    assert.equal(base('正常', 'iStudy'), JUDGMENT.NORMAL);
    assert.equal(base('正常', '人脸识别'), JUDGMENT.NORMAL);
    assert.equal(base('正常', '扫码'), JUDGMENT.NORMAL);
  });

  test('D06 政策关闭后，正常+刷卡 -> 正常', () => {
    setPolicy('rule.card_swipe_is_absent', 'false');
    const p2 = rulePolicySnapshot();
    assert.equal(computeBaseJudgment({raw_result: '正常', raw_way: '刷卡'}, p2).judgment, JUDGMENT.NORMAL);
    setPolicy('rule.card_swipe_is_absent', 'true');
  });

  test('每条判定都带可解释理由与规则名', () => {
    const out = computeBaseJudgment({raw_result: '正常', raw_way: '刷卡'}, policy);
    assert.ok(out.reason.length > 0);
    assert.equal(out.rule, 'base.card_swipe_absent');
  });
});

describe('最终判定顺序（03 §2.2）', () => {
  setupWorld();
  const policy = rulePolicySnapshot();
  const leave = {leave_id: 'lv1', leave_type: 'sick'};

  test('请假只覆盖基础旷课', () => {
    const absent = {judgment: JUDGMENT.ABSENT, reason: 'r'};
    assert.equal(computeFinalJudgment({base: absent, activeLeaves: [leave]}, policy).final, JUDGMENT.LEAVE);
  });

  test('请假不消除迟到、早退、待处理', () => {
    for (const j of [JUDGMENT.LATE, JUDGMENT.EARLY, JUDGMENT.PENDING]) {
      const out = computeFinalJudgment({base: {judgment: j, reason: 'r'}, activeLeaves: [leave]}, policy);
      assert.equal(out.final, j, `${j} 不应被请假覆盖`);
      assert.match(out.reason, /只覆盖基础旷课/);
    }
  });

  test('有效人工结论优先于请假', () => {
    const out = computeFinalJudgment({
      base: {judgment: JUDGMENT.ABSENT, reason: 'r'},
      activeLeaves: [leave],
      manual: {judgment: JUDGMENT.ABSENT, event_id: 'ev1'},
    }, policy);
    assert.equal(out.final, JUDGMENT.ABSENT);
  });

  test('人工结论与请假冲突时进入辅导员复核，不静默隐藏', () => {
    const out = computeFinalJudgment({
      base: {judgment: JUDGMENT.ABSENT, reason: 'r'},
      activeLeaves: [leave],
      manual: {judgment: JUDGMENT.ABSENT, event_id: 'ev1'},
    }, policy);
    assert.equal(out.needsReview, true);
    assert.match(out.reviewReason, /复核/);
  });

  test('多张请假并集生效，leaveIds 全部记录', () => {
    const out = computeFinalJudgment({
      base: {judgment: JUDGMENT.ABSENT, reason: 'r'},
      activeLeaves: [leave, {leave_id: 'lv2', leave_type: 'public'}],
    }, policy);
    assert.equal(out.final, JUDGMENT.LEAVE);
    assert.deepEqual(out.leaveIds, ['lv1', 'lv2']);
  });

  test('无请假无人工结论时等于基础结果', () => {
    for (const j of Object.values(JUDGMENT)) {
      if (j === JUDGMENT.LEAVE) continue;
      assert.equal(computeFinalJudgment({base: {judgment: j, reason: 'r'}}, policy).final, j);
    }
  });
});

describe('请假覆盖范围', () => {
  test('periods 为空代表全天', () => {
    const lv = {start_date: '2026-09-07', end_date: '2026-09-08', periods: []};
    assert.equal(leaveCovers(lv, {att_date: '2026-09-07', period: 1}), true);
    assert.equal(leaveCovers(lv, {att_date: '2026-09-08', period: 12}), true);
    assert.equal(leaveCovers(lv, {att_date: '2026-09-09', period: 1}), false);
  });

  test('指定节次按日期范围内每天相同节次生效', () => {
    const lv = {start_date: '2026-09-07', end_date: '2026-09-09', periods: [3, 4]};
    assert.equal(leaveCovers(lv, {att_date: '2026-09-08', period: 3}), true);
    assert.equal(leaveCovers(lv, {att_date: '2026-09-08', period: 5}), false);
  });
});

describe('历史记录稳定性（AT-019）', () => {
  test('固定业务日期不随系统日期变化', () => {
    setupWorld();
    const r = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 3});
    const stored = Table.get('attendance', r.attendance_id);
    assert.equal(stored.att_date, '2026-09-07');
    assert.equal(stored.rule_version, r.rule_version);
    // 再读一次，结果不因时间流逝改变
    assert.equal(Table.get('attendance', r.attendance_id).final_judgment, stored.final_judgment);
  });
});
