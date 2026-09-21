// 有效请假索引。
//
// "有效请假"的定义（03 §2.2）：已批准、且撤销尚未确认的请假单。
// 撤销待确认时请假仍然有效 —— 只有辅导员确认撤销后才排除。
//
// 判定与接入都要按学生反复查询，因此这里维护一份内存索引，
// 任何请假状态变化都必须调用 invalidateLeaveIndex()。

import {Table} from '../adapters/table.js';
import {TENANT_ID} from '../config.js';
import {parseJson} from '../lib/util.js';
import {leaveCovers} from './rules.js';

let index = null;

export function invalidateLeaveIndex() {
  index = null;
}

function build() {
  const approved = Table.all('leave_request', {
    where: {
      tenant_id: TENANT_ID,
      approval_status: 'approved',
      revoke_status: {op: '!=', value: 'confirmed'},
    },
    limit: 100000,
  });
  const byLeaveId = new Map(approved.map((l) => [l.leave_id, {
    leave_id: l.leave_id,
    leave_type: l.leave_type,
    start_date: l.start_date,
    end_date: l.end_date,
    periods: parseJson(l.periods, []),
    approved_at: l.approved_at,
  }]));

  const byStudent = new Map();
  if (byLeaveId.size) {
    const members = Table.all('leave_member', {
      where: {tenant_id: TENANT_ID, leave_id: {op: 'in', value: [...byLeaveId.keys()]}},
      limit: 200000,
    });
    for (const m of members) {
      const leave = byLeaveId.get(m.leave_id);
      if (!leave) continue;
      if (!byStudent.has(m.student_id)) byStudent.set(m.student_id, []);
      byStudent.get(m.student_id).push(leave);
    }
  }
  return byStudent;
}

/** 返回覆盖该学生该日该节的全部有效请假单（可能多张，按并集生效）。 */
export function activeLeavesFor(studentId, attDate, period) {
  if (!index) index = build();
  const leaves = index.get(studentId);
  if (!leaves?.length) return [];
  return leaves.filter((l) => leaveCovers(l, {att_date: attDate, period}));
}

/** 某张请假单覆盖到的全部考勤记录 —— 请假批准/撤销后据此重算。 */
export function attendanceCoveredByLeave(leave, studentIds) {
  const periods = parseJson(leave.periods, []);
  const where = {
    tenant_id: TENANT_ID,
    student_id: {op: 'in', value: studentIds},
    att_date: {op: '>=', value: leave.start_date},
  };
  const rows = Table.all('attendance', {where, limit: 100000})
    .filter((r) => r.att_date <= leave.end_date)
    .filter((r) => periods.length === 0 || periods.includes(r.period));
  return rows;
}
