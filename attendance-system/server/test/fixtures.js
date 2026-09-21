// 测试夹具：虚构的两名学生、一名副班长、一名干部、一名辅导员。
// 严禁使用真实学生姓名作为测试人（docs/baseline/06 阶段 B 要求）。

import {openDb, closeDb} from '../src/db/index.js';
import {Table} from '../src/adapters/table.js';
import {Identity} from '../src/adapters/identity.js';
import {buildPrincipal} from '../src/domain/authz.js';
import {invalidateLeaveIndex} from '../src/domain/leave-index.js';
import {newId, nowUtc} from '../src/lib/util.js';
import {TENANT_ID, COLLEGE_ID, DEFAULT_TERM} from '../src/config.js';
import {computeBaseJudgment, computeFinalJudgment, RULE_VERSION} from '../src/domain/rules.js';
import {rulePolicySnapshot} from '../src/domain/policy.js';

export const CLASS_A = 'cls_test_a';
export const CLASS_B = 'cls_test_b';

export function setupWorld() {
  closeDb();
  openDb(':memory:');
  invalidateLeaveIndex();

  mkClass(CLASS_A, '测试甲班', 'u_counselor_t1');
  mkClass(CLASS_B, '测试乙班', 'u_counselor_t2');

  mkUser('u_counselor_t1', '辅导甲', '学工办', '辅导员');
  mkUser('u_counselor_t2', '辅导乙', '学工办', '辅导员');
  grant('u_counselor_t1', 'counselor', 'college', COLLEGE_ID);
  grant('u_counselor_t1', 'counselor', 'class', CLASS_A);
  grant('u_counselor_t2', 'counselor', 'college', COLLEGE_ID);
  grant('u_counselor_t2', 'counselor', 'class', CLASS_B);

  // 甲班：学生甲一（普通）、甲二（普通）、班甲（副班长）、干甲（学生干部）
  mkStudent('stu_a1', 'T0001', '学生甲一', CLASS_A);
  mkStudent('stu_a2', 'T0002', '学生甲二', CLASS_A);
  mkStudent('stu_am', 'T0003', '班长甲', CLASS_A);
  mkStudent('stu_ac', 'T0004', '干部甲', CLASS_A);
  grant('u_stu_am', 'monitor', 'class', CLASS_A);
  grant('u_stu_ac', 'student_cadre', 'class', CLASS_A);

  // 乙班：学生乙一
  mkStudent('stu_b1', 'T1001', '学生乙一', CLASS_B);

  // 仅有 admin 角色的技术管理员：不应获得任何业务权限
  mkUser('u_admin', '技术管理', '信息中心', '管理员');
  grant('u_admin', 'admin', 'college', COLLEGE_ID);

  return {
    a1: principalOf('u_stu_a1'),
    a2: principalOf('u_stu_a2'),
    monitor: principalOf('u_stu_am'),
    cadre: principalOf('u_stu_ac'),
    b1: principalOf('u_stu_b1'),
    counselorA: principalOf('u_counselor_t1'),
    counselorB: principalOf('u_counselor_t2'),
    admin: principalOf('u_admin'),
  };
}

export function principalOf(userId) {
  return buildPrincipal({tenant_id: TENANT_ID, wps_user_id: userId});
}

export function sessionFor(userId) {
  return Identity.issueSession(userId);
}

function mkClass(classId, name, counselor) {
  Table.insert('class_profile', {
    class_id: classId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
    class_name: name, grade: '2026', counselor_user_id: counselor, active: 1,
  });
}

function mkUser(userId, name, dept, title) {
  Table.insert('directory_user', {
    wps_user_id: userId, tenant_id: TENANT_ID, display_name: name,
    department: dept, title, im_user_id: `im_${userId}`, active: 1, source: 'test',
  });
}

export function mkStudent(studentId, studentNo, name, classId) {
  const userId = `u_${studentId}`;
  Table.insert('student_profile', {
    student_id: studentId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
    student_no: studentNo, name, current_class_id: classId, active: 1,
    provisional: 0, source: 'test_roster', source_updated_at: nowUtc(),
  });
  Table.insert('student_class', {
    membership_id: newId('mem'), tenant_id: TENANT_ID, student_id: studentId,
    class_id: classId, valid_from: '2026-09-01', valid_to: null,
  });
  mkUser(userId, name, classId, '学生');
  Table.insert('identity_link', {
    link_id: newId('lnk'), tenant_id: TENANT_ID, student_id: studentId,
    wps_user_id: userId, directory_object_id: userId, link_status: 'verified',
    verified_by: 'test', verified_at: nowUtc(), source: 'test',
  });
  grant(userId, 'student', 'self', studentId);
  return studentId;
}

export function grant(userId, role, scopeType, scopeId, {validTo = null} = {}) {
  Table.insert('role_assignment', {
    assignment_id: newId('role'), tenant_id: TENANT_ID, wps_user_id: userId,
    role, scope_type: scopeType, scope_id: scopeId,
    valid_from: '2026-09-01', valid_to: validTo, enabled: 1, assigned_by: 'test',
  });
}

/**
 * 直接造一条考勤记录（绕过接入层，用于聚焦规则与流程的单元测试）。
 * 判定仍然走真实的规则引擎，不手写 final_judgment。
 */
export function mkAttendance({
  studentId, classId, attDate = '2026-09-07', period = 1,
  courseName = '测试课程', rawResult = '旷课', rawWay = '', signTime = null,
}) {
  const student = Table.get('student_profile', studentId);
  const cls = Table.get('class_profile', classId);
  const policy = rulePolicySnapshot();
  const base = computeBaseJudgment({raw_result: rawResult, raw_way: rawWay}, policy);
  const final = computeFinalJudgment({base, activeLeaves: [], manual: null}, policy);
  const id = newId('att');
  const ts = nowUtc();

  Table.insert('attendance', {
    attendance_id: id,
    business_key: `${studentId}|${attDate}|${period}|${courseName}`,
    tenant_id: TENANT_ID, college_id: COLLEGE_ID, term_id: DEFAULT_TERM,
    student_id: studentId, student_no_snapshot: student.student_no,
    name_snapshot: student.name, class_id: classId, class_name_snapshot: cls.class_name,
    session_id: null, course_name: courseName, teacher: '测试教师', room: 'A101', week: 1,
    att_date: attDate, period,
    raw_id: newId('raw'), batch_id: 'batch_test',
    raw_result: rawResult, raw_way: rawWay, sign_time: signTime,
    base_judgment: base.judgment, leave_ids: '[]',
    manual_judgment: null, manual_event_id: null,
    final_judgment: final.final, judgment_reason: final.reason, rule_version: RULE_VERSION,
    business_revision: 1, public_until: null, locked_at: null, last_appeal_id: null,
    applied_event_id: `test:${id}`, needs_review: 0, review_reason: null,
    created_at: ts, updated_at: ts,
  });
  return Table.get('attendance', id);
}

export {Table};
