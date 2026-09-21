/**
 * FRONTEND CONTRACT PROPOSAL v1.1, 2026-09-20.
 * Documentation only; not imported by src, not a WPS SDK, no live implementation.
 * Provider mapping and business-policy confirmation are prerequisites to real use.
 */
export type Judgment = '正常' | '旷课' | '迟到' | '早退' | '请假' | '待处理';
export type Role = 'student' | 'monitor' | 'student_cadre' | 'counselor' | 'admin';
export type WorkStatus = 'open' | 'in_progress' | 'completed';
export type ApplyStatus = 'pending' | 'applying' | 'applied' | 'failed';
export type Coverage = 'unknown' | 'partial' | 'complete';
export type Action = 'view' | 'follow_up' | 'confirm_present' | 'confirm_absent'
  | 'apply_leave' | 'appeal' | 'counselor_review';
export interface Scope { type: 'self' | 'class' | 'college'; id: string }
export interface Assignment {
  role: Role; scope: Scope; valid_from: string; valid_to: string | null;
}
export interface Session {
  tenant_id: string; college_id: string; user_id: string; display_name: string;
  student_id: string | null; mapping_status: 'verified' | 'unresolved' | 'conflict' | 'disabled';
  assignments: Assignment[];
}
export interface Query {
  date_from: string; date_to: string; term_id: string;
  // Requested narrowing only: the service intersects this with authenticated rights.
  requested_scope: Scope;
  judgments?: Judgment[]; search?: string; cursor?: string | null; limit: number;
}
export interface Page<T> {
  items: T[]; next_cursor: string | null; has_more: boolean; total: number | null;
  source_watermark: string; updated_at: string;
}
export interface WorkItem {
  work_item_id: string;
  kind: 'verification' | 'follow_up' | 'appeal_review' | 'sync_recovery';
  status: WorkStatus; revision: number; updated_at: string;
  latest_note: string | null;
}
export interface ReviewEvent {
  event_id: string; action: string; operator_user_id: string; occurred_at: string;
  reason: string; from_judgment: Judgment; to_judgment: Judgment;
  before_revision: number; after_revision: number;
}
export interface AttendanceRecord {
  attendance_id: string; tenant_id: string; college_id: string; term_id: string;
  student_id: string; student_no_snapshot: string; name_snapshot: string;
  class_id: string; class_name_snapshot: string;
  session_id: string | null; course_name: string; room: string | null;
  att_date: string; period: number; // confirmed single period 1..12
  raw_id: string; batch_id: string;
  raw_result: string | null; raw_way: string | null; sign_time: string | null;
  base_judgment: Exclude<Judgment, '请假'>;
  manual_judgment: Judgment | null; leave_ids: string[];
  final_judgment: Judgment; judgment_reason: string; rule_version: string;
  business_revision: number; applied_event_id: string; updated_at: string;
  public_until: string | null; locked_at: string | null;
  work_item: WorkItem | null;
  allowed_actions: Action[]; // display hints only; server rechecks every mutation
}
export interface AttendanceDetail extends AttendanceRecord {
  review_events: ReviewEvent[];
  application_refs: Array<{ request_id: string; kind: 'leave' | 'appeal' }>;
  // Restricted attachments must be filtered/authorized by service before return.
  evidence_refs: string[];
}
export interface Summary {
  scope: Scope; date_from: string; date_to: string; unit: 'student_period';
  counts: Record<Judgment, number>;
  total_imported_periods: number; abnormal_periods: number;
  pending_verification_periods: number; coverage_status: Coverage;
  // Never invent an expected denominator or policy from mock data.
  expected_periods: number | null; attendance_rate: number | null;
  rate_definition_id: string | null;
  source_watermark: string; updated_at: string;
}
export interface ReviewCommand {
  attendance_id: string;
  action: 'confirm_present' | 'confirm_absent';
  reason: string; evidence_refs: string[];
  expected_revision: number; idempotency_key: string;
  // No user-selected actor identity or arbitrary final_judgment in request.
}
export interface FollowUpCommand {
  work_item_id: string; note: string;
  expected_revision: number; idempotency_key: string;
}
export interface Operation {
  operation_id: string; apply_status: ApplyStatus;
  attendance_id: string; resulting_revision: number | null;
  error_code: string | null; updated_at: string;
}
export interface ApplicationState {
  request_id: string; kind: 'leave' | 'appeal';
  approval_status: string; stage: string | null;
  apply_status: ApplyStatus; approved_at: string | null; effective_at: string | null;
  updated_at: string;
}
export interface AppError {
  code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'REVISION_CONFLICT'
    | 'VALIDATION_ERROR' | 'RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | 'RESULT_UNKNOWN';
  message: string; request_id: string; retryable: boolean;
  retry_after_seconds?: number; operation_id?: string;
  field_errors?: Record<string, string>;
}
export interface AttendanceProvider {
  resolveSession(): Promise<Session>;
  listAttendance(query: Query): Promise<Page<AttendanceRecord>>;
  getAttendanceDetail(attendance_id: string): Promise<AttendanceDetail>;
  getSummary(query: Query): Promise<Summary>;
  submitReview(command: ReviewCommand): Promise<Operation>;
  saveFollowUp(command: FollowUpCommand): Promise<WorkItem>;
  getOperationState(operation_id: string): Promise<Operation>;
  getApplicationState(request_id: string): Promise<ApplicationState>;
}
// Import/export/platform APIs are catalogued in 03_接口与字段约定.md.
// Their provider-specific transport is intentionally not fabricated here.

