// 我的考勤 + 考勤详情。移动端主路径的第一屏。

import {useState} from 'react';
import {api} from '../api.js';
import {Async, Badge, Metric, Modal, Notice, useAsync, formatDate, label} from '../ui.jsx';

const FILTERS = ['全部', '旷课', '迟到', '早退', '待处理', '请假', '正常'];

export function MyAttendance({me, onToast}) {
  const [filter, setFilter] = useState('全部');
  const [detailId, setDetailId] = useState(null);

  const list = useAsync(
    () => api.attendance({
      scope_type: 'self',
      judgments: filter === '全部' ? undefined : filter,
      limit: 50,
    }),
    [filter],
  );
  const summary = useAsync(() => api.summary({scope_type: 'self'}), []);

  if (!me.student_id) {
    return (
      <Notice kind="warn">
        <strong>当前账号尚未关联学生身份</strong>
        <div>{me.mapping_note ?? '请联系管理员核验学号映射后再查看个人考勤。'}</div>
      </Notice>
    );
  }

  const s = summary.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>我的考勤</h1>
          <p>统计单位为「学生·节」{s?.coverage_status === 'unknown' && ' · 数据完整性未确认，以下为已导入考勤'}</p>
        </div>
      </div>

      {s && (
        <div className="metrics">
          <Metric label="已导入节次" value={s.total_imported_periods} tone="neutral" />
          <Metric label="异常节次" value={s.abnormal_periods} tone="warning" note={s.abnormal_definition} />
          <Metric label="待核实" value={s.pending_verification_periods} note="单独统计，不计入异常" />
          <Metric label="请假" value={s.counts?.请假 ?? 0} />
        </div>
      )}

      <div className="toolbar">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={filter === f ? 'chip selected' : 'chip'}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {label(f)}
            {s && f !== '全部' && <span>{s.counts?.[f] ?? 0}</span>}
          </button>
        ))}
      </div>

      <div className="card">
        <Async
          state={list}
          empty={list.data && !list.data.items.length
            ? {title: '没有符合条件的记录', hint: '换个结果类型再看看。'} : null}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>日期 / 节次</th><th>课程</th><th>结果</th><th>依据</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((r) => (
                  <tr key={r.attendance_id}>
                    <td data-label="日期">
                      <div className="stack">
                        <span className="mono">{r.att_date}</span>
                        <span className="dim">第 {r.period} 节</span>
                      </div>
                    </td>
                    <td data-label="课程">
                      <div className="stack">
                        <span>{r.course_name}</span>
                        <span className="dim">{r.teacher ?? ''} {r.room ?? ''}</span>
                      </div>
                    </td>
                    <td data-label="结果">
                      <Badge judgment={r.final_judgment} />
                      {r.public_until && <div className="dim">公示中</div>}
                      {r.locked_at && <div className="dim">已锁定</div>}
                    </td>
                    <td data-label="依据"><span className="dim">{r.judgment_reason}</span></td>
                    <td data-label="操作">
                      <button className="text-button" onClick={() => setDetailId(r.attendance_id)}>详情</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data?.has_more && <div className="pagination"><span>仅显示最近 50 条，可用筛选缩小范围</span></div>}
        </Async>
      </div>

      {detailId && (
        <AttendanceDetail
          id={detailId}
          me={me}
          onClose={() => setDetailId(null)}
          onToast={onToast}
          onChanged={() => { list.reload(); summary.reload(); }}
        />
      )}
    </>
  );
}

