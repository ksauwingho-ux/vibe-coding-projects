// 考勤接入管线 —— 与来源无关。
//
// 输入：任何实现了 AttendanceSource 的来源（Excel 文件 / 学校 API / 后续来源）。
// 输出：raw_attendance（只增不改的原始版本）＋ attendance（带版本的正式考勤）
//       ＋ import_exception（数据错误与映射异常，与业务状态"待处理"严格分开）。
//
// 本文件不 import 任何来源实现，也不认识文件、工作表或列 —— 只认标准化记录。

import {Table} from '../adapters/table.js';
import {newId, nowUtc, stableHash, sha256, chunk} from '../lib/util.js';
import {TENANT_ID, COLLEGE_ID, RUNTIME} from '../config.js';
import {
  normalizeText, normalizeDate, normalizePeriods, normalizeSignTime,
  normalizeWeek, normalizeResult, normalizeWay,
} from './normalize.js';
import {computeBaseJudgment, computeFinalJudgment, RULE_VERSION} from '../domain/rules.js';
import {rulePolicySnapshot, getBool} from '../domain/policy.js';
import {activeLeavesFor} from '../domain/leave-index.js';

/* ------------------------------------------------------------ 组织映射缓存 */

function buildOrgIndex() {
  const classes = Table.all('class_profile', {where: {tenant_id: TENANT_ID}, limit: 5000});
  const byName = new Map();
  for (const c of classes) byName.set(c.class_name, c);
  for (const a of Table.all('class_alias', {where: {tenant_id: TENANT_ID}, limit: 5000})) {
    const cls = classes.find((c) => c.class_id === a.class_id);
    if (cls) byName.set(a.alias, cls);
  }

  // 姓名＋班级 -> 学生。同班同名会出现多个候选，必须隔离而不是随机归属。
  const students = Table.all('student_profile', {where: {tenant_id: TENANT_ID}, limit: 100000});
  const byNameClass = new Map();
  for (const s of students) {
    if (!s.current_class_id) continue;
    const key = `${s.name}\u0001${s.current_class_id}`;
    if (!byNameClass.has(key)) byNameClass.set(key, []);
    byNameClass.get(key).push(s);
  }
  return {classByName: byName, studentsByNameClass: byNameClass};
}

/* ------------------------------------------------------------ 键构造 */

/**
 * 来源逻辑键：同一条来源记录的稳定标识，用于识别"同键"。
 * 必须唯一定位到"某人某日某节某课"，少一个维度就会把不同学生的记录塌缩成同一条。
 */
function buildSourceKey(sourceSystem, n) {
  const parts = [TENANT_ID, sourceSystem, n.name, n.class_name, n.att_date, String(n.period), n.course_name];
  if (parts.some((p) => p == null || p === '')) {
    throw new Error(`INGEST_SOURCE_KEY_INCOMPLETE: ${JSON.stringify(parts)}`);
  }
  return sha256(parts.join('\u0001'));
}

/** 业务键：一名学生一日某课程某节，唯一确定一条正式考勤 */
function buildBusinessKey(termId, studentId, classId, attDate, period, courseName) {
  return sha256([TENANT_ID, termId, studentId, classId, attDate, String(period), courseName].join('\u0001'));
}

/** 内容摘要：判断"同键内容是否变化" */
function buildPayloadHash(n) {
  return stableHash({
    result: n.raw_result_norm ?? '', way: n.raw_way_norm ?? '',
    sign: n.sign_time ?? '', teacher: n.teacher ?? '', room: n.room ?? '', week: n.week ?? '',
  });
}

/* ------------------------------------------------------------ 单条标准化 */

/**
 * 把标准化记录转成管线内部形态，并做字段级校验。
 * @returns {{ok:true, value:object} | {ok:false, kind:string, detail:string}}
 */
