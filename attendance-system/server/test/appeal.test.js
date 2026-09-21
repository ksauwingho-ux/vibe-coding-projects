// 申诉流程测试。覆盖 03 §5 的路由表、防自审、七天时限、公示与锁定。

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setupWorld, mkAttendance, principalOf, grant, Table} from './fixtures.js';
import {
  submitAppeal, decideAppeal, withdrawAppeal, escalateOverdue,
  scanDeadlines, listAppealTodos, getAppeal,
} from '../src/domain/appeal.js';
import {Approval} from '../src/adapters/approval.js';
import {setPolicy} from '../src/domain/policy.js';
import {addHours, nowUtc} from '../src/lib/util.js';

let world;
beforeEach(() => { world = setupWorld(); });

function absentRecord(studentId = 'stu_a1', period = 1) {
  return mkAttendance({
    studentId, classId: 'cls_test_a', attDate: '2026-09-07', period, rawResult: '旷课',
  });
}

describe('提交条件（03 §5.1）', () => {
  test('只能申诉本人记录', () => {
    const rec = absentRecord('stu_a2');
    assert.throws(() => submitAppeal(world.a1, {
      attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['ev1'],
    }), /本人/);
  });

  test('理由和证据必填', () => {
    const rec = absentRecord();
    assert.throws(() => submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: '', evidenceRefs: ['e']}), /理由必填/);
    assert.throws(() => submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: []}), /证据必填/);
  });

  test('待处理走核对，不走申诉', () => {
    const pending = mkAttendance({
      studentId: 'stu_a1', classId: 'cls_test_a', period: 2, rawResult: '正常', rawWay: '',
    });
    assert.equal(pending.final_judgment, '待处理');
    assert.throws(() => submitAppeal(world.a1, {
      attendanceId: pending.attendance_id, reason: 'x', evidenceRefs: ['e'],
    }), /待核实记录请等待核对/);
  });

  test('早退默认关闭申诉，开启后可申诉（D08 两种配置都验）', () => {
    const early = mkAttendance({
      studentId: 'stu_a1', classId: 'cls_test_a', period: 3, rawResult: '早退', rawWay: 'istudy',
    });
    assert.throws(() => submitAppeal(world.a1, {
      attendanceId: early.attendance_id, reason: 'x', evidenceRefs: ['e'],
    }), /未开放早退申诉/);

    setPolicy('appeal.allow_early_leave', 'true');
    const out = submitAppeal(world.a1, {
      attendanceId: early.attendance_id, reason: 'x', evidenceRefs: ['e'],
    });
    assert.ok(out.appeal_id);
    setPolicy('appeal.allow_early_leave', 'false');
  });

  test('同一记录最多一张活动申诉，重复提交返回同一受理结果', () => {
    const rec = absentRecord();
    const first = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const second = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    assert.equal(second.appeal_id, first.appeal_id);
    assert.equal(second.duplicate, true);
  });

  test('驳回后可补证重新提交，历史保留', () => {
    const rec = absentRecord();
    const first = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const a = Table.get('appeal', first.appeal_id);
    Approval.decide(a.external_instance_id, {actorUserId: 'u_stu_am', decision: 'rejected', comment: '证据不足'});
    Table.updateRecord('appeal', first.appeal_id, {status: 'rejected', stage: 'done'});

    const second = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'y', evidenceRefs: ['e2']});
    assert.notEqual(second.appeal_id, first.appeal_id);
    assert.equal(Table.all('appeal', {where: {attendance_id: rec.attendance_id}}).length, 2, '历史不删');
  });
});

describe('审核路由（03 §5.2）', () => {
  test('普通学生申诉 -> 本班副班长一审', () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    assert.equal(out.stage, 'first');
    assert.equal(out.assignee, 'u_stu_am');
    assert.equal(out.assignee_role, 'monitor');
  });

  test('副班长本人申诉 -> 辅导员代审并终审，不回到本人', () => {
    const rec = absentRecord('stu_am');
    const out = submitAppeal(world.monitor, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    assert.equal(out.stage, 'counselor');
    assert.equal(out.assignee, 'u_counselor_t1');
    assert.notEqual(out.assignee, world.monitor.user_id);
  });

  test('本班无有效副班长 -> 辅导员代审，不形成无人待办', () => {
    Table.aggregate("UPDATE role_assignment SET enabled = 0 WHERE role = 'monitor'");
    const rec = absentRecord();
    const out = submitAppeal(principalOf('u_stu_a1'), {
      attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e'],
    });
    assert.equal(out.assignee, 'u_counselor_t1');
    assert.ok(out.assignee, '必须有处理人');
  });

  test('一审通过 -> 学生干部终审', () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const next = decideAppeal(world.monitor, {appealId: out.appeal_id, decision: 'approved', comment: '属实'});
    return next.then((r) => {
      assert.equal(r.stage, 'second');
      assert.equal(r.assignee, 'u_stu_ac');
    });
  });

  test('二审无可用干部 -> 辅导员代审终审', async () => {
    Table.aggregate("UPDATE role_assignment SET enabled = 0 WHERE role = 'student_cadre'");
    const rec = absentRecord();
    const out = submitAppeal(principalOf('u_stu_a1'), {
      attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e'],
    });
    const r = await decideAppeal(principalOf('u_stu_am'), {
      appealId: out.appeal_id, decision: 'approved', comment: '属实',
    });
    assert.equal(r.stage, 'counselor');
    assert.equal(r.assignee, 'u_counselor_t1');
  });

  test('学生干部本人申诉 -> 副班长一审，干部本人不参与', () => {
    const rec = absentRecord('stu_ac');
    const out = submitAppeal(world.cadre, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    assert.equal(out.assignee, 'u_stu_am');
    assert.notEqual(out.assignee, world.cadre.user_id);
  });
});

