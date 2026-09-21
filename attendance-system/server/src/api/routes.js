// HTTP 路由。每条写接口都在服务端重新校验身份与范围。

import {Router, json, readJson, readBody, sendError} from './http.js';
import {Identity, Directory} from '../adapters/identity.js';
import {Table} from '../adapters/table.js';
import {Approval} from '../adapters/approval.js';
import {Form} from '../adapters/form.js';
import {buildPrincipal, manageableClassIds, Forbidden, canReadEvidence, assertCanExport} from '../domain/authz.js';
import {listAttendance, getAttendanceDetail, getScopeSummary, displayJudgment} from '../domain/attendance.js';
import {listVerificationQueue, verifyOne, verifyBatch, listCounselorReviewQueue, resolveCounselorReview} from '../domain/review.js';
import {submitLeave, listMyLeaves, getLeave, requestRevoke} from '../domain/leave.js';
import {submitAppeal, decideAppeal, withdrawAppeal, listMyAppeals, listAppealTodos, getAppeal} from '../domain/appeal.js';
import {listPolicies, unconfirmedPolicies, setPolicy} from '../domain/policy.js';
import {getDailySeries, rebuildStatsForDates, reconcile} from '../domain/stats.js';
import {ingest} from '../ingestion/pipeline.js';
import {createSource, listSources} from '../ingestion/registry.js';
import {buildStudentDailyDigest, buildCounselorDailyDigest, flushNotifications} from '../domain/notify.js';
import {runOnce, scheduleDailyJobs} from '../jobs/worker.js';
import {TENANT_ID, COLLEGE_ID, DEFAULT_TERM, JUDGMENTS} from '../config.js';
import {newId, nowUtc, businessDate, parseJson} from '../lib/util.js';

export const router = new Router();

/* ------------------------------------------------------------ 身份 */

/**
 * 本地登录入口。
 * 真实环境这一步由 WPS 365 完成，应用只接收已认证身份；
 * 这里保留同样的出口形态（换取会话令牌），以便替换时不动业务层。
 */
router.post('/api/auth/dev-login', async (req, res) => {
  const {user_id: userId} = await readJson(req);
  const user = Directory.getUser(userId);
  if (!user || !user.active) throw new Forbidden('账号不存在或已停用');
  const token = Identity.issueSession(userId);
  json(res, 200, {token, user_id: userId, display_name: user.display_name});
});

router.post('/api/auth/logout', async (req, res, ctx) => {
  Identity.revoke(ctx.token);
  json(res, 200, {ok: true});
});

/** 当前会话：身份、角色范围、可管辖班级。前端据此渲染入口，但权限以服务端为准。 */
router.get('/api/me', async (req, res, ctx) => {
  const p = ctx.principal;
  const classes = manageableClassIds(p);
  json(res, 200, {
    tenant_id: p.tenant_id,
    user_id: p.user_id,
    display_name: p.display_name,
    student_id: p.student_id,
    mapping_status: p.mapping_status,
    mapping_note: p.student_id ? null : '当前账号尚未关联学生身份，请联系管理员核验',
    roles: [...p.roles],
    assignments: p.assignments,
    manageable_classes: Table.all('class_profile', {
      where: {class_id: {op: 'in', value: classes}}, limit: 500,
    }).map((c) => ({class_id: c.class_id, class_name: c.class_name})),
    is_counselor: p.isCounselor,
    college_id: COLLEGE_ID,
    term_id: DEFAULT_TERM,
    judgments: JUDGMENTS.map((j) => ({value: j, label: displayJudgment(j)})),
  });
});

