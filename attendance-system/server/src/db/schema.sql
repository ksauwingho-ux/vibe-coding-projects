-- 课堂考勤管理系统 · 业务台账结构
-- 对应 docs/baseline/02_数据模型与字段字典.md 的逻辑模型。
--
-- 重要边界：本文件是"多维表格业务台账"在本地仿真环境下的落地实现。
-- 业务代码不直接执行 SQL，一律通过 server/src/adapters/table.js 的 Table 适配器访问；
-- 迁移到 WPS 365 时替换该适配器实现即可，业务层无需改动。
-- 逻辑唯一约束在此以 UNIQUE 索引实现；WPS 多维表格不保证原生唯一，
-- 因此业务层同时维护串行写入与幂等键（见 domain/writer.js），不依赖存储层兜底。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- 身份与组织

CREATE TABLE IF NOT EXISTS student_profile (
  student_id          TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  student_no          TEXT NOT NULL,          -- 文本，保留前导零
  name                TEXT NOT NULL,
  current_class_id    TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  provisional         INTEGER NOT NULL DEFAULT 0,  -- 1=学号为系统派生的占位值，非权威名册
  source              TEXT NOT NULL,
  source_updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_student_no ON student_profile(tenant_id, student_no);
CREATE INDEX IF NOT EXISTS ix_student_name ON student_profile(tenant_id, name);

-- WPS 通讯录投影：租户内所有用户（学生与教职工）的稳定 ID 与显示名。
-- 显示名仅用于展示，任何授权判断都不得以它为依据。
CREATE TABLE IF NOT EXISTS directory_user (
  wps_user_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  department          TEXT,
  title               TEXT,
  im_user_id          TEXT,                   -- IM 接收人 ID，可能与 wps_user_id 不同名空间
  active              INTEGER NOT NULL DEFAULT 1,
  source              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_directory_tenant ON directory_user(tenant_id, active);

CREATE TABLE IF NOT EXISTS identity_link (
  link_id             TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  student_id          TEXT,
  wps_user_id         TEXT NOT NULL,
  directory_object_id TEXT,
  link_status         TEXT NOT NULL,          -- verified/unresolved/conflict/disabled
  verified_by         TEXT,
  verified_at         TEXT,
  source              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_link_user ON identity_link(tenant_id, wps_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_link_student ON identity_link(student_id) WHERE student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS class_profile (
  class_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  class_name          TEXT NOT NULL,
  grade               TEXT,
  counselor_user_id   TEXT,                   -- 负责辅导员，用于审批与待办路由
  active              INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_class_name ON class_profile(tenant_id, class_name);

-- 班级名称别名：学校 Excel 中的写法 -> 正式班级
CREATE TABLE IF NOT EXISTS class_alias (
  alias_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  alias               TEXT NOT NULL,
  class_id            TEXT NOT NULL,
  created_by          TEXT,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_class_alias ON class_alias(tenant_id, alias);

CREATE TABLE IF NOT EXISTS student_class (
  membership_id       TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  student_id          TEXT NOT NULL,
  class_id            TEXT NOT NULL,
  valid_from          TEXT NOT NULL,
  valid_to            TEXT                    -- NULL 表示当前有效
);
CREATE INDEX IF NOT EXISTS ix_membership_student ON student_class(student_id, valid_from);

CREATE TABLE IF NOT EXISTS role_assignment (
  assignment_id       TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  wps_user_id         TEXT NOT NULL,
  role                TEXT NOT NULL,          -- student/monitor/student_cadre/counselor/admin
  scope_type          TEXT NOT NULL,          -- self/class/college
  scope_id            TEXT NOT NULL,
  valid_from          TEXT NOT NULL,
  valid_to            TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  assigned_by         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_unique
  ON role_assignment(tenant_id, wps_user_id, role, scope_type, scope_id, valid_from);
CREATE INDEX IF NOT EXISTS ix_role_user ON role_assignment(tenant_id, wps_user_id, enabled);

-- ---------------------------------------------------------------- 课程与课次

CREATE TABLE IF NOT EXISTS course_session (
  session_id          TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  term_id             TEXT NOT NULL,
  class_id            TEXT,
  teaching_group_id   TEXT,
  course_id           TEXT,
  course_name         TEXT NOT NULL,
  teacher_name        TEXT,
  teacher_user_id     TEXT,
  att_date            TEXT NOT NULL,
  period              INTEGER NOT NULL,       -- 归一为 1..12 的单节
  source_period_text  TEXT,                   -- 来源原始节次字符串
  room                TEXT,
  week                INTEGER,
  course_type         TEXT,
  source              TEXT NOT NULL,
  schedule_status     TEXT NOT NULL DEFAULT 'derived'  -- derived(由考勤补建)/scheduled
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_key
  ON course_session(tenant_id, term_id, class_id, att_date, period, course_name);

CREATE TABLE IF NOT EXISTS enrollment (
  enrollment_id       TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  student_id          TEXT NOT NULL,
  course_id           TEXT,
  teaching_group_id   TEXT,
  valid_from          TEXT NOT NULL,
  valid_to            TEXT,
  source              TEXT NOT NULL
);

-- ---------------------------------------------------------------- 统一接入层
-- 考勤数据只经由接入层进入系统。Excel 文件是当前实现的一个来源适配器，
-- 学校考勤 API 是后续扩展的另一个来源；两者产出同一份标准化记录。
-- 下游（判定、审批、统计、推送）只读 raw_attendance / attendance，
-- 不得引用文件名、工作表、单元格或任何来源特有概念。

CREATE TABLE IF NOT EXISTS import_batch (
  batch_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  source_type         TEXT NOT NULL,          -- excel_file/school_api/manual：来源适配器种类
  source_system       TEXT NOT NULL,          -- 来源系统标识，如 school_attendance
  source_ref          TEXT,                   -- 来源定位：文件名或 API 拉取游标/区间，仅供追溯
  source_digest       TEXT,                   -- 来源内容摘要：文件哈希或 API 响应摘要，用于重复接入提示
  file_name           TEXT,                   -- 仅 excel_file 来源填写（兼容 02 字段字典）
  file_hash           TEXT,                   -- 同上
  term_id             TEXT NOT NULL,
  date_from           TEXT,
  date_to             TEXT,
  total_rows          INTEGER NOT NULL DEFAULT 0,
  valid_rows          INTEGER NOT NULL DEFAULT 0,
  inserted_rows       INTEGER NOT NULL DEFAULT 0,
  duplicate_rows      INTEGER NOT NULL DEFAULT 0,
  conflict_rows       INTEGER NOT NULL DEFAULT 0,
  unmatched_rows      INTEGER NOT NULL DEFAULT 0,
  invalid_rows        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,          -- received/validating/processing/completed/partial/failed
  checkpoint          INTEGER NOT NULL DEFAULT 0,  -- 已处理到的源行号，用于续传
  operator_id         TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  error_report_ref    TEXT,
  coverage_status     TEXT NOT NULL DEFAULT 'unknown',   -- unknown/partial/complete
  coverage_confirmed_by TEXT,
  date_semantics      TEXT NOT NULL DEFAULT 'unconfirmed', -- 生成日期是否等于上课日期：unconfirmed/confirmed_same/mapped
  date_evidence       TEXT                    -- 上述判断的证据 JSON，由接入层自动采集，不可人工直填
);
CREATE INDEX IF NOT EXISTS ix_batch_digest ON import_batch(tenant_id, source_type, source_digest);

CREATE TABLE IF NOT EXISTS raw_attendance (
  raw_id              TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  batch_id            TEXT NOT NULL,
  source_type         TEXT NOT NULL,          -- 与 import_batch.source_type 一致，便于按来源追溯
  source_row_number   INTEGER NOT NULL,       -- 来源内序号：Excel 行号或 API 记录序号
  source_key          TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  source_record_id    TEXT,
  name_raw            TEXT,
  class_raw           TEXT,
  course_raw          TEXT,
  teacher_raw         TEXT,
  period_raw          TEXT,
  room_raw            TEXT,
  week_raw            TEXT,
  sign_time_raw       TEXT,
  raw_result          TEXT,
  raw_way             TEXT,
  att_date_raw        TEXT,
  ingested_at         TEXT NOT NULL,
  validation_status   TEXT NOT NULL           -- accepted/duplicate/superseded/invalid/unmatched
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_raw_version ON raw_attendance(tenant_id, source_key, payload_hash);
CREATE INDEX IF NOT EXISTS ix_raw_batch ON raw_attendance(batch_id, source_row_number);

-- 导入数据错误 / 映射异常队列。与考勤业务状态"待处理"严格分开。
CREATE TABLE IF NOT EXISTS import_exception (
  exception_id        TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  batch_id            TEXT NOT NULL,
  raw_id              TEXT,
  source_row_number   INTEGER,
  kind                TEXT NOT NULL,          -- missing_date/invalid_period/unknown_class/unmatched_student/ambiguous_student/missing_required
  detail              TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',  -- open/resolved/ignored
  resolved_by         TEXT,
  resolved_at         TEXT,
  resolution_note     TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_exception_open ON import_exception(tenant_id, status, kind);

-- 某班某日数据是否已齐：只能由辅导员显式确认，不能由"导入成功"推断
CREATE TABLE IF NOT EXISTS data_coverage (
  coverage_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  class_id            TEXT NOT NULL,
  att_date            TEXT NOT NULL,
  coverage_status     TEXT NOT NULL,          -- unknown/partial/complete
  confirmed_by        TEXT,
  confirmed_at        TEXT,
  note                TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_coverage ON data_coverage(tenant_id, class_id, att_date);

-- ---------------------------------------------------------------- 考勤主事实表

CREATE TABLE IF NOT EXISTS attendance (
  attendance_id       TEXT PRIMARY KEY,
  business_key        TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  term_id             TEXT NOT NULL,
  student_id          TEXT NOT NULL,
  student_no_snapshot TEXT NOT NULL,
  name_snapshot       TEXT NOT NULL,
  class_id            TEXT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  session_id          TEXT,
  course_name         TEXT NOT NULL,
  teacher             TEXT,
  room                TEXT,
  week                INTEGER,
  att_date            TEXT NOT NULL,
  period              INTEGER NOT NULL,
  raw_id              TEXT NOT NULL,
  batch_id            TEXT NOT NULL,
  raw_result          TEXT,
  raw_way             TEXT,
  sign_time           TEXT,
  base_judgment       TEXT NOT NULL,          -- 正常/旷课/迟到/早退/待处理
  leave_ids           TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  manual_judgment     TEXT,
  manual_event_id     TEXT,
  final_judgment      TEXT NOT NULL,          -- 正常/旷课/迟到/早退/请假/待处理
  judgment_reason     TEXT NOT NULL,
  rule_version        TEXT NOT NULL,
  business_revision   INTEGER NOT NULL DEFAULT 1,
  public_until        TEXT,
  locked_at           TEXT,
  last_appeal_id      TEXT,
  applied_event_id    TEXT,
  needs_review        INTEGER NOT NULL DEFAULT 0,  -- 冲突进入辅导员复核
  review_reason       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_bk ON attendance(business_key);
CREATE INDEX IF NOT EXISTS ix_att_student_date ON attendance(tenant_id, student_id, att_date);
CREATE INDEX IF NOT EXISTS ix_att_class_date ON attendance(tenant_id, class_id, att_date);
CREATE INDEX IF NOT EXISTS ix_att_date_final ON attendance(tenant_id, att_date, final_judgment);
CREATE INDEX IF NOT EXISTS ix_att_pending ON attendance(tenant_id, class_id, final_judgment);
CREATE INDEX IF NOT EXISTS ix_att_review ON attendance(tenant_id, needs_review);

-- ---------------------------------------------------------------- 请假

CREATE TABLE IF NOT EXISTS leave_request (
  leave_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  applicant_user_id   TEXT NOT NULL,
  on_behalf           INTEGER NOT NULL DEFAULT 0,
  leave_type          TEXT NOT NULL,          -- public/sick/personal/other
  start_date          TEXT NOT NULL,
  end_date            TEXT NOT NULL,
  periods             TEXT NOT NULL DEFAULT '[]',  -- JSON 整数集合，空数组=全天
  reason              TEXT NOT NULL,
  evidence_refs       TEXT NOT NULL DEFAULT '[]',
  external_instance_id TEXT,
  approval_template_version TEXT,
  approval_status     TEXT NOT NULL,          -- draft/submitted/approved/rejected/cancelled
  approval_version    INTEGER NOT NULL DEFAULT 0,
  apply_status        TEXT NOT NULL DEFAULT 'pending',  -- pending/applying/applied/failed
  approver_user_id    TEXT,
  approval_comment    TEXT,
  approved_at         TEXT,
  revoke_status       TEXT NOT NULL DEFAULT 'none',     -- none/requested/confirmed/rejected
  revoke_instance_id  TEXT,
  revoke_reason       TEXT,
  revoked_at          TEXT,
  submission_id       TEXT,                   -- 表单 submission，用于重复提交返回同一单号
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_instance ON leave_request(external_instance_id) WHERE external_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_submission ON leave_request(submission_id) WHERE submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS leave_member (
  member_id           TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  leave_id            TEXT NOT NULL,
  student_id          TEXT NOT NULL,
  student_no_snapshot TEXT NOT NULL,
  class_id_snapshot   TEXT NOT NULL,
  apply_status        TEXT NOT NULL DEFAULT 'pending',
  affected_record_count INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_member ON leave_member(leave_id, student_id);
CREATE INDEX IF NOT EXISTS ix_leave_member_student ON leave_member(tenant_id, student_id);

-- ---------------------------------------------------------------- 申诉

CREATE TABLE IF NOT EXISTS appeal (
  appeal_id           TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  attendance_id       TEXT NOT NULL,
  student_id          TEXT NOT NULL,
  applicant_user_id   TEXT NOT NULL,
  on_behalf           INTEGER NOT NULL DEFAULT 0,
  reason              TEXT NOT NULL,
  evidence_refs       TEXT NOT NULL DEFAULT '[]',
  requested_judgment  TEXT NOT NULL DEFAULT '正常',
  original_judgment   TEXT NOT NULL,
  original_revision   INTEGER NOT NULL,
  status              TEXT NOT NULL,          -- submitted/reviewing/approved/rejected/withdrawn/locked
  stage               TEXT NOT NULL,          -- first/second/counselor/done
  first_deadline      TEXT NOT NULL,
  reviewer_scope      TEXT,
  current_assignee    TEXT,
  external_instance_id TEXT,
  approval_template_version TEXT,
  source_approval_version INTEGER NOT NULL DEFAULT 0,
  apply_status        TEXT NOT NULL DEFAULT 'pending',
  final_at            TEXT,
  public_until        TEXT,
  locked_at           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_appeal_att ON appeal(attendance_id, status);
CREATE INDEX IF NOT EXISTS ix_appeal_student ON appeal(tenant_id, student_id);
CREATE INDEX IF NOT EXISTS ix_appeal_stage ON appeal(tenant_id, status, stage);

CREATE TABLE IF NOT EXISTS appeal_step (
  step_id             TEXT PRIMARY KEY,
  appeal_id           TEXT NOT NULL,
  stage               TEXT NOT NULL,
  assignee_user_id    TEXT,
  assignee_role       TEXT,
  decision            TEXT,                   -- approved/rejected/escalated/timeout
  comment             TEXT,
  decided_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_step_appeal ON appeal_step(appeal_id, created_at);

-- ---------------------------------------------------------------- 判定事件与审计

CREATE TABLE IF NOT EXISTS review_event (
  event_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  attendance_id       TEXT NOT NULL,
  action              TEXT NOT NULL,          -- pending_confirm/manual_override/appeal_apply/manual_revoke/leave_apply/source_update/counselor_review
  from_judgment       TEXT,
  to_judgment         TEXT,
  before_revision     INTEGER,
  after_revision      INTEGER,
  reason              TEXT NOT NULL,
  evidence_refs       TEXT NOT NULL DEFAULT '[]',
  operator_user_id    TEXT NOT NULL,
  related_request_id  TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_event_att ON review_event(attendance_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  actor_user_id       TEXT NOT NULL,
  actor_role_snapshot TEXT,
  scope_snapshot      TEXT,
  action              TEXT NOT NULL,
  entity_type         TEXT,
  entity_id           TEXT,
  before_ref          TEXT,
  after_ref           TEXT,
  reason              TEXT,
  source_event_id     TEXT,
  result              TEXT NOT NULL,
  occurred_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(tenant_id, entity_id, occurred_at);

-- ---------------------------------------------------------------- 汇总

CREATE TABLE IF NOT EXISTS daily_stat (
  stat_key            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  scope_type          TEXT NOT NULL,          -- student/class/college
  scope_id            TEXT NOT NULL,
  att_date            TEXT NOT NULL,
  judgment            TEXT NOT NULL,
  count               INTEGER NOT NULL,
  source_watermark    TEXT NOT NULL,
  reconciliation_status TEXT NOT NULL DEFAULT 'ok',
  last_rebuilt_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stat_scope ON daily_stat(tenant_id, scope_type, scope_id, att_date);

-- ---------------------------------------------------------------- 任务、消息、审批事件

CREATE TABLE IF NOT EXISTS event_job (
  event_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  entity_type         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  source_version      INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,          -- queued/running/succeeded/retry/dead
  payload_ref         TEXT NOT NULL DEFAULT '{}',
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_retry_at       TEXT,
  lease_owner         TEXT,
  lease_until         TEXT,
  checkpoint          TEXT,
  last_error          TEXT,
  run_after           TEXT,
  created_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_idem ON event_job(idempotency_key);
CREATE INDEX IF NOT EXISTS ix_job_runnable ON event_job(status, run_after);

CREATE TABLE IF NOT EXISTS notification (
  notification_id     TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  message_key         TEXT NOT NULL,
  receiver_user_id    TEXT NOT NULL,
  student_id          TEXT,
  kind                TEXT NOT NULL,
  business_date       TEXT,
  business_ref        TEXT,
  summary_version     TEXT,
  payload_ref         TEXT NOT NULL,
  status              TEXT NOT NULL,          -- queued/sending/sent/failed/unknown/skipped
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_retry_at       TEXT,
  platform_message_id TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  sent_at             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_key ON notification(message_key);
CREATE INDEX IF NOT EXISTS ix_notification_status ON notification(tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_notification_receiver ON notification(receiver_user_id, created_at);

-- 轻审批实例投影：审批过程的权威来源在平台，此处只保存结果投影
CREATE TABLE IF NOT EXISTS approval_instance (
  instance_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  template_version    TEXT NOT NULL,
  business_type       TEXT NOT NULL,          -- leave/leave_revoke/appeal
  business_id         TEXT NOT NULL,
  applicant_user_id   TEXT NOT NULL,
  state               TEXT NOT NULL,          -- running/approved/rejected/cancelled
  stage               TEXT,
  current_assignee    TEXT,
  version             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_approval_business ON approval_instance(business_type, business_id);

-- 审批平台事件出口（模拟平台回调/事件流）。
-- 业务侧不直接信任这里的内容：drain 后必须回查 Approval.fetchState 的权威状态再生效。
CREATE TABLE IF NOT EXISTS approval_outbox (
  outbox_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id         TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  version             INTEGER NOT NULL,
  occurred_at         TEXT NOT NULL,
  delivered           INTEGER NOT NULL DEFAULT 0,
  delivery_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON approval_outbox(delivered, outbox_id);

-- 已受理的标准事件，用于重复/乱序识别
CREATE TABLE IF NOT EXISTS approval_event (
  event_id            TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  source_instance_id  TEXT NOT NULL,
  source_version      INTEGER NOT NULL,
  occurred_at         TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  actor_id            TEXT,
  payload_ref         TEXT NOT NULL DEFAULT '{}',
  accepted            INTEGER NOT NULL DEFAULT 1,
  drop_reason         TEXT
);
CREATE INDEX IF NOT EXISTS ix_apevent_instance ON approval_event(source_instance_id, source_version);

-- ---------------------------------------------------------------- 配置与运行

CREATE TABLE IF NOT EXISTS policy_setting (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL,
  decision_ref        TEXT,                   -- 对应 01 决策表编号，如 D06
  confirmed           INTEGER NOT NULL DEFAULT 0,  -- 0=测试默认值，未经业务确认
  note                TEXT,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_partition (
  partition_id        TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  college_id          TEXT NOT NULL,
  term_id             TEXT NOT NULL,
  date_from           TEXT,
  date_to             TEXT,
  logical_table       TEXT NOT NULL,
  workspace_ref       TEXT,
  table_ref           TEXT,
  schema_version      TEXT NOT NULL,
  status              TEXT NOT NULL,
  retention_policy    TEXT,
  last_backup_at      TEXT
);

CREATE TABLE IF NOT EXISTS app_session (
  session_token       TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  wps_user_id         TEXT NOT NULL,
  issued_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);

-- 附件受限存放：正文不进审计日志，访问需服务端鉴权
CREATE TABLE IF NOT EXISTS evidence_file (
  evidence_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  owner_student_id    TEXT,
  business_type       TEXT NOT NULL,
  business_id         TEXT,
  file_name           TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  storage_ref         TEXT NOT NULL,
  uploaded_by         TEXT NOT NULL,
  sensitivity         TEXT NOT NULL DEFAULT 'restricted',  -- restricted=病假证据一类
  created_at          TEXT NOT NULL
);