function prepare(record) {
  const name = normalizeText(record.name_raw);
  const className = normalizeText(record.class_raw);
  const courseName = normalizeText(record.course_raw);
  const attDate = normalizeDate(record.att_date_raw);
  const periodInfo = normalizePeriods(record.period_raw);

  if (!name) return {ok: false, kind: 'missing_required', detail: '姓名为空'};
  if (!className) return {ok: false, kind: 'missing_required', detail: '班级名称为空'};
  if (!courseName) return {ok: false, kind: 'missing_required', detail: '课程名称为空'};
  if (!attDate) {
    return {ok: false, kind: 'missing_date', detail: `日期无法识别：「${record.att_date_raw}」`};
  }
  if (periodInfo.granularity === 'missing') {
    return {ok: false, kind: 'invalid_period', detail: '节次为空'};
  }
  if (periodInfo.granularity === 'invalid') {
    return {ok: false, kind: 'invalid_period', detail: `节次非法：「${record.period_raw}」，应为 1—12` };
  }
  if (periodInfo.granularity === 'range' && !getBool('import.expand_period_range', false)) {
    // 一行覆盖多节，但无法证明这一次签到覆盖了每一节。
    // 03 §4 明确禁止直接复制成多条正常，因此隔离待确认，不进入正式考勤。
    return {
      ok: false,
      kind: 'ambiguous_period_range',
      detail: `一行覆盖 ${periodInfo.periods.length} 节（${periodInfo.sourceText}），`
        + '无法证明签到覆盖每一节，已隔离待来源粒度确认',
    };
  }

  return {
    ok: true,
    value: {
      name,
      class_name: className,
      course_name: courseName,
      att_date: attDate,
      period: periodInfo.periods[0],
      source_period_text: periodInfo.sourceText,
      teacher: normalizeText(record.teacher_raw),
      room: normalizeText(record.room_raw),
      week: normalizeWeek(record.week_raw),
      sign_time: normalizeSignTime(record.sign_time_raw),
      raw_result: normalizeText(record.raw_result),
      raw_way: normalizeText(record.raw_way),
      raw_result_norm: normalizeResult(record.raw_result),
      raw_way_norm: normalizeWay(record.raw_way),
    },
  };
}

/* ------------------------------------------------------------ 主流程 */

/**
 * 接入一个来源。可重复调用同一 batch 续传。
 *
 * @param {import('./source.js').AttendanceSource} source
 * @param {object} opts
 * @param {string} opts.operatorId  操作人（辅导员/数据管理员）
 * @param {string} opts.termId
 * @param {boolean} [opts.dryRun]   只预览不落库
 * @param {string} [opts.resumeBatchId] 续传已有批次
 * @param {(progress:object)=>void} [opts.onProgress]
 */