/** 身份切换器数据源：仅开发环境使用，便于演示各角色视图。 */
router.get('/api/dev/users', async (req, res) => {
  const students = Table.all('student_profile', {where: {tenant_id: TENANT_ID}, limit: 20});
  const staff = Table.all('role_assignment', {
    where: {tenant_id: TENANT_ID, role: 'counselor', scope_type: 'college'}, limit: 20,
  });
  const pick = (userId) => {
    const u = Directory.getUser(userId);
    const roles = Table.all('role_assignment', {where: {wps_user_id: userId, enabled: 1}, limit: 20});
    return u && {
      user_id: userId, display_name: u.display_name, title: u.title,
      roles: [...new Set(roles.map((r) => r.role))],
    };
  };
  json(res, 200, {
    users: [
      ...staff.map((s) => pick(s.wps_user_id)),
      ...students.map((s) => pick(`u_${s.student_id}`)),
    ].filter(Boolean),
  });
});

/* ------------------------------------------------------------ 考勤查询 */

router.get('/api/attendance', async (req, res, ctx) => {
  json(res, 200, listAttendance(ctx.principal, ctx.query));
});

router.get('/api/attendance/:id', async (req, res, ctx) => {
  json(res, 200, getAttendanceDetail(ctx.principal, ctx.params.id));
});

router.get('/api/summary', async (req, res, ctx) => {
  json(res, 200, getScopeSummary(ctx.principal, ctx.query));
});

/** 看板：按日趋势与班级排行，读汇总表而不是明细。 */
router.get('/api/dashboard', async (req, res, ctx) => {
  const p = ctx.principal;
  const classes = manageableClassIds(p);
  if (!classes.length) throw new Forbidden('没有可查看的班级范围');
  const dateFrom = ctx.query.date_from ?? '0000-01-01';
  const dateTo = ctx.query.date_to ?? '9999-12-31';

  const series = getDailySeries({scopeType: 'class', scopeIds: classes, dateFrom, dateTo});
  const byDate = new Map();
  const byClass = new Map();
  for (const row of series) {
    if (!byDate.has(row.att_date)) byDate.set(row.att_date, blank());
    byDate.get(row.att_date)[row.judgment] += row.count;
    if (!byClass.has(row.scope_id)) byClass.set(row.scope_id, blank());
    byClass.get(row.scope_id)[row.judgment] += row.count;
  }
  const names = new Map(Table.all('class_profile', {
    where: {class_id: {op: 'in', value: classes}}, limit: 500,
  }).map((c) => [c.class_id, c.class_name]));

  const coverage = Table.all('data_coverage', {
    where: {tenant_id: TENANT_ID, class_id: {op: 'in', value: classes}}, limit: 20000,
  }).filter((c) => c.att_date >= dateFrom && c.att_date <= dateTo);

  json(res, 200, {
    scope_classes: classes.length,
    daily: [...byDate.entries()].sort().map(([date, counts]) => ({
      att_date: date, counts, total: sum(counts),
      abnormal: counts['旷课'] + counts['迟到'] + counts['早退'],
      pending: counts['待处理'],
    })),
    classes: [...byClass.entries()].map(([classId, counts]) => {
      const total = sum(counts);
      const abnormal = counts['旷课'] + counts['迟到'] + counts['早退'];
      return {
        class_id: classId, class_name: names.get(classId) ?? classId,
        counts, total,
        abnormal, pending: counts['待处理'],
        abnormal_rate: total ? Number(((abnormal / total) * 100).toFixed(2)) : null,
      };
    }).sort((a, b) => (b.abnormal_rate ?? 0) - (a.abnormal_rate ?? 0)),
    // 口径说明随数据一起返回，避免界面自行解释
    definitions: {
      unit: '学生·节',
      abnormal: '旷课＋迟到＋早退',
      pending: '待核实，单独统计，不计入异常',
      needs_attention: '旷课＋待核实（v4 口径，单独命名，不与异常率混用）',
      expected_periods: '无权威课表与选课关系，不提供应到分母与到课率',
    },
    coverage: {
      confirmed_complete: coverage.filter((c) => c.coverage_status === 'complete').length,
      total_class_days: coverage.length,
      status: coverage.length && coverage.every((c) => c.coverage_status === 'complete') ? 'complete' : 'unknown',
      note: '覆盖状态须由辅导员逐班逐日确认，不能由导入成功推断',
    },
    updated_at: series.reduce((max, r) => (r.last_rebuilt_at > max ? r.last_rebuilt_at : max), ''),
  });

  function blank() { return Object.fromEntries(JUDGMENTS.map((j) => [j, 0])); }
  function sum(c) { return Object.values(c).reduce((a, b) => a + b, 0); }
});

