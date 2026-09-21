// 考勤查询服务。
//
// 所有查询都在服务端把"请求范围"与"已认证权限"求交集，
// 前端传来的 scope 只是缩小请求，永远不能扩大权限。

import {Table} from '../adapters/table.js';
import {TENANT_ID, RUNTIME, JUDGMENT_DISPLAY} from '../config.js';
import {parseJson, nowUtc} from '../lib/util.js';
import {manageableClassIds, assertCanReadAttendance, Forbidden, canVerifyAttendance} from './authz.js';
import {getSummary, coverageFor} from './stats.js';

/** 六类结果的展示名。待处理在界面显示为"待核实"，业务枚举值不变。 */
export function displayJudgment(j) {
  return JUDGMENT_DISPLAY[j] ?? j;
}

/**
 * 把请求范围与权限求交集，得到真正可查的 where 条件。
 * @returns {{where:object, effectiveScope:object}}
 */
export function resolveScope(principal, requested = {}) {
  const type = requested.scope_type ?? 'self';

  if (type === 'self') {
    if (!principal.student_id) {
      throw new Forbidden('当前账号尚未关联学生身份，请联系管理员核验', {
        mapping_status: principal.mapping_status,
      });
    }
    return {
      where: {student_id: principal.student_id},
      effectiveScope: {type: 'self', id: principal.student_id},
    };
  }

  const manageable = manageableClassIds(principal);

  if (type === 'student') {
    const target = requested.scope_id;
    if (principal.student_id === target) {
      return {where: {student_id: target}, effectiveScope: {type: 'self', id: target}};
    }
    // 查他人：必须该学生当前班级在可管辖范围内
    const student = Table.get('student_profile', target);
    if (!student || !manageable.includes(student.current_class_id)) {
      throw new Forbidden('无权查看该学生数据', {student_id: target});
    }
    return {where: {student_id: target}, effectiveScope: {type: 'student', id: target}};
  }

  if (type === 'class') {
    if (!manageable.includes(requested.scope_id)) {
      throw new Forbidden('无权查看该班级数据', {class_id: requested.scope_id});
    }
    return {
      where: {class_id: requested.scope_id},
      effectiveScope: {type: 'class', id: requested.scope_id},
    };
  }

  if (type === 'college') {
    if (!principal.isCounselor || !principal.collegeScopes.includes(requested.scope_id)) {
      throw new Forbidden('无权查看学院范围数据', {college_id: requested.scope_id});
    }
    return {
      where: {college_id: requested.scope_id},
      effectiveScope: {type: 'college', id: requested.scope_id},
    };
  }

  throw new Forbidden('未知查询范围', {scope_type: type});
}

/** 分页查询考勤明细。 */
export function listAttendance(principal, query = {}) {
  const {where: scopeWhere, effectiveScope} = resolveScope(principal, query);
  const where = {tenant_id: TENANT_ID, ...scopeWhere};

  if (query.date_from) where.att_date = {op: '>=', value: query.date_from};
  if (query.judgments?.length) where.final_judgment = {op: 'in', value: query.judgments};
  if (query.term_id) where.term_id = query.term_id;
  if (query.needs_review) where.needs_review = 1;

  const limit = Math.min(Number(query.limit) || RUNTIME.queryPageLimit, RUNTIME.queryMaxLimit);
  const page = Table.query('attendance', {
    where,
    order: [['att_date', 'DESC'], ['period', 'ASC'], ['attendance_id', 'ASC']],
    cursor: query.cursor ?? null,
    limit,
  });

  // date_to 无法与 keyset 的 >= 同列共存，在服务端过滤；日期区间通常很短。
  let items = page.records;
  if (query.date_to) items = items.filter((r) => r.att_date <= query.date_to);
  if (query.search) {
    const q = String(query.search).trim();
    items = items.filter((r) => `${r.name_snapshot} ${r.student_no_snapshot} ${r.class_name_snapshot} ${r.course_name}`.includes(q));
  }

  return {
    items: items.map((r) => toListItem(r, principal)),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    scope: effectiveScope,
    updated_at: nowUtc(),
  };
}

function toListItem(r, principal) {
  return {
    attendance_id: r.attendance_id,
    student_id: r.student_id,
    student_no: r.student_no_snapshot,
    name: r.name_snapshot,
    class_id: r.class_id,
    class_name: r.class_name_snapshot,
    course_name: r.course_name,
    teacher: r.teacher,
    room: r.room,
    att_date: r.att_date,
    period: r.period,
    week: r.week,
    base_judgment: r.base_judgment,
    final_judgment: r.final_judgment,
    final_judgment_display: displayJudgment(r.final_judgment),
    judgment_reason: r.judgment_reason,
    business_revision: r.business_revision,
    needs_review: !!r.needs_review,
    public_until: r.public_until,
    locked_at: r.locked_at,
    is_mine: principal.student_id === r.student_id,
    allowed_actions: allowedActions(r, principal),
  };
}