export async function ingest(source, {
  operatorId, termId, dryRun = false, resumeBatchId = null, onProgress,
} = {}) {
  const descriptor = await source.describe();
  const policy = rulePolicySnapshot();

  // ---- 批次：新建或续传
  let batch;
  if (resumeBatchId) {
    batch = Table.get('import_batch', resumeBatchId);
    if (!batch) throw new Error(`INGEST_BATCH_NOT_FOUND: ${resumeBatchId}`);
    if (batch.status === 'completed') {
      return {batch_id: batch.batch_id, resumed: false, alreadyCompleted: true, report: batchReport(batch)};
    }
  } else {
    // 同来源同内容重复接入：提示而不是静默再来一遍。
    const prior = Table.all('import_batch', {
      where: {
        tenant_id: TENANT_ID,
        source_type: descriptor.source_type,
        source_digest: descriptor.source_digest,
        status: 'completed',
      },
      limit: 1,
    })[0];
    if (prior && !dryRun) {
      return {
        batch_id: prior.batch_id,
        duplicate_source: true,
        message: '相同来源内容此前已完整接入，未新增正式考勤',
        report: batchReport(prior),
      };
    }
    batch = createBatch(descriptor, {operatorId, termId, dryRun});
  }

  const org = buildOrgIndex();
  const counters = {
    total: batch.total_rows, valid: batch.valid_rows, inserted: batch.inserted_rows,
    duplicate: batch.duplicate_rows, conflict: batch.conflict_rows,
    unmatched: batch.unmatched_rows, invalid: batch.invalid_rows,
  };
  const dateEvidence = {signed_checked: 0, date_mismatch: 0, unsigned: 0, samples: []};
  const dates = new Set();
  const exceptions = [];
  const previewRows = [];

  for await (const page of source.read({
    fromRow: batch.checkpoint + 1 || 1,
    batchSize: RUNTIME.ingestBatchSize,
  })) {
    const prepared = [];
    for (const record of page) {
      counters.total += 1;
      const outcome = prepare(record);
      if (!outcome.ok) {
        counters.invalid += 1;
        exceptions.push(makeException(batch.batch_id, record, outcome.kind, outcome.detail));
        continue;
      }
      const n = outcome.value;
      dates.add(n.att_date);
      collectDateEvidence(dateEvidence, record, n);

      // 班级映射
      const cls = org.classByName.get(n.class_name);
      if (!cls) {
        counters.invalid += 1;
        exceptions.push(makeException(batch.batch_id, record, 'unknown_class',
          `班级名称「${n.class_name}」未匹配到班级档案，可在映射异常页登记别名后重试`));
        continue;
      }

      // 身份映射：姓名＋发生时班级。唯一匹配才关联，否则隔离，绝不猜学号。
      const candidates = org.studentsByNameClass.get(`${n.name}\u0001${cls.class_id}`) ?? [];
      if (candidates.length === 0) {
        counters.unmatched += 1;
        exceptions.push(makeException(batch.batch_id, record, 'unmatched_student',
          `名册中未找到「${cls.class_name} · ${n.name}」，原始行已隔离待映射`));
        continue;
      }
      if (candidates.length > 1) {
        counters.unmatched += 1;
        exceptions.push(makeException(batch.batch_id, record, 'ambiguous_student',
          `「${cls.class_name} · ${n.name}」存在 ${candidates.length} 名同班同名学生，不随机归属`));
        continue;
      }

      counters.valid += 1;
      prepared.push({record, n, cls, student: candidates[0]});
    }

    if (dryRun) {
      for (const p of prepared.slice(0, Math.max(0, 20 - previewRows.length))) {
        const base = computeBaseJudgment(p.n, policy);
        previewRows.push({
          姓名: p.n.name, 班级: p.cls.class_name, 课程: p.n.course_name,
          日期: p.n.att_date, 节次: p.n.period,
          原始结果: p.n.raw_result, 原始方式: p.n.raw_way || '(空)',
          基础判定: base.judgment, 理由: base.reason,
        });
      }
      const last = page[page.length - 1];
      if (last) batch.checkpoint = last.source_row_number;
      onProgress?.({...counters, checkpoint: batch.checkpoint});
      continue;
    }

    persistPage(prepared, {batch, descriptor, termId, policy, counters});

    const last = page[page.length - 1];
    if (last) {
      batch.checkpoint = last.source_row_number;
      Table.updateRecord('import_batch', batch.batch_id, {
        checkpoint: batch.checkpoint,
        total_rows: counters.total, valid_rows: counters.valid,
        inserted_rows: counters.inserted, duplicate_rows: counters.duplicate,
        conflict_rows: counters.conflict, unmatched_rows: counters.unmatched,
        invalid_rows: counters.invalid,
      });
    }
    onProgress?.({...counters, checkpoint: batch.checkpoint});
  }

  if (!dryRun && exceptions.length) {
    for (const slice of chunk(exceptions, 400)) Table.createBatch('import_exception', slice);
  }

  const sortedDates = [...dates].sort();
  const semantics = judgeDateSemantics(dateEvidence);
  const finalPatch = {
    status: dryRun ? 'validating' : 'completed',
    total_rows: counters.total, valid_rows: counters.valid, inserted_rows: counters.inserted,
    duplicate_rows: counters.duplicate, conflict_rows: counters.conflict,
    unmatched_rows: counters.unmatched, invalid_rows: counters.invalid,
    date_from: sortedDates[0] ?? null,
    date_to: sortedDates[sortedDates.length - 1] ?? null,
    date_semantics: semantics.verdict,
    date_evidence: JSON.stringify({...dateEvidence, ...semantics}),
    completed_at: dryRun ? null : nowUtc(),
  };
  if (!dryRun) Table.updateRecord('import_batch', batch.batch_id, finalPatch);

  const merged = {...batch, ...finalPatch};
  return {
    batch_id: batch.batch_id,
    dry_run: dryRun,
    report: batchReport(merged),
    exceptions: exceptions.slice(0, 50).map((e) => ({
      kind: e.kind, detail: e.detail, source_row_number: e.source_row_number,
    })),
    exception_summary: summarize(exceptions),
    preview: previewRows,
    affected_dates: sortedDates,
  };
}

/* ------------------------------------------------------------ 落库 */

