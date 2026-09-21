// 授权。对应 03 §6 权限矩阵。
//
// 铁律：**页面筛选不是访问控制**。
// 每一次读取与每一次写入都在服务端重新校验角色范围与有效期，
// 不信任前端传来的 role、scope、student_id 或任何"我是谁"的声明。

import {Table} from '../adapters/table.js';
import {Directory} from '../adapters/identity.js';
import {TENANT_ID, COLLEGE_ID} from '../config.js';
import {nowUtc} from '../lib/util.js';

export class Forbidden extends Error {
  constructor(message, detail) {
    super(message);
    this.code = 'FORBIDDEN';
    this.detail = detail;
  }
}

export const ROLES = ['student', 'monitor', 'student_cadre', 'counselor', 'admin'];

/**
 * 构造请求主体。这是所有业务判断的唯一身份来源。
 * @returns {{
 *   tenant_id:string, user_id:string, display_name:string,
 *   student_id:string|null, mapping_status:string,
 *   assignments:Array, roles:Set<string>,
 *   classScopes:string[], collegeScopes:string[], isCounselor:boolean, isAdmin:boolean
 * }}
 */
export function buildPrincipal(user) {
  const now = nowUtc();
  const today = now.slice(0, 10);
  const assignments = Table.all('role_assignment', {
    where: {tenant_id: TENANT_ID, wps_user_id: user.wps_user_id, enabled: 1},
    limit: 200,
  }).filter((a) => a.valid_from <= today && (!a.valid_to || a.valid_to >= today));

  const {student_id: studentId, mapping_status: mappingStatus} = Directory.resolveStudent(user.wps_user_id);
  const roles = new Set(assignments.map((a) => a.role));

  return {
    tenant_id: user.tenant_id,
    user_id: user.wps_user_id,
    display_name: Directory.displayName(user.wps_user_id),
    student_id: studentId,
    mapping_status: mappingStatus,
    assignments: assignments.map((a) => ({
      role: a.role, scope_type: a.scope_type, scope_id: a.scope_id,
      valid_from: a.valid_from, valid_to: a.valid_to,
    })),
    roles,
    classScopes: [...new Set(assignments.filter((a) => a.scope_type === 'class').map((a) => a.scope_id))],
    collegeScopes: [...new Set(assignments.filter((a) => a.scope_type === 'college').map((a) => a.scope_id))],
    isCounselor: roles.has('counselor'),
    isAdmin: roles.has('admin'),
    // 技术管理员不默认拥有任何业务权限（03 §6 最后一行）
    hasBusinessRole: roles.has('student') || roles.has('monitor') || roles.has('student_cadre') || roles.has('counselor'),
  };
}

/** 该主体在某角色下授权的班级集合。 */
export function classesForRole(principal, role) {
  return principal.assignments
    .filter((a) => a.role === role && a.scope_type === 'class')
    .map((a) => a.scope_id);
}

/** 拥有管理视角（可看他人）的班级集合：副班长/干部的授权班级；辅导员为学院全部班级。 */
export function manageableClassIds(principal) {
  if (principal.isCounselor && principal.collegeScopes.includes(COLLEGE_ID)) {
    return Table.all('class_profile', {where: {tenant_id: TENANT_ID, college_id: COLLEGE_ID}, limit: 5000})
      .map((c) => c.class_id);
  }
  const ids = new Set();
  for (const a of principal.assignments) {
    if (a.scope_type === 'class' && ['monitor', 'student_cadre', 'counselor'].includes(a.role)) {
      ids.add(a.scope_id);
    }
  }
  return [...ids];
}

/** 能否读取某条考勤。本人恒可读；管理角色按班级范围读。 */
export function canReadAttendance(principal, record) {
  if (!record) return false;
  if (principal.student_id && record.student_id === principal.student_id) return true;
  if (!principal.hasBusinessRole) return false;
  return manageableClassIds(principal).includes(record.class_id);
}

export function assertCanReadAttendance(principal, record) {
  if (!canReadAttendance(principal, record)) {
    throw new Forbidden('无权查看该考勤记录', {attendance_id: record?.attendance_id});
  }
}