/** 导出明细。名称明确为"明细"，权限与查询一致，并留审计。 */
router.get('/api/export/attendance', async (req, res, ctx) => {
  const scopeType = ctx.query.scope_type ?? 'self';
  const scopeId = ctx.query.scope_id ?? ctx.principal.student_id;
  assertCanExport(ctx.principal, {scopeType, scopeId});

  const rows = [];
  let cursor = null;
  do {
    const page = listAttendance(ctx.principal, {...ctx.query, cursor, limit: 200});
    rows.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && rows.length < 50000);

  Table.insert('audit_log', {
    audit_id: newId('aud'), tenant_id: TENANT_ID, actor_user_id: ctx.principal.user_id,
    actor_role_snapshot: [...ctx.principal.roles].join(','), scope_snapshot: `${scopeType}:${scopeId}`,
    action: 'export_attendance_detail', entity_type: 'attendance', entity_id: scopeId,
    before_ref: null, after_ref: JSON.stringify({rows: rows.length}),
    reason: null, source_event_id: null, result: 'ok', occurred_at: nowUtc(),
  });

  const header = ['业务日期', '节次', '学号', '姓名', '班级', '课程', '教师', '原始结果', '原始方式', '基础判定', '最终结果', '判定依据', '规则版本'];
  const csv = [header, ...rows.map((r) => [
    r.att_date, r.period, r.student_no, r.name, r.class_name, r.course_name, r.teacher ?? '',
    r.base_judgment, '', r.base_judgment, r.final_judgment, r.judgment_reason, '',
  ])].map((line) => line.map((c) => `"${String(c ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');

  const body = Buffer.from(`﻿${csv}`, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="attendance-detail-${businessDate()}.csv"`,
    'content-length': body.length,
  });
  res.end(body);
});

/* ------------------------------------------------------------ 核对 */

router.get('/api/verification/queue', async (req, res, ctx) => {
  json(res, 200, listVerificationQueue(ctx.principal, ctx.query));
});

router.post('/api/verification/verify', async (req, res, ctx) => {
  const body = await readJson(req);
  json(res, 200, await verifyOne(ctx.principal, {
    attendanceId: body.attendance_id,
    action: body.action,
    note: body.note,
    evidenceRefs: body.evidence_refs ?? [],
    expectedRevision: body.expected_revision,
    idempotencyKey: body.idempotency_key,
  }));
});

router.post('/api/verification/verify-batch', async (req, res, ctx) => {
  const body = await readJson(req);
  json(res, 200, await verifyBatch(ctx.principal, {
    items: (body.items ?? []).map((i) => ({
      attendanceId: i.attendance_id, action: i.action, note: i.note,
      expectedRevision: i.expected_revision,
    })),
    note: body.note,
  }));
});

router.get('/api/review/queue', async (req, res, ctx) => {
  json(res, 200, listCounselorReviewQueue(ctx.principal, ctx.query));
});

router.post('/api/review/resolve', async (req, res, ctx) => {
  const body = await readJson(req);
  json(res, 200, await resolveCounselorReview(ctx.principal, {
    attendanceId: body.attendance_id, decision: body.decision,
    toJudgment: body.to_judgment, reason: body.reason,
    expectedRevision: body.expected_revision,
  }));
});

/* ------------------------------------------------------------ 请假 */

