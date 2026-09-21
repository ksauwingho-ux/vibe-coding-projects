// 请假流程测试。覆盖 03 §4 与 06 阶段 D 点名要演示的场景。

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, mkAttendance, principalOf, Table} from './fixtures.js';
import {submitLeave, projectLeaveApproval, requestRevoke, projectRevokeApproval, getLeave, listMyLeaves} from '../src/domain/leave.js';
import {Approval} from '../src/adapters/approval.js';
import {ingestApprovalEvents, runOnce} from '../src/jobs/worker.js';
import {createExcelSource} from '../src/ingestion/sources/excel-file.js';

let world;
beforeEach(() => { world = setupWorld(); });

/** 走完"提交 -> 辅导员批准 -> 事件摄取 -> 生效"的完整链路 */
async function approveLeave(leaveId, approverUserId) {
  const leave = Table.get('leave_request', leaveId);
  const decided = Approval.decide(leave.external_instance_id, {
    actorUserId: approverUserId, decision: 'approved', comment: '同意',
  });
  assert.equal(decided.ok, true, '审批平台应接受该决定');
  ingestApprovalEvents();
  return runOnce();
}

describe('请假申请与生效', () => {
  test('批准后覆盖基础旷课，迟到不受影响', async () => {
    const absent = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1, rawResult: '旷课'});
    const late = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 2, rawResult: '迟到', rawWay: 'istudy'});
    assert.equal(absent.final_judgment, '旷课');
    assert.equal(late.final_judgment, '迟到');

    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: '家中有事',
    });
    await approveLeave(leaveId, 'u_counselor_t1');

    assert.equal(Table.get('attendance', absent.attendance_id).final_judgment, '请假');
    assert.equal(Table.get('attendance', late.attendance_id).final_judgment, '迟到', '迟到不被请假消除');
  });

  test('先请假后接入：接入时即匹配已批准请假', async () => {
    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-10', endDate: '2026-09-10',
      periods: [5], reason: '先请假',
    });
    await approveLeave(leaveId, 'u_counselor_t1');

    // 请假生效后才产生的考勤，应在写入时就是"请假"
    const {ingest} = await import('../src/ingestion/pipeline.js');
    const source = fakeSource([{
      name_raw: '学生甲一', class_raw: '测试甲班', course_raw: '测试课',
      teacher_raw: '张', period_raw: '5', room_raw: 'A1', week_raw: '1',
      sign_time_raw: '', raw_result: '旷课', raw_way: '', att_date_raw: '2026-09-10',
    }]);
    const out = await ingest(source, {operatorId: 'u_counselor_t1', termId: '2026-2027-1'});
    assert.equal(out.report.inserted_rows, 1);
    const rec = Table.all('attendance', {where: {student_id: 'stu_a1', att_date: '2026-09-10'}})[0];
    assert.equal(rec.final_judgment, '请假');
  });

  test('病假必须上传证明材料', () => {
    assert.throws(() => submitLeave(world.a1, {
      leaveType: 'sick', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: '生病', evidenceRefs: [],
    }), /证明材料/);
  });

  test('节次必须是 1—12 的整数', () => {
    assert.throws(() => submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [0, 13], reason: 'x',
    }), /1—12/);
  });

  test('审批通过但回写前，状态显示"同步中"而非全部完成', () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'x',
    });
    Table.updateRecord('leave_request', leaveId, {approval_status: 'approved', apply_status: 'applying'});
    const view = getLeave(world.a1, leaveId);
    assert.equal(view.approval_status, 'approved');
    assert.notEqual(view.apply_status, 'applied');
    assert.match(view.sync_warning, /同步中/);
    assert.match(view.status_label, /同步中/);
  });
});

