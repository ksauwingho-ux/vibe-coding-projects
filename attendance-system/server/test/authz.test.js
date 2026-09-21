// 权限与核对测试。覆盖 03 §3、§6 与验收用例 AT-005~AT-011、AT-018。

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, mkAttendance, principalOf, grant, Table} from './fixtures.js';
import {listAttendance, getAttendanceDetail, getScopeSummary} from '../src/domain/attendance.js';
import {listVerificationQueue, verifyOne, verifyBatch, listCounselorReviewQueue} from '../src/domain/review.js';
import {manageableClassIds, assertCanExport, canReadEvidence} from '../src/domain/authz.js';
import {submitAppeal} from '../src/domain/appeal.js';

let world;
beforeEach(() => { world = setupWorld(); });

describe('数据隔离（AT-005/006/008）', () => {
  test('学生不能通过改 ID 读他人考勤', () => {
    const other = mkAttendance({studentId: 'stu_a2', classId: 'cls_test_a'});
    assert.throws(() => getAttendanceDetail(world.a1, other.attendance_id), /无权|不存在/);
  });

  test('副班长只能看授权班级，看不到他班', () => {
    mkAttendance({studentId: 'stu_b1', classId: 'cls_test_b'});
    assert.deepEqual(manageableClassIds(world.monitor), ['cls_test_a']);
    assert.throws(() => listAttendance(world.monitor, {scope_type: 'class', scope_id: 'cls_test_b'}), /无权/);
  });

  test('技术管理员没有默认业务权限（AT-008）', () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a'});
    assert.equal(world.admin.hasBusinessRole, false);
    assert.throws(() => getAttendanceDetail(world.admin, rec.attendance_id), /无权/);
    assert.deepEqual(manageableClassIds(world.admin), []);
  });

  test('未映射学生身份的账号被拒绝，不能输入别人学号取数', () => {
    Table.insert('directory_user', {
      wps_user_id: 'u_unknown', tenant_id: 'tenant_school', display_name: '未映射',
      department: null, title: null, im_user_id: null, active: 1, source: 'test',
    });
    const p = principalOf('u_unknown');
    assert.equal(p.student_id, null);
    assert.throws(() => listAttendance(p, {scope_type: 'self'}), /尚未关联学生身份/);
  });

  test('导出权限与查询范围一致', () => {
    assert.doesNotThrow(() => assertCanExport(world.monitor, {scopeType: 'class', scopeId: 'cls_test_a'}));
    assert.throws(() => assertCanExport(world.monitor, {scopeType: 'class', scopeId: 'cls_test_b'}), /无权/);
    assert.throws(() => assertCanExport(world.a1, {scopeType: 'class', scopeId: 'cls_test_a'}), /无权/);
    assert.doesNotThrow(() => assertCanExport(world.a1, {scopeType: 'self', scopeId: 'stu_a1'}));
  });
});

describe('角色有效期（AT-010）', () => {
  test('授权已到期的角色不再生效', () => {
    grant('u_stu_a2', 'monitor', 'class', 'cls_test_a', {validTo: '2026-09-05'});
    const p = principalOf('u_stu_a2');
    assert.equal(p.roles.has('monitor'), false, '过期授权不应出现在有效角色中');
    assert.deepEqual(manageableClassIds(p), []);
  });
});

describe('病假证据可见性（D19 / AT-007）', () => {
  test('普通同学与副班长默认看不到病假证据，本人和辅导员可以', () => {
    const evidence = {
      evidence_id: 'ev1', owner_student_id: 'stu_a1',
      sensitivity: 'restricted', business_type: 'leave',
    };
    assert.equal(canReadEvidence(world.a1, evidence), true, '本人可看');
    assert.equal(canReadEvidence(world.a2, evidence), false, '同学不可看');
    assert.equal(canReadEvidence(world.monitor, evidence), false, '副班长不可看');
    assert.equal(canReadEvidence(world.cadre, evidence), false, '学生干部不可看');
    assert.equal(canReadEvidence(world.counselorA, evidence), true, '辅导员可看');
  });
});