router.post('/api/leaves', async (req, res, ctx) => {
  const b = await readJson(req);
  json(res, 200, submitLeave(ctx.principal, {
    leaveType: b.leave_type, startDate: b.start_date, endDate: b.end_date,
    periods: b.periods ?? [], reason: b.reason,
    evidenceRefs: b.evidence_refs ?? [],
    memberStudentIds: b.member_student_ids,
    submissionId: b.submission_id,
  }));
});

router.get('/api/leaves', async (req, res, ctx) => {
  json(res, 200, {items: listMyLeaves(ctx.principal, ctx.query)});
});

router.get('/api/leaves/:id', async (req, res, ctx) => {
  json(res, 200, getLeave(ctx.principal, ctx.params.id));
});

router.post('/api/leaves/:id/revoke', async (req, res, ctx) => {
  const b = await readJson(req);
  json(res, 200, requestRevoke(ctx.principal, ctx.params.id, b.reason));
});

/** 可选人员列表：只返回发起人授权范围内的学生。 */
router.get('/api/leaves/candidates', async (req, res, ctx) => {
  const classes = manageableClassIds(ctx.principal);
  if (!classes.length) return json(res, 200, {items: []});
  const students = Table.all('student_profile', {
    where: {tenant_id: TENANT_ID, current_class_id: {op: 'in', value: classes}, active: 1},
    order: [['student_no', 'ASC']], limit: 2000,
  });
  json(res, 200, {
    items: students.map((s) => ({
      student_id: s.student_id, student_no: s.student_no, name: s.name,
      class_id: s.current_class_id,
    })),
  });
});

/* ------------------------------------------------------------ 申诉 */

router.post('/api/appeals', async (req, res, ctx) => {
  const b = await readJson(req);
  json(res, 200, submitAppeal(ctx.principal, {
    attendanceId: b.attendance_id, reason: b.reason,
    evidenceRefs: b.evidence_refs ?? [],
    onBehalfStudentId: b.on_behalf_student_id,
    submissionId: b.submission_id,
  }));
});

router.get('/api/appeals', async (req, res, ctx) => {
  json(res, 200, {items: listMyAppeals(ctx.principal, ctx.query)});
});

router.get('/api/appeals/todos', async (req, res, ctx) => {
  json(res, 200, {items: listAppealTodos(ctx.principal, ctx.query)});
});

router.get('/api/appeals/:id', async (req, res, ctx) => {
  json(res, 200, getAppeal(ctx.principal, ctx.params.id));
});

router.post('/api/appeals/:id/decide', async (req, res, ctx) => {
  const b = await readJson(req);
  json(res, 200, await decideAppeal(ctx.principal, {
    appealId: ctx.params.id, decision: b.decision, comment: b.comment,
    expectedRevision: b.expected_revision,
  }));
});

router.post('/api/appeals/:id/withdraw', async (req, res, ctx) => {
  const b = await readJson(req);
  json(res, 200, withdrawAppeal(ctx.principal, ctx.params.id, b.reason));
});

/* ------------------------------------------------------------ 附件 */

router.post('/api/evidence', async (req, res, ctx) => {
  const b = await readJson(req);
  const evidenceId = Form.registerEvidence({
    ownerStudentId: ctx.principal.student_id,
    businessType: b.business_type ?? 'leave',
    businessId: b.business_id,
    fileName: b.file_name, contentType: b.content_type ?? 'application/octet-stream',
    byteSize: b.byte_size ?? 0, storageRef: b.storage_ref ?? `local://${newId('file')}`,
    uploadedBy: ctx.principal.user_id,
    sensitivity: b.sensitivity ?? 'restricted',
  });
  json(res, 200, {evidence_id: evidenceId});
});