/** 界面动作提示。仅供展示，服务端在每次写入时重新校验，不依赖它。 */
function allowedActions(record, principal) {
  const actions = ['view'];
  const mine = principal.student_id === record.student_id;
  if (mine && ['旷课', '迟到', '早退'].includes(record.final_judgment)
      && !record.locked_at && !record.public_until) {
    actions.push('appeal');
  }
  if (mine) actions.push('apply_leave');
  if (record.final_judgment === '待处理' && canVerifyAttendance(principal, record).ok) {
    actions.push('confirm_present', 'confirm_absent');
  }
  if (record.needs_review && principal.isCounselor) actions.push('counselor_review');
  return actions;
}

/** 考勤详情：原始信息、判定依据、流程记录、公示倒计时。 */
export function getAttendanceDetail(principal, attendanceId) {
  const record = Table.get('attendance', attendanceId);
  if (!record) throw new Forbidden('考勤记录不存在或无权查看');
  assertCanReadAttendance(principal, record);

  const events = Table.all('review_event', {
    where: {attendance_id: attendanceId},
    order: [['created_at', 'ASC']],
    limit: 200,
  });
  const appeals = Table.all('appeal', {
    where: {attendance_id: attendanceId},
    order: [['created_at', 'DESC']],
    limit: 20,
  });
  const leaveIds = parseJson(record.leave_ids, []);
  const leaves = leaveIds.length
    ? Table.all('leave_request', {where: {leave_id: {op: 'in', value: leaveIds}}, limit: 20})
    : [];
  const batch = Table.get('import_batch', record.batch_id);

  return {
    ...toListItem(record, principal),
    // 原始值永远保留，人工结论不覆盖它
    raw: {
      raw_result: record.raw_result,
      raw_way: record.raw_way || null,
      sign_time: record.sign_time,
      source_type: batch?.source_type ?? null,
      source_system: batch?.source_system ?? null,
      batch_id: record.batch_id,
      date_semantics: batch?.date_semantics ?? 'unconfirmed',
    },
    manual_judgment: record.manual_judgment,
    rule_version: record.rule_version,
    review_reason: record.review_reason,
    leaves: leaves.map((l) => ({
      leave_id: l.leave_id, leave_type: l.leave_type,
      start_date: l.start_date, end_date: l.end_date,
      periods: parseJson(l.periods, []),
      approval_status: l.approval_status, apply_status: l.apply_status,
      revoke_status: l.revoke_status,
      // 证据引用不在此返回，读取需走 /api/evidence/:id 单独鉴权
    })),
    appeals: appeals.map((a) => ({
      appeal_id: a.appeal_id, status: a.status, stage: a.stage,
      created_at: a.created_at, final_at: a.final_at,
      first_deadline: a.first_deadline,
      apply_status: a.apply_status,
      public_until: a.public_until, locked_at: a.locked_at,
      is_mine: a.student_id === principal.student_id,
    })),
    timeline: events.map((e) => ({
      event_id: e.event_id, action: e.action,
      from_judgment: e.from_judgment, to_judgment: e.to_judgment,
      reason: e.reason, operator: e.operator_user_id,
      created_at: e.created_at, active: !!e.active,
    })),
    public_countdown_days: record.public_until
      ? Math.max(0, Math.ceil((Date.parse(record.public_until) - Date.now()) / 86400000))
      : null,
  };
}

/** 个人/班级/学院汇总。覆盖状态未确认时只说"已导入考勤"。 */
export function getScopeSummary(principal, query = {}) {
  const {effectiveScope} = resolveScope(principal, query);
  const dateFrom = query.date_from ?? '0000-01-01';
  const dateTo = query.date_to ?? '9999-12-31';

  const scopeType = effectiveScope.type === 'self' ? 'student' : effectiveScope.type;
  const summary = getSummary({
    scopeType, scopeId: effectiveScope.id, dateFrom, dateTo,
  });

  const classIds = effectiveScope.type === 'class'
    ? [effectiveScope.id]
    : (effectiveScope.type === 'college' ? manageableClassIds(principal) : []);

  return {
    ...summary,
    scope: effectiveScope,
    date_from: dateFrom === '0000-01-01' ? null : dateFrom,
    date_to: dateTo === '9999-12-31' ? null : dateTo,
    unit: 'student_period',
    coverage_status: classIds.length ? coverageFor(classIds, dateFrom, dateTo) : 'unknown',
    coverage_note: '覆盖状态未确认时，以上为"已导入考勤"统计，不代表全院完整到课情况',
  };
}
