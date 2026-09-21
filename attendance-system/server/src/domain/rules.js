// 考勤判定规则引擎。
//
// 对应 docs/baseline/03 §2。全部是确定性规则：
// 同样的输入永远得到同样的输出，且每个结论都带可解释的理由与规则版本。
// **不使用任何模型推断**来判断某个学生是否旷课。
//
// 这里只做纯计算，不读写台账、不发消息。副作用全部在 domain/writer.js。

import {BASE_RULE_TABLE, RULE_VERSION} from '../config.js';
import {normalizeResult, normalizeWay} from '../ingestion/normalize.js';

export {RULE_VERSION};

export const JUDGMENT = {
  NORMAL: '正常', ABSENT: '旷课', LATE: '迟到', EARLY: '早退',
  LEAVE: '请假', PENDING: '待处理',
};

/**
 * 基础判定：原始结果 × 原始方式 -> 基础结果。
 *
 * | 原始结果 | 原始方式        | 基础结果 |
 * | 正常     | 刷脸/istudy/二维码 | 正常   |
 * | 正常     | 刷卡            | 旷课   |  ← D06 业务政策，由 policy 开关控制
 * | 正常     | 空值或未知方式   | 待处理 |
 * | 迟到     | 任意            | 迟到   |
 * | 早退     | 任意            | 早退   |
 * | 旷课     | 任意            | 旷课   |
 * | 其他     | 任意            | 待处理 |
 *
 * @param {{raw_result:string, raw_way:string}} input 原始值（未规范化）
 * @param {{cardSwipeIsAbsent:boolean}} policy
 */
export function computeBaseJudgment({raw_result: rawResult, raw_way: rawWay}, policy) {
  const result = normalizeResult(rawResult);
  const way = normalizeWay(rawWay);

  if (result === null) {
    return {
      judgment: JUDGMENT.PENDING,
      reason: `原始结果「${String(rawResult ?? '').trim() || '空'}」不在已确认的结果值域内，不猜测为正常或旷课`,
      rule: 'base.unknown_result',
    };
  }

  if (result === JUDGMENT.LATE || result === JUDGMENT.EARLY || result === JUDGMENT.ABSENT) {
    return {
      judgment: result,
      reason: `原始结果为「${result}」，与方式无关`,
      rule: 'base.result_direct',
    };
  }

  // result === 正常，此时方式决定结论
  if (way === null) {
    return {
      judgment: JUDGMENT.PENDING,
      reason: `原始结果为正常，但考勤方式「${String(rawWay ?? '').trim()}」不在已确认的方式值域内`,
      rule: 'base.unknown_way',
    };
  }
  if (way === '') {
    return {
      judgment: JUDGMENT.PENDING,
      reason: '原始结果为正常，但考勤方式为空，无法确认签到真实性',
      rule: 'base.empty_way',
    };
  }
  if (way === BASE_RULE_TABLE.cardWay) {
    return policy.cardSwipeIsAbsent
      ? {
        judgment: JUDGMENT.ABSENT,
        reason: '原始结果为正常但方式为刷卡；按学院规则刷卡不计为到课（决策 D06）',
        rule: 'base.card_swipe_absent',
      }
      : {
        judgment: JUDGMENT.NORMAL,
        reason: '原始结果为正常，方式为刷卡；当前配置下刷卡计为到课',
        rule: 'base.card_swipe_normal',
      };
  }
  if (BASE_RULE_TABLE.validWays.includes(way)) {
    return {
      judgment: JUDGMENT.NORMAL,
      reason: `原始结果为正常，方式为${way}`,
      rule: 'base.valid_way',
    };
  }
  return {
    judgment: JUDGMENT.PENDING,
    reason: `方式「${way}」已识别但不在有效签到方式集合内`,
    rule: 'base.way_not_effective',
  };
}

/**
 * 最终判定。顺序严格按 03 §2.2：
 *
 *   若存在有效人工结论：采用人工结论；与请假或新来源冲突则列入辅导员复核
 *   否则若基础结果是旷课且存在有效请假：最终 = 请假
 *   否则：最终 = 基础结果
 *
 * @param {object} input
 * @param {{judgment:string, reason:string}} input.base 基础判定
 * @param {Array<{leave_id:string, leave_type:string}>} input.activeLeaves 覆盖本记录的有效请假
 * @param {{judgment:string, event_id:string}|null} input.manual 有效人工结论
 * @param {{manualWins:boolean, leaveCoversBaseAbsentOnly:boolean}} policy
 * @returns {{final:string, reason:string, rule:string, needsReview:boolean, reviewReason:string|null, leaveIds:string[]}}
 */
export function computeFinalJudgment({base, activeLeaves = [], manual = null}, policy) {
  const leaveIds = activeLeaves.map((l) => l.leave_id);

  if (manual && manual.judgment) {
    // 人工结论优先。但与请假冲突时不静默吞掉，转辅导员复核。
    const conflict = activeLeaves.length > 0 && manual.judgment !== JUDGMENT.LEAVE;
    return {
      final: manual.judgment,
      reason: `采用人工结论「${manual.judgment}」（事件 ${manual.event_id}）；${base.reason}`,
      rule: 'final.manual_override',
      needsReview: conflict && policy.manualWins,
      reviewReason: conflict
        ? '存在有效人工结论，同时命中已批准请假，两者结论不一致，需辅导员复核'
        : null,
      leaveIds,
    };
  }

  if (activeLeaves.length > 0) {
    if (base.judgment === JUDGMENT.ABSENT) {
      const types = [...new Set(activeLeaves.map((l) => l.leave_type))].join('/');
      return {
        final: JUDGMENT.LEAVE,
        reason: `基础判定为旷课，命中已批准请假（${types}，共 ${activeLeaves.length} 张），按请假计`,
        rule: 'final.leave_covers_absent',
        needsReview: false,
        reviewReason: null,
        leaveIds,
      };
    }
    if (policy.leaveCoversBaseAbsentOnly) {
      // 请假只覆盖基础旷课。迟到/早退/待处理保持原状，并在理由里留痕。
      return {
        final: base.judgment,
        reason: `${base.reason}；虽命中已批准请假，但请假只覆盖基础旷课（决策 D09），本条保持「${base.judgment}」`,
        rule: 'final.leave_not_applicable',
        needsReview: false,
        reviewReason: null,
        leaveIds,
      };
    }
    return {
      final: JUDGMENT.LEAVE,
      reason: `命中已批准请假，当前配置下请假覆盖所有基础结果`,
      rule: 'final.leave_covers_all',
      needsReview: false,
      reviewReason: null,
      leaveIds,
    };
  }

  return {
    final: base.judgment,
    reason: base.reason,
    rule: 'final.base',
    needsReview: false,
    reviewReason: null,
    leaveIds,
  };
}

/**
 * 判断一张已批准请假是否覆盖某条考勤。
 * periods 为空数组表示全天；否则按日期范围内每天的相同节次生效。
 */
export function leaveCovers(leave, {att_date: attDate, period}) {
  if (attDate < leave.start_date || attDate > leave.end_date) return false;
  const periods = Array.isArray(leave.periods) ? leave.periods : [];
  if (periods.length === 0) return true;
  return periods.includes(period);
}