describe('多人公假', () => {
  test('普通学生不能发起多人公假', () => {
    assert.throws(() => submitLeave(world.a1, {
      leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: '比赛', memberStudentIds: ['stu_a1', 'stu_a2'],
    }), /学生干部或辅导员/);
  });

  test('学生干部可发起，且人员限制在授权范围内', () => {
    const out = submitLeave(world.cadre, {
      leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: '院级比赛', memberStudentIds: ['stu_a1', 'stu_a2'],
    });
    assert.equal(out.members, 2);

    assert.throws(() => submitLeave(world.cadre, {
      leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: 'x', memberStudentIds: ['stu_b1'],
    }), /无权发起/);
  });

  test('跨辅导员范围提示拆单（D22）', () => {
    // 给干部甲加乙班授权，构造跨辅导员名单
    const {grant} = { grant: (u, r, st, si) => Table.insert('role_assignment', {
      assignment_id: `role_x_${Math.random()}`, tenant_id: 'tenant_school', wps_user_id: u,
      role: r, scope_type: st, scope_id: si, valid_from: '2026-09-01', valid_to: null,
      enabled: 1, assigned_by: 'test',
    })};
    grant('u_stu_ac', 'student_cadre', 'class', 'cls_test_b');
    const cadre = principalOf('u_stu_ac');

    try {
      submitLeave(cadre, {
        leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07',
        periods: [], reason: 'x', memberStudentIds: ['stu_a1', 'stu_b1'],
      });
      assert.fail('应要求拆单');
    } catch (err) {
      assert.equal(err.code, 'SPLIT_REQUIRED');
      assert.equal(err.detail.groups.length, 2);
    }
  });

  test('部分失败时不把整单标为全部已应用', async () => {
    mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    // stu_a2 没有当日考勤 -> 影响 0 条，但不应导致整单失败
    const {leave_id: leaveId} = submitLeave(world.cadre, {
      leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: '比赛', memberStudentIds: ['stu_a1', 'stu_a2'],
    });
    await approveLeave(leaveId, 'u_counselor_t1');

    const detail = getLeave(world.cadre, leaveId);
    const a1 = detail.members.find((m) => m.student_id === 'stu_a1');
    const a2 = detail.members.find((m) => m.student_id === 'stu_a2');
    assert.equal(a1.affected_record_count, 1);
    assert.equal(a2.affected_record_count, 0);
    assert.equal(detail.apply_status, 'applied');
  });
});

describe('事件去重与乱序（阶段 D 必演示项）', () => {
  test('同一批准事件收到两次只生效一次', async () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'x',
    });
    const leave = Table.get('leave_request', leaveId);
    Approval.decide(leave.external_instance_id, {actorUserId: 'u_counselor_t1', decision: 'approved'});

    const first = ingestApprovalEvents();
    await runOnce();
    const afterFirst = Table.get('attendance', rec.attendance_id);
    assert.equal(afterFirst.final_judgment, '请假');
    const revisionAfterFirst = afterFirst.business_revision;

    // 重投同一事件
    const outbox = Table.all('approval_outbox', {where: {instance_id: leave.external_instance_id}, limit: 10});
    const approvedEvent = outbox.find((o) => o.event_type === 'instance_approved');
    Approval.redeliverForTest(approvedEvent.outbox_id);
    const second = ingestApprovalEvents();
    await runOnce();

    assert.equal(second.duplicate, 1, '重复事件应被幂等键识别');
    assert.equal(Table.get('attendance', rec.attendance_id).business_revision, revisionAfterFirst,
      '重复事件不得再次改判');
    assert.ok(first.accepted >= 1);
  });

  test('旧版本事件（乱序）被丢弃', async () => {
    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'x',
    });
    const leave = Table.get('leave_request', leaveId);
    Approval.decide(leave.external_instance_id, {actorUserId: 'u_counselor_t1', decision: 'approved'});
    ingestApprovalEvents();
    await runOnce();

    const out = await projectLeaveApproval(leaveId, {eventId: 'stale', sourceVersion: 1});
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'STALE_OR_DUPLICATE');
  });
});