/** 附件读取一律服务端鉴权，绝不是无鉴权公开链接。 */
router.get('/api/evidence/:id', async (req, res, ctx) => {
  const evidence = Table.get('evidence_file', ctx.params.id);
  if (!evidence) throw new Forbidden('附件不存在或无权访问');
  const leave = evidence.business_id ? Table.get('leave_request', evidence.business_id) : null;
  if (!canReadEvidence(ctx.principal, evidence, {leave})) {
    throw new Forbidden('无权访问该证明材料');
  }
  json(res, 200, {
    evidence_id: evidence.evidence_id, file_name: evidence.file_name,
    content_type: evidence.content_type, byte_size: evidence.byte_size,
    sensitivity: evidence.sensitivity,
    note: '本地仿真环境不返回文件内容；真实环境返回受限时效链接',
  });
});

/* ------------------------------------------------------------ 审批（平台视角） */

/** 我的审批待办：把轻审批实例与业务单据对上。 */
router.get('/api/approvals/todos', async (req, res, ctx) => {
  const instances = Table.all('approval_instance', {
    where: {tenant_id: TENANT_ID, state: 'running', current_assignee: ctx.principal.user_id},
    order: [['created_at', 'ASC']], limit: 100,
  });
  json(res, 200, {
    items: instances.map((i) => ({
      instance_id: i.instance_id, business_type: i.business_type, business_id: i.business_id,
      stage: i.stage, created_at: i.created_at,
      // 审批卡片展示业务内容，不展示 API、任务 ID 等实现细节
      summary: summarizeApproval(i),
    })),
  });
});

router.post('/api/approvals/:id/decide', async (req, res, ctx) => {
  const b = await readJson(req);
  const inst = Table.get('approval_instance', ctx.params.id);
  if (!inst) throw new Forbidden('审批实例不存在');

  if (inst.business_type === 'appeal') {
    return json(res, 200, await decideAppeal(ctx.principal, {
      appealId: inst.business_id, decision: b.decision, comment: b.comment,
    }));
  }
  // 请假与撤销：在平台侧落决定，由任务处理器投影到台账
  const out = Approval.decide(ctx.params.id, {
    actorUserId: ctx.principal.user_id, decision: b.decision, comment: b.comment,
  });
  if (!out.ok) throw new Forbidden(approvalErrorMessage(out.code), {code: out.code});
  await runOnce();
  json(res, 200, {ok: true, state: out.state, note: '审批结果已受理，考勤同步由后台任务完成'});
});

function approvalErrorMessage(code) {
  return {
    NOT_CURRENT_ASSIGNEE: '你已不是该审批的当前处理人',
    INSTANCE_FINISHED: '该审批已结束，请刷新查看最新状态',
    INSTANCE_NOT_FOUND: '审批实例不存在',
  }[code] ?? '审批平台拒绝了该操作';
}

function summarizeApproval(inst) {
  if (inst.business_type === 'appeal') {
    const a = Table.get('appeal', inst.business_id);
    const r = a && Table.get('attendance', a.attendance_id);
    return r && {
      title: '考勤申诉',
      student: r.name_snapshot, class_name: r.class_name_snapshot,
      detail: `${r.att_date} 第 ${r.period} 节《${r.course_name}》当前结果「${r.final_judgment}」`,
      reason: a.reason,
      has_active_leave: parseJson(r.leave_ids, []).length > 0,
    };
  }
  const l = Table.get('leave_request', inst.business_id);
  const members = l ? Table.all('leave_member', {where: {leave_id: l.leave_id}, limit: 200}) : [];
  return l && {
    title: inst.business_type === 'leave_revoke' ? '请假撤销' : '请假申请',
    detail: `${l.start_date} 至 ${l.end_date}`
      + (parseJson(l.periods, []).length ? ` 第 ${parseJson(l.periods, []).join('、')} 节` : '（全天）'),
    leave_type: l.leave_type,
    reason: inst.business_type === 'leave_revoke' ? l.revoke_reason : l.reason,
    member_count: members.length,
    members: members.slice(0, 20).map((m) => m.student_no_snapshot),
  };
}

/* ------------------------------------------------------------ 接入与管理 */

router.get('/api/ingest/sources', async (req, res) => {
  json(res, 200, {items: listSources()});
});