function persistPage(prepared, {batch, descriptor, termId, policy, counters}) {
  Table.transaction(() => {
    for (const {record, n, cls, student} of prepared) {
      const sourceKey = buildSourceKey(descriptor.source_system, n);
      const payloadHash = buildPayloadHash(n);

      // 同键同内容：重复跳过。同键不同内容：新增原始版本并进入来源更正复核。
      const sameVersion = Table.findOne('raw_attendance', {
        tenant_id: TENANT_ID, source_key: sourceKey, payload_hash: payloadHash,
      });
      if (sameVersion) { counters.duplicate += 1; continue; }

      const priorVersions = Table.count('raw_attendance', {tenant_id: TENANT_ID, source_key: sourceKey});
      const isCorrection = priorVersions > 0;

      const rawId = newId('raw');
      Table.insert('raw_attendance', {
        raw_id: rawId,
        tenant_id: TENANT_ID,
        batch_id: batch.batch_id,
        source_type: descriptor.source_type,
        source_row_number: record.source_row_number,
        source_key: sourceKey,
        payload_hash: payloadHash,
        source_record_id: record.source_record_id ?? null,
        name_raw: record.name_raw, class_raw: record.class_raw, course_raw: record.course_raw,
        teacher_raw: record.teacher_raw, period_raw: record.period_raw, room_raw: record.room_raw,
        week_raw: record.week_raw, sign_time_raw: record.sign_time_raw,
        raw_result: record.raw_result, raw_way: record.raw_way, att_date_raw: record.att_date_raw,
        ingested_at: nowUtc(),
        validation_status: isCorrection ? 'superseded' : 'accepted',
      });

      const sessionId = ensureCourseSession(n, cls, termId, descriptor);
      const businessKey = buildBusinessKey(termId, student.student_id, cls.class_id, n.att_date, n.period, n.course_name);
      const existing = Table.findOne('attendance', {business_key: businessKey});

      if (!existing) {
        insertAttendance({
          businessKey, rawId, batch, student, cls, n, sessionId, termId, policy,
        });
        counters.inserted += 1;
      } else if (isCorrection) {
        // 来源更正：不静默覆盖人工结论或已公示结果，转复核。
        counters.conflict += 1;
        Table.updateRecord('attendance', existing.attendance_id, {
          needs_review: 1,
          review_reason: `来源更正：新版本原始结果「${n.raw_result}」方式「${n.raw_way || '空'}」`
            + `与当前生效版本不同，需辅导员确认是否采用`,
          updated_at: nowUtc(),
        });
        Table.insert('review_event', {
          event_id: newId('ev'), tenant_id: TENANT_ID, attendance_id: existing.attendance_id,
          action: 'source_update', from_judgment: existing.final_judgment, to_judgment: null,
          before_revision: existing.business_revision, after_revision: existing.business_revision,
          reason: `接入到同业务键的新来源版本（raw ${rawId}）`,
          evidence_refs: '[]', operator_user_id: 'system:ingestion',
          related_request_id: batch.batch_id, active: 1, created_at: nowUtc(),
        });
      } else {
        counters.duplicate += 1;
      }
    }
  });
}

function insertAttendance({businessKey, rawId, batch, student, cls, n, sessionId, termId, policy}) {
  const base = computeBaseJudgment(n, policy);
  // 先请假、后接入：接入时即匹配已批准请假（03 §4.2）。
  const leaves = activeLeavesFor(student.student_id, n.att_date, n.period);
  const final = computeFinalJudgment({base, activeLeaves: leaves, manual: null}, policy);
  const ts = nowUtc();

  Table.insert('attendance', {
    attendance_id: newId('att'),
    business_key: businessKey,
    tenant_id: TENANT_ID,
    college_id: COLLEGE_ID,
    term_id: termId,
    student_id: student.student_id,
    student_no_snapshot: student.student_no,
    name_snapshot: student.name,
    class_id: cls.class_id,
    class_name_snapshot: cls.class_name,
    session_id: sessionId,
    course_name: n.course_name,
    teacher: n.teacher || null,
    room: n.room || null,
    week: n.week,
    att_date: n.att_date,
    period: n.period,
    raw_id: rawId,
    batch_id: batch.batch_id,
    raw_result: n.raw_result,
    raw_way: n.raw_way,
    sign_time: n.sign_time,
    base_judgment: base.judgment,
    leave_ids: JSON.stringify(final.leaveIds),
    manual_judgment: null,
    manual_event_id: null,
    final_judgment: final.final,
    judgment_reason: final.reason,
    rule_version: RULE_VERSION,
    business_revision: 1,
    public_until: null,
    locked_at: null,
    last_appeal_id: null,
    applied_event_id: `ingest:${rawId}`,
    needs_review: final.needsReview ? 1 : 0,
    review_reason: final.reviewReason,
    created_at: ts,
    updated_at: ts,
  });
}