describe('请假撤销', () => {
  test('撤销待确认时原请假仍然有效', async () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const {leave_id: leaveId} = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'x',
    });
    await approveLeave(leaveId, 'u_counselor_t1');
    assert.equal(Table.get('attendance', rec.attendance_id).final_judgment, '请假');

    const out = requestRevoke(world.a1, leaveId, '不需要请假了');
    assert.equal(out.revoke_status, 'requested');
    assert.equal(Table.get('attendance', rec.attendance_id).final_judgment, '请假',
      '撤销确认前不得恢复为旷课');
  });

  test('两张请假撤销一张，剩余有效单仍然生效', async () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const l1 = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: '第一张',
    });
    await approveLeave(l1.leave_id, 'u_counselor_t1');
    const l2 = submitLeave(world.a1, {
      leaveType: 'public', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: '第二张',
    });
    await approveLeave(l2.leave_id, 'u_counselor_t1');

    const after = Table.get('attendance', rec.attendance_id);
    assert.equal(after.final_judgment, '请假');
    assert.equal(JSON.parse(after.leave_ids).length, 2, '两张请假并集生效');

    // 撤销第一张并确认
    requestRevoke(world.a1, l1.leave_id, '撤销第一张');
    const lv1 = Table.get('leave_request', l1.leave_id);
    Approval.decide(lv1.revoke_instance_id, {actorUserId: 'u_counselor_t1', decision: 'approved'});
    await projectRevokeApproval(l1.leave_id, {eventId: 'rev1'});

    const final = Table.get('attendance', rec.attendance_id);
    assert.equal(final.final_judgment, '请假', '还有一张有效请假，不能直接恢复为旷课');
    assert.deepEqual(JSON.parse(final.leave_ids), [l2.leave_id]);
  });

  test('撤销最后一张后恢复为基础判定', async () => {
    const rec = mkAttendance({studentId: 'stu_a1', classId: 'cls_test_a', attDate: '2026-09-07', period: 1});
    const l1 = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'x',
    });
    await approveLeave(l1.leave_id, 'u_counselor_t1');
    requestRevoke(world.a1, l1.leave_id, '撤销');
    const lv = Table.get('leave_request', l1.leave_id);
    Approval.decide(lv.revoke_instance_id, {actorUserId: 'u_counselor_t1', decision: 'approved'});
    await projectRevokeApproval(l1.leave_id, {eventId: 'rev1'});

    assert.equal(Table.get('attendance', rec.attendance_id).final_judgment, '旷课');
  });
});

describe('身份与只读字段', () => {
  test('申请人身份取自登录态，表单手填身份被忽略', () => {
    const out = submitLeave(world.a1, {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: 'x',
      // 这些字段即使传进来也不被采用
      applicant_user_id: 'u_counselor_t1', student_id: 'stu_b1', name: '别人',
    });
    const leave = Table.get('leave_request', out.leave_id);
    assert.equal(leave.applicant_user_id, world.a1.user_id);
    const members = Table.all('leave_member', {where: {leave_id: out.leave_id}});
    assert.equal(members.length, 1);
    assert.equal(members[0].student_id, 'stu_a1');
  });

  test('同一 submission 重复提交返回同一单号', () => {
    const args = {
      leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07',
      periods: [], reason: 'x', submissionId: 'sub_fixed_1',
    };
    const first = submitLeave(world.a1, args);
    const second = submitLeave(world.a1, args);
    assert.equal(second.leave_id, first.leave_id);
    assert.equal(second.duplicate_submission, true);
  });

  test('我的申请只返回与本人相关的单据', () => {
    submitLeave(world.a1, {leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'a1'});
    submitLeave(world.b1, {leaveType: 'personal', startDate: '2026-09-07', endDate: '2026-09-07', periods: [], reason: 'b1'});
    const mine = listMyLeaves(world.a1);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].reason, 'a1');
  });
});

/** 构造一个内存来源，验证"下游与来源无关"。 */
function fakeSource(records) {
  return {
    async describe() {
      return {
        source_type: 'excel_file', source_system: 'test_source',
        source_ref: 'memory', source_digest: `d_${Math.random()}`,
        columns: [], total_rows: records.length,
      };
    },
    async* read() {
      yield records.map((r, i) => ({source_row_number: i + 1, source_record_id: null, ...r}));
    },
  };
}