router.get('/api/ingest/batches', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('仅辅导员可查看接入批次');
  const batches = Table.all('import_batch', {
    where: {tenant_id: TENANT_ID}, order: [['started_at', 'DESC']], limit: 50,
  });
  json(res, 200, {
    items: batches.map((b) => ({
      ...b,
      date_evidence: parseJson(b.date_evidence, null),
    })),
  });
});

/** 上传并接入。dry_run=1 时只预览不落库。 */
router.post('/api/ingest/upload', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('仅辅导员可执行数据接入');
  const buffer = await readBody(req);
  const fileName = decodeURIComponent(req.headers['x-file-name'] ?? 'upload.xlsx');
  const sourceType = req.headers['x-source-type'] ?? 'excel_file';
  const dryRun = ctx.query.dry_run === '1';

  const source = createSource(sourceType, {buffer, fileName});
  const result = await ingest(source, {
    operatorId: ctx.principal.user_id,
    termId: ctx.query.term_id ?? DEFAULT_TERM,
    dryRun,
  });
  if (!dryRun && result.affected_dates?.length) rebuildStatsForDates(result.affected_dates);
  json(res, 200, result);
});

router.get('/api/ingest/exceptions', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('仅辅导员可查看映射异常');
  const page = Table.query('import_exception', {
    where: {tenant_id: TENANT_ID, status: ctx.query.status ?? 'open'},
    order: [['created_at', 'DESC'], ['exception_id', 'ASC']],
    cursor: ctx.query.cursor ?? null,
    limit: 50,
  });
  json(res, 200, {
    items: page.records.map((e) => ({...e, payload: parseJson(e.payload_json, {})})),
    next_cursor: page.next_cursor, has_more: page.has_more,
    note: '这些是接入层的数据错误与映射异常，与考勤业务状态「待核实」是两回事',
  });
});

/** 班级别名登记：解决"班级名称未匹配"后可重新接入。 */
router.post('/api/ingest/class-alias', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('仅辅导员可登记班级别名');
  const b = await readJson(req);
  const cls = Table.get('class_profile', b.class_id);
  if (!cls) throw new Forbidden('班级不存在');
  Table.insert('class_alias', {
    alias_id: newId('alias'), tenant_id: TENANT_ID, alias: b.alias,
    class_id: b.class_id, created_by: ctx.principal.user_id, created_at: nowUtc(),
  });
  json(res, 200, {ok: true, alias: b.alias, class_id: b.class_id});
});

/** 数据完整性确认：只能由辅导员逐班逐日显式确认。 */
router.post('/api/coverage/confirm', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('仅辅导员可确认数据完整性');
  const b = await readJson(req);
  if (!manageableClassIds(ctx.principal).includes(b.class_id)) {
    throw new Forbidden('不在你的负责范围内');
  }
  Table.upsert('data_coverage', {
    coverage_id: `cov_${b.class_id}_${b.att_date}`,
    tenant_id: TENANT_ID, class_id: b.class_id, att_date: b.att_date,
    coverage_status: b.coverage_status ?? 'complete',
    confirmed_by: ctx.principal.user_id, confirmed_at: nowUtc(), note: b.note ?? null,
  }, ['coverage_id']);
  json(res, 200, {ok: true});
});

/* ------------------------------------------------------------ 运维与政策 */

router.get('/api/admin/policies', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor && !ctx.principal.isAdmin) throw new Forbidden('无权查看政策配置');
  json(res, 200, {
    items: listPolicies(),
    unconfirmed: unconfirmedPolicies().map((p) => p.key),
    note: '未确认口径不得用于真实学生的自动改判与消息推送',
  });
});

router.put('/api/admin/policies/:key', async (req, res, ctx) => {
  // 业务政策由辅导员（业务负责人）确认；技术管理员不能自行确认业务口径
  if (!ctx.principal.isCounselor) throw new Forbidden('业务口径须由业务负责人确认');
  const b = await readJson(req);
  json(res, 200, setPolicy(ctx.params.key, b.value, {
    confirmed: b.confirmed, note: b.note, actor: ctx.principal.user_id,
  }));
});