describe('防自审', () => {
  test('申请人不能审核自己的申诉', async () => {
    const rec = absentRecord('stu_am');
    const out = submitAppeal(world.monitor, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    await assert.rejects(
      decideAppeal(world.monitor, {appealId: out.appeal_id, decision: 'approved'}),
      /不能审核自己/,
    );
  });

  test('待办列表不包含自己提交的申诉', () => {
    const rec = absentRecord('stu_am');
    submitAppeal(world.monitor, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const todos = listAppealTodos(world.monitor);
    assert.equal(todos.length, 0);
  });

  test('一审人不能同时做二审', async () => {
    // 让副班长同时具备干部角色，构造潜在自审
    grant('u_stu_am', 'student_cadre', 'class', 'cls_test_a');
    const monitor = principalOf('u_stu_am');
    const rec = absentRecord();
    const out = submitAppeal(principalOf('u_stu_a1'), {
      attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e'],
    });
    const r = await decideAppeal(monitor, {appealId: out.appeal_id, decision: 'approved', comment: 'ok'});
    assert.notEqual(r.assignee, 'u_stu_am', '一审人不得成为二审人');
  });
});

describe('一审七天时限（03 §5.3）', () => {
  test('超时后旧页面提交被拒绝', async () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    // 把截止时刻拨到过去，模拟七天已过
    Table.updateRecord('appeal', out.appeal_id, {first_deadline: addHours(nowUtc(), -1)});

    await assert.rejects(
      decideAppeal(world.monitor, {appealId: out.appeal_id, decision: 'approved', comment: 'ok'}),
      /时限已过|处理权已失效/,
    );
    const after = Table.get('appeal', out.appeal_id);
    assert.equal(after.stage, 'counselor', '应已转辅导员代审');
    assert.equal(after.current_assignee, 'u_counselor_t1');
  });

  test('转办后原一审人在审批平台侧也被拒', async () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const escalated = await escalateOverdue(out.appeal_id, '超时');
    assert.equal(escalated.escalated, true);
    assert.equal(escalated.old_task_invalidated, true);

    const appeal = Table.get('appeal', out.appeal_id);
    const platform = Approval.decide(appeal.external_instance_id, {
      actorUserId: 'u_stu_am', decision: 'approved',
    });
    assert.equal(platform.ok, false);
    assert.equal(platform.code, 'NOT_CURRENT_ASSIGNEE');
  });

  test('定时巡检自动转办超时申诉', async () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    Table.updateRecord('appeal', out.appeal_id, {first_deadline: addHours(nowUtc(), -1)});
    const scan = await scanDeadlines();
    assert.equal(scan.escalated, 1);
  });
});