/**
 * 能否核对某条待处理记录。
 * 防自审（D18）：本人记录一律不能自核对，无论角色多高 —— 辅导员代办本人记录同样禁止。
 */
export function canVerifyAttendance(principal, record) {
  if (!record) return false;
  if (principal.student_id && record.student_id === principal.student_id) {
    return {ok: false, reason: 'SELF_REVIEW_FORBIDDEN'};
  }
  if (principal.isCounselor) {
    const inCollege = principal.collegeScopes.includes(COLLEGE_ID)
      || classesForRole(principal, 'counselor').includes(record.class_id);
    return inCollege ? {ok: true} : {ok: false, reason: 'OUT_OF_SCOPE'};
  }
  const scoped = [...classesForRole(principal, 'monitor'), ...classesForRole(principal, 'student_cadre')];
  return scoped.includes(record.class_id) ? {ok: true} : {ok: false, reason: 'OUT_OF_SCOPE'};
}

/** 学院范围内的兜底辅导员：某班级的负责辅导员，缺失时取任一学院范围辅导员。 */
export function counselorForClass(classId) {
  const cls = Table.get('class_profile', classId);
  if (cls?.counselor_user_id) return cls.counselor_user_id;
  const fallback = Table.findOne('role_assignment', {
    tenant_id: TENANT_ID, role: 'counselor', scope_type: 'college', scope_id: COLLEGE_ID, enabled: 1,
  });
  return fallback?.wps_user_id ?? null;
}

/** 某班级当前有效的副班长（用于申诉一审路由）。 */
export function monitorsOfClass(classId, {excludeUserId} = {}) {
  const today = nowUtc().slice(0, 10);
  return Table.all('role_assignment', {
    where: {tenant_id: TENANT_ID, role: 'monitor', scope_type: 'class', scope_id: classId, enabled: 1},
    limit: 50,
  })
    .filter((a) => a.valid_from <= today && (!a.valid_to || a.valid_to >= today))
    .map((a) => a.wps_user_id)
    .filter((u) => u !== excludeUserId);
}

/** 某班级当前有效的学生干部（用于申诉二审路由）。 */
export function cadresOfClass(classId, {excludeUserId} = {}) {
  const today = nowUtc().slice(0, 10);
  return Table.all('role_assignment', {
    where: {tenant_id: TENANT_ID, role: 'student_cadre', scope_type: 'class', scope_id: classId, enabled: 1},
    limit: 50,
  })
    .filter((a) => a.valid_from <= today && (!a.valid_to || a.valid_to >= today))
    .map((a) => a.wps_user_id)
    .filter((u) => u !== excludeUserId);
}

/**
 * 病假证据可见性（D19）：默认仅本人与对应审批/复核范围的辅导员可看。
 * 副班长与学生干部即使能看到请假进度，也看不到证据文件。
 */
export function canReadEvidence(principal, evidence, {leave} = {}) {
  if (evidence.sensitivity !== 'restricted') return true;
  if (principal.student_id && evidence.owner_student_id === principal.student_id) return true;
  if (!principal.isCounselor) return false;
  if (!leave) return principal.collegeScopes.includes(COLLEGE_ID);
  const members = Table.all('leave_member', {where: {leave_id: leave.leave_id}, limit: 500});
  const classIds = [...new Set(members.map((m) => m.class_id_snapshot))];
  const scope = classesForRole(principal, 'counselor');
  return classIds.some((c) => scope.includes(c)) || principal.collegeScopes.includes(COLLEGE_ID);
}

/** 导出权限：范围与查询一致，且必须留审计。 */
export function assertCanExport(principal, {scopeType, scopeId}) {
  if (scopeType === 'self') {
    if (!principal.student_id || principal.student_id !== scopeId) {
      throw new Forbidden('只能导出本人数据');
    }
    return;
  }
  if (scopeType === 'class' && manageableClassIds(principal).includes(scopeId)) return;
  if (scopeType === 'college' && principal.isCounselor && principal.collegeScopes.includes(scopeId)) return;
  throw new Forbidden('无权导出该范围数据', {scopeType, scopeId});
}
