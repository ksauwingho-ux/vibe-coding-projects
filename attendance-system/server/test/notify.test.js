// 消息与日报测试。覆盖 03 §8 的全部硬约束。

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, mkAttendance, Table} from './fixtures.js';
import {
  buildStudentDailyDigest, buildCounselorDailyDigest, flushNotifications,
  notifyCorrection, notifySupplementalImport,
} from '../src/domain/notify.js';
import {whitelist, faultInjection} from '../src/adapters/message.js';
import {setPolicy} from '../src/domain/policy.js';
import {nowUtc} from '../src/lib/util.js';

let world;
beforeEach(() => {
  world = setupWorld();
  whitelist.clear();
  faultInjection.failFor.clear();
  faultInjection.unknownFor.clear();
  setPolicy('notify.whitelist_only', 'false');   // 测试里放开白名单，单独用例验证白名单本身
});

describe('学生个人日报', () => {
  test('只发当日有本人记录的学生，且只发本人', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 2, rawResult: '正常', rawWay: '刷脸'});
    mkAttendance({studentId: 'stu_a2', classId: 'cls_test_a', attDate: '2026-09-08', period: 1, rawResult: '旷课'});

    const out = buildStudentDailyDigest('2026-09-07');
    assert.equal(out.students, 1, '只有 stu_a1 当日有记录');
    const notes = Table.all('notification', {where: {kind: 'student_daily'}});
    assert.equal(notes.length, 1);
    assert.equal(notes[0].receiver_user_id, 'u_stu_a1');
    assert.equal(notes[0].student_id, 'stu_a1');
  });

  test('正文包含六类结果与异常明细', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 5, courseName: '高等数学', rawResult: '旷课'});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 6, rawResult: '正常', rawWay: '刷脸'});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 7, rawResult: '正常', rawWay: ''});
    buildStudentDailyDigest('2026-09-07');

    const note = Table.all('notification', {where: {kind: 'student_daily'}})[0];
    const body = JSON.parse(note.payload_ref).body;
    assert.match(body, /已导入 3 节/);
    assert.match(body, /正常 1 节/);
    assert.match(body, /旷课 1 节/);
    assert.match(body, /待核实 1 节/);
    assert.match(body, /第 5 节《高等数学》/);
  });

  test('数据未齐必须注明结果可能更新', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    buildStudentDailyDigest('2026-09-07');
    const body = JSON.parse(Table.all('notification', {where: {kind: 'student_daily'}})[0].payload_ref).body;
    assert.match(body, /当日数据尚未齐全，结果可能更新/);
  });

  test('辅导员确认数据齐全后不再提示未齐', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    Table.insert('data_coverage', {
      coverage_id: 'cov1', tenant_id: 'tenant_school', class_id: 'cls_test_a',
      att_date: '2026-09-07', coverage_status: 'complete',
      confirmed_by: 'u_counselor_t1', confirmed_at: nowUtc(), note: null,
    });
    buildStudentDailyDigest('2026-09-07');
    const body = JSON.parse(Table.all('notification', {where: {kind: 'student_daily'}})[0].payload_ref).body;
    assert.doesNotMatch(body, /尚未齐全/);
  });

  test('没有当日数据时不发日报，并提醒数据管理员', () => {
    const out = buildStudentDailyDigest('2026-09-07');
    assert.equal(out.students, 0);
    assert.equal(out.alert_data_manager, true);
    assert.match(out.note, /未导入/);
    assert.equal(Table.count('notification', {kind: 'student_daily'}), 0, '不得用旧日报冒充今日');
  });

  test('相同内容重复生成不重复发送', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const first = buildStudentDailyDigest('2026-09-07');
    const second = buildStudentDailyDigest('2026-09-07');
    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    assert.equal(second.deduped, 1);
    assert.equal(Table.count('notification', {kind: 'student_daily'}), 1);
  });

  test('结果变化产生新版本，允许再次发送', () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    buildStudentDailyDigest('2026-09-07');
    Table.updateRecord('attendance', rec.attendance_id, {final_judgment: '正常'});
    const second = buildStudentDailyDigest('2026-09-07');
    assert.equal(second.queued, 1, '结果变化后属于新版本');
  });
});