describe('终审生效、公示与锁定', () => {
  async function approveToEnd(recordId, studentPrincipal) {
    const out = submitAppeal(studentPrincipal, {attendanceId: recordId, reason: 'x', evidenceRefs: ['e']});
    await decideAppeal(principalOf('u_stu_am'), {appealId: out.appeal_id, decision: 'approved', comment: '一审属实'});
    const final = await decideAppeal(principalOf('u_stu_ac'), {appealId: out.appeal_id, decision: 'approved', comment: '终审通过'});
    return {appealId: out.appeal_id, final};
  }

  test('终审通过后考勤更正为正常并开始公示', async () => {
    const rec = absentRecord();
    const {final} = await approveToEnd(rec.attendance_id, world.a1);
    assert.equal(final.apply_status, 'applied');

    const after = Table.get('attendance', rec.attendance_id);
    assert.equal(after.final_judgment, '正常');
    assert.ok(after.public_until, '应有公示截止时间');
    assert.match(final.note, /实际更正生效时起算/);
  });

  test('公示起算自实际生效，终审时间单独保留（D16）', async () => {
    const rec = absentRecord();
    const {appealId, final} = await approveToEnd(rec.attendance_id, world.a1);
    const appeal = Table.get('appeal', appealId);
    assert.ok(appeal.final_at, '保留轻审批终审时间');
    assert.ok(appeal.public_until);
    assert.ok(Date.parse(appeal.public_until) >= Date.parse(final.effective_at));
  });

  test('公示期内不开平行申诉（D23）', async () => {
    const rec = absentRecord();
    await approveToEnd(rec.attendance_id, world.a1);
    assert.throws(() => submitAppeal(world.a1, {
      attendanceId: rec.attendance_id, reason: 'y', evidenceRefs: ['e2'],
    }), /公示期内|申请复核/);
  });

  test('公示到期后锁定，锁定后只能辅导员复核', async () => {
    const rec = absentRecord();
    await approveToEnd(rec.attendance_id, world.a1);
    Table.updateRecord('attendance', rec.attendance_id, {public_until: addHours(nowUtc(), -1)});
    const scan = await scanDeadlines();
    assert.equal(scan.locked, 1);

    const locked = Table.get('attendance', rec.attendance_id);
    assert.ok(locked.locked_at);
    assert.throws(() => submitAppeal(world.a1, {
      attendanceId: rec.attendance_id, reason: 'z', evidenceRefs: ['e3'],
    }), /锁定|辅导员复核/);
  });

  test('锁定后的自动改判转为复核任务，不直接改判（D21）', async () => {
    const rec = absentRecord();
    await approveToEnd(rec.attendance_id, world.a1);
    Table.updateRecord('attendance', rec.attendance_id, {public_until: addHours(nowUtc(), -1)});
    await scanDeadlines();

    const before = Table.get('attendance', rec.attendance_id);
    const {applyJudgment} = await import('../src/domain/writer.js');
    const out = await applyJudgment(rec.attendance_id, {
      eventId: 'auto_1', action: 'leave_apply', reason: '模拟请假联动',
      operatorUserId: 'system', isAutomatic: true,
    });

    assert.equal(out.applied, false);
    assert.equal(out.reason, 'LOCKED_DEFERRED_TO_REVIEW');
    const after = Table.get('attendance', rec.attendance_id);
    assert.equal(after.final_judgment, before.final_judgment, '结果不变');
    assert.equal(after.needs_review, 1, '转为复核任务');
  });

  test('终审通过后不能以撤回还原结果', async () => {
    const rec = absentRecord();
    const {appealId} = await approveToEnd(rec.attendance_id, world.a1);
    assert.throws(() => withdrawAppeal(world.a1, appealId, '反悔'), /已终审/);
    assert.equal(Table.get('attendance', rec.attendance_id).final_judgment, '正常');
  });

  test('申诉期间记录被并发更新 -> 进入复核而非覆盖', async () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    await decideAppeal(world.monitor, {appealId: out.appeal_id, decision: 'approved', comment: 'ok'});

    // 模拟期间被其他流程改动，版本前进
    Table.updateRecord('attendance', rec.attendance_id, {
      business_revision: rec.business_revision + 5, updated_at: nowUtc(),
    });
    const final = await decideAppeal(world.cadre, {appealId: out.appeal_id, decision: 'approved', comment: '终审'});

    assert.equal(final.reason, 'CONCURRENT_CHANGE_NEEDS_REVIEW');
    assert.equal(final.apply_status, 'failed');
    assert.equal(Table.get('attendance', rec.attendance_id).needs_review, 1);
  });
});

describe('撤回与状态展示', () => {
  test('未终审可撤回，审批实例同步作废', () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    const r = withdrawAppeal(world.a1, out.appeal_id, '不申诉了');
    assert.equal(r.status, 'withdrawn');
    assert.equal(r.approval_instance_cancelled, true);

    const appeal = Table.get('appeal', out.appeal_id);
    const state = Approval.fetchState(appeal.external_instance_id);
    assert.equal(state.state, 'cancelled');
  });

  test('审批状态与考勤更正状态分开展示', () => {
    const rec = absentRecord();
    const out = submitAppeal(world.a1, {attendanceId: rec.attendance_id, reason: 'x', evidenceRefs: ['e']});
    Table.updateRecord('appeal', out.appeal_id, {status: 'approved', apply_status: 'applying'});
    const view = getAppeal(world.a1, out.appeal_id);
    assert.equal(view.approval_status, 'approved');
    assert.equal(view.attendance_corrected, false);
    assert.match(view.status_label, /同步中/);
  });
});