/** 课次不存在则由考勤补建，标记 schedule_status='derived'，不冒充正式课表。 */
function ensureCourseSession(n, cls, termId, descriptor) {
  const existing = Table.findOne('course_session', {
    tenant_id: TENANT_ID, term_id: termId, class_id: cls.class_id,
    att_date: n.att_date, period: n.period, course_name: n.course_name,
  });
  if (existing) return existing.session_id;
  const sessionId = newId('ses');
  try {
    Table.insert('course_session', {
      session_id: sessionId, tenant_id: TENANT_ID, college_id: COLLEGE_ID, term_id: termId,
      class_id: cls.class_id, teaching_group_id: null, course_id: null,
      course_name: n.course_name, teacher_name: n.teacher || null, teacher_user_id: null,
      att_date: n.att_date, period: n.period, source_period_text: n.source_period_text,
      room: n.room || null, week: n.week, course_type: null,
      source: descriptor.source_system, schedule_status: 'derived',
    });
    return sessionId;
  } catch {
    return Table.findOne('course_session', {
      tenant_id: TENANT_ID, term_id: termId, class_id: cls.class_id,
      att_date: n.att_date, period: n.period, course_name: n.course_name,
    })?.session_id ?? null;
  }
}

/* ------------------------------------------------------------ 辅助 */

function createBatch(descriptor, {operatorId, termId, dryRun}) {
  const batchId = newId('batch');
  const row = {
    batch_id: batchId,
    tenant_id: TENANT_ID,
    college_id: COLLEGE_ID,
    source_type: descriptor.source_type,
    source_system: descriptor.source_system,
    source_ref: descriptor.source_ref,
    source_digest: descriptor.source_digest,
    file_name: descriptor.source_type === 'excel_file' ? descriptor.source_ref : null,
    file_hash: descriptor.source_type === 'excel_file' ? descriptor.source_digest : null,
    term_id: termId,
    status: dryRun ? 'validating' : 'processing',
    checkpoint: 0,
    operator_id: operatorId,
    started_at: nowUtc(),
    coverage_status: 'unknown',
    date_semantics: 'unconfirmed',
  };
  Table.insert('import_batch', row);
  return {...row, total_rows: 0, valid_rows: 0, inserted_rows: 0, duplicate_rows: 0, conflict_rows: 0, unmatched_rows: 0, invalid_rows: 0};
}

function makeException(batchId, record, kind, detail) {
  return {
    exception_id: newId('exc'),
    tenant_id: TENANT_ID,
    batch_id: batchId,
    raw_id: null,
    source_row_number: record.source_row_number,
    kind,
    detail,
    payload_json: JSON.stringify(record),
    status: 'open',
    created_at: nowUtc(),
  };
}

function summarize(exceptions) {
  const out = {};
  for (const e of exceptions) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/**
 * 日期语义证据（AT-018）。
 * 只做一件事：统计"签到时间的日期"与"来源日期列"是否一致。
 * 有任何一条不一致，就不认为二者等价 —— 结论来自数据，不来自假设。
 */
function collectDateEvidence(evidence, record, n) {
  if (!n.sign_time) { evidence.unsigned += 1; return; }
  evidence.signed_checked += 1;
  if (n.sign_time.slice(0, 10) !== n.att_date) {
    evidence.date_mismatch += 1;
    if (evidence.samples.length < 10) {
      evidence.samples.push({row: record.source_row_number, sign: n.sign_time, date: n.att_date});
    }
  }
}

function judgeDateSemantics(evidence) {
  if (evidence.signed_checked === 0) {
    return {verdict: 'unconfirmed', basis: '没有任何可解析的签到时间，无法佐证日期语义'};
  }
  if (evidence.date_mismatch > 0) {
    return {
      verdict: 'unconfirmed',
      basis: `存在 ${evidence.date_mismatch} 条签到时间与来源日期不一致，`
        + '不能认定来源日期等于上课日期，须取得真实上课日期后再接入',
    };
  }
  return {
    verdict: 'confirmed_same',
    basis: `${evidence.signed_checked} 条有签到时间的记录，其签到日期与来源日期完全一致，零反例；`
      + `另有 ${evidence.unsigned} 条无签到时间（未打卡），其日期沿用同一来源列`,
  };
}

function batchReport(batch) {
  return {
    batch_id: batch.batch_id,
    source_type: batch.source_type,
    source_system: batch.source_system,
    source_ref: batch.source_ref,
    status: batch.status,
    term_id: batch.term_id,
    date_from: batch.date_from, date_to: batch.date_to,
    total_rows: batch.total_rows, valid_rows: batch.valid_rows,
    inserted_rows: batch.inserted_rows, duplicate_rows: batch.duplicate_rows,
    conflict_rows: batch.conflict_rows, unmatched_rows: batch.unmatched_rows,
    invalid_rows: batch.invalid_rows,
    checkpoint: batch.checkpoint,
    coverage_status: batch.coverage_status,
    date_semantics: batch.date_semantics,
    date_evidence: typeof batch.date_evidence === 'string'
      ? JSON.parse(batch.date_evidence || '{}') : batch.date_evidence,
  };
}