describe('待处理核对（03 §3）', () => {
  function pendingRecord(studentId = 'stu_a1', period = 1) {
    return mkAttendance({
      studentId, classId: 'cls_test_a', period, rawResult: '正常', rawWay: '',
    });
  }

  test('只有基础判定为待处理的记录进队列', () => {
    pendingRecord('stu_a1', 1);
    mkAttendance({studentId: 'stu_a2', classId: 'cls_test_a', period: 2, rawResult: '旷课'});
    const q = listVerificationQueue(world.monitor);
    assert.equal(q.items.length, 1);
    assert.match(q.items[0].pending_reason, /方式为空/);
  });

  test('防自审：本人记录不能自核对，并给出转交对象（D18）', async () => {
    const mine = pendingRecord('stu_am', 1);
    const q = listVerificationQueue(world.monitor);
    const item = q.items.find((i) => i.attendance_id === mine.attendance_id);
    assert.equal(item.can_verify, false);
    assert.match(item.blocked_reason, /本人/);
    assert.equal(item.escalate_to, 'u_counselor_t1');

    await assert.rejects(
      verifyOne(world.monitor, {
        attendanceId: mine.attendance_id, action: 'confirm_present', note: '我到了',
      }),
      /不能核对本人记录/,
    );
  });

  test('核对说明必填', async () => {
    const rec = pendingRecord();
    await assert.rejects(
      verifyOne(world.monitor, {attendanceId: rec.attendance_id, action: 'confirm_present', note: '  '}),
      /说明必填/,
    );
  });

  test('确认到场 -> 正常；确认缺勤 -> 旷课，并留判定事件', async () => {
    const r1 = pendingRecord('stu_a1', 1);
    const r2 = pendingRecord('stu_a2', 2);
    await verifyOne(world.monitor, {attendanceId: r1.attendance_id, action: 'confirm_present', note: '教师确认到场'});
    await verifyOne(world.monitor, {attendanceId: r2.attendance_id, action: 'confirm_absent', note: '确认未到'});

    assert.equal(Table.get('attendance', r1.attendance_id).final_judgment, '正常');
    assert.equal(Table.get('attendance', r2.attendance_id).final_judgment, '旷课');
    const events = Table.all('review_event', {where: {attendance_id: r1.attendance_id}});
    assert.ok(events.some((e) => e.action === 'pending_confirm' && e.active === 1));
  });

  test('版本冲突：已被他人处理则拒绝覆盖', async () => {
    const rec = pendingRecord();
    await verifyOne(world.monitor, {
      attendanceId: rec.attendance_id, action: 'confirm_present', note: '先处理',
    });
    await assert.rejects(
      verifyOne(world.cadre, {
        attendanceId: rec.attendance_id, action: 'confirm_absent', note: '再处理',
        expectedRevision: rec.business_revision,
      }),
      /已不在待核实状态|刷新/,
    );
  });

  test('批量核对逐条执行权限与防自审，不能一键全判正常', async () => {
    const mine = pendingRecord('stu_am', 1);
    const ok1 = pendingRecord('stu_a1', 2);
    const other = mkAttendance({studentId: 'stu_b1', classId: 'cls_test_b', period: 3, rawResult: '正常', rawWay: ''});

    const out = await verifyBatch(world.monitor, {
      items: [
        {attendanceId: mine.attendance_id, action: 'confirm_present'},
        {attendanceId: ok1.attendance_id, action: 'confirm_present'},
        {attendanceId: other.attendance_id, action: 'confirm_present'},
      ],
      note: '批量核对说明',
    });

    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 2);
    assert.equal(Table.get('attendance', mine.attendance_id).final_judgment, '待处理', '本人记录未被改判');
    assert.equal(Table.get('attendance', other.attendance_id).final_judgment, '待处理', '他班记录未被改判');
    assert.equal(Table.get('attendance', ok1.attendance_id).final_judgment, '正常');
  });

  test('核对后学生收到结果通知', async () => {
    const rec = pendingRecord('stu_a1', 1);
    await verifyOne(world.monitor, {
      attendanceId: rec.attendance_id, action: 'confirm_absent', note: '确认缺勤',
    });
    const notes = Table.all('notification', {where: {kind: 'verification_result'}});
    assert.equal(notes.length, 1);
    assert.equal(notes[0].receiver_user_id, 'u_stu_a1');
    assert.equal(notes[0].student_id, 'stu_a1');
  });
});

describe('统计口径（D17）', () => {
  test('异常不含待核实，需关注记录单独命名', async () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', period: 1, rawResult: '旷课'});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', period: 2, rawResult: '迟到', rawWay: 'istudy'});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', period: 3, rawResult: '正常', rawWay: ''});
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', period: 4, rawResult: '正常', rawWay: '刷脸'});
    const {rebuildStatsForDates} = await import('../src/domain/stats.js');
    rebuildStatsForDates(['2026-09-07']);

    const s = getScopeSummary(world.a1, {scope_type: 'self'});
    assert.equal(s.total_imported_periods, 4);
    assert.equal(s.abnormal_periods, 2, '旷课＋迟到');
    assert.equal(s.pending_verification_periods, 1, '待核实单列');
    assert.equal(s.needs_attention_periods, 2, '需关注 = 旷课＋待处理');
    assert.equal(s.expected_periods, null, '无权威课表时不编造应到分母');
    assert.equal(s.attendance_rate, null);
  });

  test('覆盖状态未确认时标为 unknown', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a'});
    const s = getScopeSummary(world.counselorA, {scope_type: 'class', scope_id: 'cls_test_a'});
    assert.equal(s.coverage_status, 'unknown');
    assert.match(s.coverage_note, /已导入考勤/);
  });
});

describe('辅导员复核队列', () => {
  test('仅辅导员可访问，且限于负责范围', () => {
    assert.throws(() => listCounselorReviewQueue(world.monitor), /仅辅导员/);
    const q = listCounselorReviewQueue(world.counselorA);
    assert.ok(Array.isArray(q.items));
  });
});