describe('发送与失败处理', () => {
  test('白名单之外的接收人被跳过', () => {
    setPolicy('notify.whitelist_only', 'true');
    whitelist.add('u_stu_a2');
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    buildStudentDailyDigest('2026-09-07');
    const out = flushNotifications();
    assert.equal(out.skipped, 1);
    assert.equal(out.sent, 0);
  });

  test('发送失败进入重试，不回滚考勤', () => {
    faultInjection.failFor.add('u_stu_a1');
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    buildStudentDailyDigest('2026-09-07');
    const out = flushNotifications();
    assert.equal(out.failed, 1);

    const note = Table.all('notification', {where: {kind: 'student_daily'}})[0];
    assert.equal(note.status, 'failed');
    assert.ok(note.next_retry_at, '应安排重试');
    assert.equal(Table.get('attendance', rec.attendance_id).final_judgment, '旷课', '考勤不受影响');
  });

  test('结果未知单列，不自动重发', () => {
    faultInjection.unknownFor.add('u_stu_a1');
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    buildStudentDailyDigest('2026-09-07');
    const out = flushNotifications();
    assert.equal(out.unknown, 1);

    const note = Table.all('notification', {where: {kind: 'student_daily'}})[0];
    assert.equal(note.status, 'unknown');
    assert.equal(note.next_retry_at, null, 'unknown 不安排自动重发');

    const again = flushNotifications();
    assert.equal(again.sent + again.unknown + again.failed, 0, 'unknown 不进入下一轮发送');
  });

  test('IM 接收人无法映射时登记为跳过，不找人代发', () => {
    // 去掉 IM 映射
    Table.updateRecord('directory_user', 'u_stu_a1', {im_user_id: null});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    buildStudentDailyDigest('2026-09-07');
    const out = flushNotifications();
    assert.equal(out.failed, 1);
    const note = Table.all('notification', {where: {kind: 'student_daily'}})[0];
    assert.equal(note.last_error, 'IM_RECEIVER_UNRESOLVED');
    assert.equal(note.receiver_user_id, 'u_stu_a1', '不改投他人');
  });

  test('学生身份未映射时消息登记为跳过', () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    Table.remove('identity_link', Table.findOne('identity_link', {student_id: 'stu_a1'}).link_id);
    buildStudentDailyDigest('2026-09-07');
    const note = Table.all('notification', {where: {kind: 'student_daily'}})[0];
    assert.equal(note.status, 'skipped');
    assert.equal(note.last_error, 'RECEIVER_UNRESOLVED');
  });
});

describe('辅导员日报', () => {
  test('按负责班级汇总，含待处理申诉与数据完整性', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    mkAttendance({studentId: 'stu_a2', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '正常', rawWay: '刷脸'});
    const out = buildCounselorDailyDigest('2026-09-07');
    assert.ok(out.queued >= 1);

    const note = Table.all('notification', {where: {kind: 'counselor_daily', receiver_user_id: 'u_counselor_t1'}})[0];
    const body = JSON.parse(note.payload_ref).body;
    assert.match(body, /共 2 节/);
    assert.match(body, /旷课 1/);
    assert.match(body, /数据完整性未确认/);
  });

  test('辅导员只收到本人负责班级的汇总', () => {
    mkAttendance({studentId: 'stu_b1', classId: 'cls_test_b', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    buildCounselorDailyDigest('2026-09-07');
    const t1 = Table.all('notification', {where: {kind: 'counselor_daily', receiver_user_id: 'u_counselor_t1'}});
    const t2 = Table.all('notification', {where: {kind: 'counselor_daily', receiver_user_id: 'u_counselor_t2'}});
    assert.equal(t1.length, 0, '甲班辅导员当日无数据，不发');
    assert.equal(t2.length, 1);
  });
});

describe('更正与补充通知', () => {
  test('日报已发后结果变化，发独立的更正通知', () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 3, rawResult: '旷课'});
    buildStudentDailyDigest('2026-09-07');
    flushNotifications();

    const out = notifyCorrection(Table.get('attendance', rec.attendance_id), {
      fromJudgment: '旷课', toJudgment: '正常', reason: '申诉成立',
    });
    assert.notEqual(out.skipped, true);
    const note = Table.all('notification', {where: {kind: 'correction'}})[0];
    assert.match(JSON.parse(note.payload_ref).body, /由「旷课」更正为「正常」/);
  });

  test('日报尚未发送时不发更正通知', () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 3});
    const out = notifyCorrection(rec, {fromJudgment: '旷课', toJudgment: '正常', reason: 'x'});
    assert.equal(out.skipped, true);
    assert.equal(Table.count('notification', {kind: 'correction'}), 0);
  });

  test('补导历史数据发带真实日期的补充通知，不混入今日日报', () => {
    notifySupplementalImport('2026-09-01', ['stu_a1']);
    const note = Table.all('notification', {where: {kind: 'supplemental_import'}})[0];
    assert.equal(note.business_date, '2026-09-01');
    assert.match(JSON.parse(note.payload_ref).body, /非今日/);
    assert.notEqual(note.kind, 'student_daily');
  });
});