/** 消息与同步任务台账。 */
router.get('/api/admin/operations', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor && !ctx.principal.isAdmin) throw new Forbidden('无权查看运行台账');
  const notifications = Table.all('notification', {
    where: {tenant_id: TENANT_ID}, order: [['created_at', 'DESC']], limit: 100,
  });
  const jobs = Table.all('event_job', {
    where: {tenant_id: TENANT_ID}, order: [['created_at', 'DESC']], limit: 100,
  });
  json(res, 200, {
    notifications: {
      items: notifications.map((n) => ({
        notification_id: n.notification_id, kind: n.kind, receiver: n.receiver_user_id,
        status: n.status, attempts: n.attempts, last_error: n.last_error,
        business_date: n.business_date, created_at: n.created_at, sent_at: n.sent_at,
      })),
      by_status: countBy(notifications, 'status'),
      unknown_note: 'unknown 表示请求结果不明，须核对后再决定是否补发，不自动重发',
    },
    jobs: {
      items: jobs.map((j) => ({
        event_id: j.event_id, event_type: j.event_type, entity_id: j.entity_id,
        status: j.status, attempts: j.attempts, last_error: j.last_error,
        created_at: j.created_at, finished_at: j.finished_at,
      })),
      by_status: countBy(jobs, 'status'),
      dead_note: 'dead 状态的任务需要人工修复，不会自动重试',
    },
  });
  function countBy(rows, key) {
    const out = {};
    for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
    return out;
  }
});

router.post('/api/admin/jobs/run', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor && !ctx.principal.isAdmin) throw new Forbidden('无权执行任务');
  json(res, 200, await runOnce({limit: 50}));
});

router.post('/api/admin/digest/run', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor) throw new Forbidden('无权触发日报');
  const b = await readJson(req);
  const date = b.date ?? businessDate();
  const student = buildStudentDailyDigest(date, {force: b.force === true});
  const counselor = buildCounselorDailyDigest(date);
  const flushed = flushNotifications({limit: 5000});
  json(res, 200, {date, student, counselor, flushed});
});

router.post('/api/admin/schedule/daily', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor && !ctx.principal.isAdmin) throw new Forbidden('无权排程');
  const b = await readJson(req);
  json(res, 200, {jobs: scheduleDailyJobs(b.date ?? businessDate())});
});

router.post('/api/admin/reconcile', async (req, res, ctx) => {
  if (!ctx.principal.isCounselor && !ctx.principal.isAdmin) throw new Forbidden('无权对账');
  const b = await readJson(req);
  const dates = b.dates ?? [businessDate()];
  const out = reconcile(dates);
  if (b.rebuild && out.diffs.length) rebuildStatsForDates(dates);
  json(res, 200, {...out, rebuilt: !!b.rebuild && out.diffs.length > 0});
});

/** 能力矩阵：如实告诉使用者哪些平台能力尚未在真实租户验证。 */
router.get('/api/admin/capabilities', async (req, res) => {
  json(res, 200, {
    environment: 'local_simulation',
    warning: '当前运行在本地仿真环境。所有 WPS 365 平台能力均由适配器模拟，'
      + '没有任何一项在学校真实租户验证过。',
    adapters: [
      {name: 'Identity/Directory', file: 'adapters/identity.js', verified_in_tenant: false},
      {name: 'Table', file: 'adapters/table.js', verified_in_tenant: false},
      {name: 'Form', file: 'adapters/form.js', verified_in_tenant: false},
      {name: 'Approval', file: 'adapters/approval.js', verified_in_tenant: false},
      {name: 'Message', file: 'adapters/message.js', verified_in_tenant: false},
      {name: 'Scheduler', file: 'adapters/scheduler.js', verified_in_tenant: false},
    ],
    sources: listSources(),
  });
});

export {sendError};