export function AttendanceDetail({id, me, onClose, onToast, onChanged}) {
  const detail = useAsync(() => api.attendanceDetail(id), [id]);
  const [appealing, setAppealing] = useState(false);
  const d = detail.data;

  return (
    <Modal eyebrow="考勤记录" title={d ? `${d.att_date} 第 ${d.period} 节 · ${d.course_name}` : '考勤详情'} onClose={onClose} wide>
      <Async state={detail}>
        {d && (
          <>
            <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
              <Badge judgment={d.final_judgment} />
              {d.base_judgment !== d.final_judgment && (
                <span className="dim">基础判定：{label(d.base_judgment)}</span>
              )}
              {d.needs_review && <span className="chip">待辅导员复核</span>}
              {d.public_countdown_days != null && (
                <span className="chip">公示剩余 {d.public_countdown_days} 天</span>
              )}
              {d.locked_at && <span className="chip">已锁定</span>}
            </div>

            <Notice kind="info">{d.judgment_reason}</Notice>

            <h3 style={{fontSize: 14, marginTop: 6}}>原始记录（不被人工结论覆盖）</h3>
            <dl className="detail-grid">
              <div><dt>原始结果</dt><dd>{d.raw.raw_result || '—'}</dd></div>
              <div><dt>考勤方式</dt><dd>{d.raw.raw_way || '（空）'}</dd></div>
              <div><dt>签到时间</dt><dd className="mono">{d.raw.sign_time ?? '未打卡'}</dd></div>
              <div><dt>数据来源</dt><dd>{sourceLabel(d.raw.source_type)}</dd></div>
              <div><dt>学号 / 姓名</dt><dd>{d.student_no} {d.name}</dd></div>
              <div><dt>班级</dt><dd>{d.class_name}</dd></div>
              <div><dt>教师 / 地点</dt><dd>{d.teacher ?? '—'} {d.room ?? ''}</dd></div>
              <div><dt>规则版本</dt><dd className="dim">{d.rule_version}</dd></div>
            </dl>

            {d.raw.date_semantics !== 'confirmed_same' && (
              <Notice kind="warn">该批数据的日期语义尚未确认，上课日期可能需要核对。</Notice>
            )}

            {!!d.leaves.length && (
              <>
                <h3 style={{fontSize: 14}}>命中的请假单</h3>
                {d.leaves.map((l) => (
                  <div key={l.leave_id} className="hint">
                    {l.start_date} 至 {l.end_date}
                    {l.periods.length ? ` 第 ${l.periods.join('、')} 节` : '（全天）'}
                    · {l.approval_status === 'approved' ? '已批准' : l.approval_status}
                    {l.apply_status !== 'applied' && ' · 考勤同步中'}
                    {l.revoke_status === 'requested' && ' · 撤销待确认（当前仍有效）'}
                  </div>
                ))}
              </>
            )}

            {!!d.timeline.length && (
              <>
                <h3 style={{fontSize: 14, marginTop: 16}}>流程记录</h3>
                <ul className="timeline">
                  {d.timeline.map((e) => (
                    <li key={e.event_id}>
                      <div style={{fontSize: 13}}>
                        <strong>{actionLabel(e.action)}</strong>
                        {e.to_judgment && <> → {label(e.to_judgment)}</>}
                        {!e.active && <span className="dim"> （已被后续事件取代）</span>}
                      </div>
                      <div className="dim">{e.reason}</div>
                      <div className="dim">{formatDate(e.created_at)}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {!!d.appeals.length && (
              <>
                <h3 style={{fontSize: 14, marginTop: 16}}>申诉记录</h3>
                {d.appeals.map((a) => (
                  <div key={a.appeal_id} className="hint">
                    {formatDate(a.created_at)} · {a.status}
                    {a.apply_status && a.status === 'approved' && a.apply_status !== 'applied'
                      && ' · 考勤同步中'}
                  </div>
                ))}
              </>
            )}

            <div className="dialog-actions">
              {d.allowed_actions.includes('appeal') && (
                <button className="primary" onClick={() => setAppealing(true)}>提交申诉</button>
              )}
              {d.locked_at && <span className="hint">记录已锁定，如有异议请联系辅导员复核。</span>}
            </div>

            {appealing && (
              <AppealForm
                record={d}
                onClose={() => setAppealing(false)}
                onDone={(msg) => { setAppealing(false); onToast?.(msg); detail.reload(); onChanged?.(); }}
                onToast={onToast}
              />
            )}
          </>
        )}
      </Async>
    </Modal>
  );
}

function AppealForm({record, onClose, onDone, onToast}) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const ev = await api.registerEvidence({
        business_type: 'appeal', file_name: evidence.trim() || '说明材料',
        content_type: 'text/plain', byte_size: evidence.length,
      });
      const out = await api.submitAppeal({
        attendance_id: record.attendance_id,
        reason: reason.trim(),
        evidence_refs: [ev.evidence_id],
      });
      onDone(out.duplicate
        ? '该记录已有进行中的申诉，返回原受理结果'
        : `申诉已提交，将由${roleName(out.assignee_role)}处理`);
    } catch (err) {
      onToast?.(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <Modal eyebrow="申诉" title="提交考勤申诉" onClose={onClose}>
      <Notice kind="info">
        诉求固定为「改成正常」。如属请假，请走请假流程；如是待核实记录，请等待核对。
      </Notice>
      <form onSubmit={submit}>
        <label className="field">
          申诉理由 <span className="required">必填</span>
          <textarea required rows={4} maxLength={500} value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="说明当时的实际情况，例如设备故障、已刷脸但未记录等" />
        </label>
        <label className="field">
          证据说明 <span className="required">必填</span>
          <input required value={evidence} onChange={(e) => setEvidence(e.target.value)}
            placeholder="例如：教师确认截图、教室监控编号" />
        </label>
        <p className="hint">
          一审时限为提交后 7×24 小时，超时将自动转辅导员代审。
          申诉成立后会有 7 天公示期，公示期内不再新开申诉。
        </p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !reason.trim() || !evidence.trim()}>
            {busy ? '提交中…' : '提交申诉'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function actionLabel(a) {
  return {
    pending_confirm: '待核实核对', manual_override: '人工改判', appeal_apply: '申诉成立',
    manual_revoke: '撤销人工结论', leave_apply: '请假联动', source_update: '来源更正',
    counselor_review: '辅导员复核',
  }[a] ?? a;
}

function roleName(r) {
  return {monitor: '副班长', student_cadre: '学生干部', counselor: '辅导员'}[r] ?? '审核人';
}

function sourceLabel(t) {
  return {excel_file: '学校考勤导出文件', school_api: '学校考勤接口', manual: '人工补录'}[t] ?? '—';
}
