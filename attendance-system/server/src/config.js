// 业务政策与运行配置。
//
// docs/baseline/01 决策表中待业务确认的口径，全部在此作为"明确标注的测试默认值"存在。
// confirmed:false 的条目在 /api/admin/policies 与验收报告中会被标为未确认；
// 系统在 REQUIRE_CONFIRMED_POLICY=1 时拒绝对真实学生执行自动改判与消息推送。

export const TENANT_ID = process.env.TENANT_ID || 'tenant_school';
export const COLLEGE_ID = process.env.COLLEGE_ID || 'college_dxyt'; // 电子与通信工程学院
export const DEFAULT_TERM = process.env.TERM_ID || '2026-2027-1';

/** 判定规则版本。规则表或政策一旦变化必须提升版本，历史记录保留其生效时的版本。 */
export const RULE_VERSION = 'rules-v1.0-testdefault';

/** 基础判定：原始结果 × 原始方式 -> 基础结果。对应 03 §2.1，不得在代码其他位置散落判定分支。 */
export const BASE_RULE_TABLE = {
  // 有效签到方式白名单。不自行扩展；新方式一律落入待处理。
  validWays: ['刷脸', 'istudy', '二维码'],
  // 视为"到场但不算正常"的方式。D06：正常＋刷卡记为旷课，属业务政策。
  cardWay: '刷卡',
  resultAliases: {
    '正常': '正常', '迟到': '迟到', '早退': '早退', '旷课': '旷课',
    '缺勤': '旷课', '未打卡': '旷课',
  },
  wayAliases: {
    '刷脸': '刷脸', '人脸': '刷脸', '人脸识别': '刷脸',
    'istudy': 'istudy', 'iStudy': 'istudy', 'ISTUDY': 'istudy',
    '二维码': '二维码', '扫码': '二维码',
    '刷卡': '刷卡', '校园卡': '刷卡',
  },
};

export const JUDGMENTS = ['正常', '旷课', '迟到', '早退', '请假', '待处理'];
/** 界面上"待处理"展示为"待核实"，但业务枚举值不变。 */
export const JUDGMENT_DISPLAY = {'待处理': '待核实'};

export const POLICY_DEFAULTS = [
  {
    key: 'rule.card_swipe_is_absent', value: 'true', decision_ref: 'D06', confirmed: false,
    note: '原始"正常"＋方式"刷卡"判为旷课。沿用 v4 业务政策，上线前须业务负责人确认。',
  },
  {
    key: 'rule.unknown_way_is_pending', value: 'true', decision_ref: 'D07', confirmed: true,
    note: '方式为空或未知一律待处理，不猜正常也不猜旷课。防御性设计，已在设计中确定。',
  },
  {
    key: 'appeal.allow_early_leave', value: 'false', decision_ref: 'D08', confirmed: false,
    note: '早退是否开放申诉。默认关闭；验收须覆盖开启与关闭两种配置。',
  },
  {
    key: 'rule.leave_covers_base_absent_only', value: 'true', decision_ref: 'D09', confirmed: false,
    note: '先算基础判定，再用已批准请假覆盖"基础旷课"。请假不消除迟到/早退/待处理。',
  },
  {
    key: 'rule.manual_judgment_wins', value: 'true', decision_ref: 'D10', confirmed: false,
    note: '有效人工结论优先于请假与新来源；冲突不静默覆盖，转辅导员复核。',
  },
  {
    key: 'appeal.public_days', value: '7', decision_ref: 'D11/D16', confirmed: false,
    note: '申诉成立后公示天数。D16：自考勤实际更正生效时起算，非终审时刻。',
  },
  {
    key: 'appeal.first_stage_hours', value: '168', decision_ref: '03§5.3', confirmed: true,
    note: '一审时限 7×24 小时，超时后原一审人处理权失效，转辅导员代审。',
  },
  {
    key: 'appeal.second_stage_reminder_hours', value: '168', decision_ref: '03§5.3', confirmed: false,
    note: '二审无硬性期限，仅逾期提醒阈值，可配置。',
  },
  {
    key: 'stat.abnormal_definition', value: '旷课,迟到,早退', decision_ref: 'D17', confirmed: false,
    note: '异常节次口径。待核实单列；v4 的"旷课＋待处理"另名为"需关注记录"，不混用。',
  },
  {
    key: 'leave.normal_student_can_apply_single', value: 'true', decision_ref: 'D12', confirmed: false,
    note: '普通学生可为本人申请请假；多人公假仅学生干部与辅导员可发起。',
  },
  {
    key: 'leave.cross_counselor_requires_split', value: 'true', decision_ref: 'D22', confirmed: false,
    note: '一张多人公假单默认只含同一负责辅导员范围的学生，跨范围提示拆单。',
  },
  {
    key: 'appeal.cadre_second_stage_scope', value: 'class', decision_ref: 'D14', confirmed: false,
    note: '学生干部二审默认仅限授权班级，不默认全院。',
  },
  {
    key: 'review.self_review_forbidden', value: 'true', decision_ref: 'D18', confirmed: true,
    note: '待处理核对同样执行防自审，本人记录转其他授权人或辅导员。',
  },
  {
    key: 'notify.student_daily_hour', value: '21', decision_ref: 'D04', confirmed: false,
    note: '学生个人日报发送时刻（北京时间），可配置。',
  },
  {
    key: 'notify.counselor_daily_hour', value: '21', decision_ref: 'D04', confirmed: false,
    note: '辅导员日报发送时刻（北京时间）。',
  },
  {
    key: 'notify.whitelist_only', value: 'true', decision_ref: '06 实施原则4', confirmed: true,
    note: '消息默认只发测试白名单。接入真实 IM 前不得对真实学生发送。',
  },
  {
    key: 'import.date_semantics_confirmed', value: 'false', decision_ref: 'AT-018', confirmed: false,
    note: '来源"生成日期"是否等于实际上课日期，未经学校确认。未确认时导入按待确认标注，不直接替代上课日期。',
  },
  {
    key: 'import.expand_period_range', value: 'false', decision_ref: '02§4', confirmed: false,
    note: '来源一行覆盖多节（如"1-4节"）时是否展开成多条考勤。默认否：无法证明一次签到覆盖每一节，'
      + '隔离待来源粒度确认，不直接复制成多条正常。',
  },
  {
    key: 'lock.auto_rejudge_forbidden', value: 'true', decision_ref: 'D21', confirmed: true,
    note: '公示锁定后拒绝普通自动改判，改为生成辅导员复核任务。',
  },
  {
    key: 'appeal.no_parallel_during_public', value: 'true', decision_ref: 'D23', confirmed: false,
    note: '公示期内不开平行申诉，新异议走辅导员复核。',
  },
];

/** 运行参数。性能目标见 docs/baseline/04 §6，此处是实现侧的批量与调度参数。 */
export const RUNTIME = {
  ingestBatchSize: Number(process.env.INGEST_BATCH_SIZE || 1000),
  jobPollMs: Number(process.env.JOB_POLL_MS || 500),
  jobLeaseSeconds: Number(process.env.JOB_LEASE_SECONDS || 60),
  jobMaxAttempts: Number(process.env.JOB_MAX_ATTEMPTS || 5),
  appealScanMinutes: Number(process.env.APPEAL_SCAN_MINUTES || 10),
  queryPageLimit: Number(process.env.QUERY_PAGE_LIMIT || 50),
  queryMaxLimit: 200,
  sessionHours: 12,
};

export const REQUIRE_CONFIRMED_POLICY = process.env.REQUIRE_CONFIRMED_POLICY === '1';
