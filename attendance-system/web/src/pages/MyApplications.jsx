// 我的申请：请假与申诉的进度。审批状态与考勤同步状态分开显示。

import {useState} from 'react';
import {api} from '../api.js';
import {Async, Modal, Notice, useAsync, formatDate, label} from '../ui.jsx';

export function MyApplications({me, onToast}) {
  const [tab, setTab] = useState('leave');
  const [creating, setCreating] = useState(false);
  const leaves = useAsync(() => api.leaves(), []);
  const appeals = useAsync(() => api.appeals(), []);

  const canApplyBatch = me.roles.includes('student_cadre') || me.is_counselor;

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>我的申请</h1>
          <p>审批状态与考勤更正状态分别显示，审批通过不等于考勤已更新</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>申请请假</button>
      </div>

      <div className="toolbar">
        <button className={tab === 'leave' ? 'chip selected' : 'chip'} onClick={() => setTab('leave')}>
          请假<span>{leaves.data?.items.length ?? 0}</span>
        </button>
        <button className={tab === 'appeal' ? 'chip selected' : 'chip'} onClick={() => setTab('appeal')}>
          申诉<span>{appeals.data?.items.length ?? 0}</span>
        </button>
      </div>

      {tab === 'leave' ? (
        <div className="card">
          <Async state={leaves} empty={leaves.data && !leaves.data.items.length
            ? {title: '还没有请假记录', hint: '点右上角「申请请假」提交。'} : null}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>类型 / 时间</th><th>事由</th><th>审批状态</th><th>考勤同步</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {leaves.data?.items.map((l) => (
                    <tr key={l.leave_id}>
                      <td data-label="时间">
                        <div className="stack">
                          <span>{leaveType(l.leave_type)}{l.on_behalf ? ' · 代办' : ''}</span>
                          <span className="dim mono">
                            {l.start_date} 至 {l.end_date}
                            {l.periods.length ? ` 第 ${l.periods.join('、')} 节` : '（全天）'}
                          </span>
                        </div>
                      </td>
                      <td data-label="事由"><span className="dim">{l.reason}</span></td>
                      <td data-label="审批">{approvalLabel(l.approval_status)}</td>
                      <td data-label="同步">
                        <div className="stack">
                          <span>{syncLabel(l.apply_status)}</span>
                          {l.sync_warning && <span className="dim">{l.sync_warning}</span>}
                          {l.revoke_note && <span className="dim">{l.revoke_note}</span>}
                        </div>
                      </td>
                      <td data-label="操作">
                        {l.approval_status === 'approved' && l.revoke_status === 'none' && (
                          <button className="text-button" onClick={() => revoke(l.leave_id)}>申请撤销</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Async>
        </div>
      ) : (
        <div className="card">
          <Async state={appeals} empty={appeals.data && !appeals.data.items.length
            ? {title: '还没有申诉记录', hint: '在考勤详情页对旷课或迟到记录提交申诉。'} : null}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>提交时间</th><th>原结果</th><th>当前状态</th><th>时限 / 公示</th></tr>
                </thead>
                <tbody>
                  {appeals.data?.items.map((a) => (
                    <tr key={a.appeal_id}>
                      <td data-label="时间"><span className="mono">{formatDate(a.created_at)}</span></td>
                      <td data-label="原结果">{label(a.original_judgment)} → 正常</td>
                      <td data-label="状态">
                        <div className="stack">
                          <span>{a.status_label}</span>
                          {a.status === 'approved' && !a.attendance_corrected && (
                            <span className="dim">审批已通过，考勤尚未生效</span>
                          )}
                        </div>
                      </td>
                      <td data-label="时限">
                        {a.public_countdown_days != null
                          ? <span>公示剩余 {a.public_countdown_days} 天</span>
                          : <span className="dim">一审截止 {formatDate(a.first_deadline)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Async>
        </div>
      )}

      {creating && (
        <LeaveForm
          canApplyBatch={canApplyBatch}
          onClose={() => setCreating(false)}
          onDone={(msg) => { setCreating(false); onToast(msg); leaves.reload(); }}
          onToast={onToast}
        />
      )}
    </>
  );

  async function revoke(leaveId) {
    const reason = window.prompt('请说明撤销原因');
    if (!reason) return;
    try {
      await api.revokeLeave(leaveId, reason);
      onToast('撤销申请已提交，辅导员确认前原请假仍然有效');
      leaves.reload();
    } catch (err) { onToast(err.message, 'error'); }
  }
}

function LeaveForm({canApplyBatch, onClose, onDone, onToast}) {
  const [form, setForm] = useState({
    leave_type: 'personal', start_date: '', end_date: '', allDay: true,
    periods: [], reason: '', evidence: '',
  });
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [splitHint, setSplitHint] = useState(null);
  const candidates = useAsync(() => (batch ? api.leaveCandidates() : Promise.resolve({items: []})), [batch]);

  const set = (k, v) => setForm((f) => ({...f, [k]: v}));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setSplitHint(null);
    try {
      let evidenceRefs = [];
      if (form.leave_type === 'sick' || form.evidence.trim()) {
        const ev = await api.registerEvidence({
          business_type: 'leave', file_name: form.evidence.trim() || '病假证明',
          content_type: 'text/plain', byte_size: form.evidence.length, sensitivity: 'restricted',
        });
        evidenceRefs = [ev.evidence_id];
      }
      const out = await api.submitLeave({
        leave_type: form.leave_type,
        start_date: form.start_date,
        end_date: form.end_date || form.start_date,
        periods: form.allDay ? [] : form.periods,
        reason: form.reason.trim(),
        evidence_refs: evidenceRefs,
        member_student_ids: batch && selected.length ? selected : undefined,
      });
      onDone(out.duplicate_submission ? '该申请已提交过，返回原单号'
        : `请假已提交，等待辅导员审批${out.members > 1 ? `（${out.members} 人）` : ''}`);
    } catch (err) {
      if (err.code === 'SPLIT_REQUIRED') setSplitHint(err.detail?.groups ?? []);
      onToast(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <Modal eyebrow="请假" title="提交请假申请" onClose={onClose} wide>
      <Notice kind="info">
        姓名、学号、班级由登录身份自动带入，不需要也不能手填。病假必须上传证明材料。
      </Notice>
      <form onSubmit={submit}>
        <div className="grid cols-2">
          <label className="field">
            请假类型 <span className="required">必填</span>
            <select value={form.leave_type} onChange={(e) => set('leave_type', e.target.value)}>
              <option value="personal">事假</option>
              <option value="sick">病假</option>
              <option value="public">公假</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="field">
            开始日期 <span className="required">必填</span>
            <input type="date" required value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </label>
          <label className="field">
            结束日期 <span className="required">必填</span>
            <input type="date" required value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
          </label>
          <label className="field">
            节次范围
            <select value={form.allDay ? 'all' : 'part'}
              onChange={(e) => set('allDay', e.target.value === 'all')}>
              <option value="all">全天</option>
              <option value="part">指定节次</option>
            </select>
          </label>
        </div>

        {!form.allDay && (
          <div className="field">
            选择节次（1—12）
            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
              {Array.from({length: 12}, (_, i) => i + 1).map((p) => (
                <button type="button" key={p}
                  className={form.periods.includes(p) ? 'chip selected' : 'chip'}
                  onClick={() => set('periods', form.periods.includes(p)
                    ? form.periods.filter((x) => x !== p) : [...form.periods, p].sort((a, b) => a - b))}>
                  {p}
                </button>
              ))}
            </div>
            <span className="hint">按日期范围内每天相同节次生效。不同日期不同节次需要拆成多张单。</span>
          </div>
        )}

        {canApplyBatch && (
          <label className="field" style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
            <input type="checkbox" checked={batch} onChange={(e) => { setBatch(e.target.checked); setSelected([]); }} />
            多人公假（仅限你授权范围内的学生）
          </label>
        )}

        {batch && (
          <div className="field">
            选择学生（已选 {selected.length} 人）
            <div style={{maxHeight: 180, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8}}>
              {candidates.data?.items.map((s) => (
                <label key={s.student_id} style={{display: 'flex', gap: 8, padding: '4px 0', fontWeight: 400}}>
                  <input type="checkbox" checked={selected.includes(s.student_id)}
                    onChange={(e) => setSelected(e.target.checked
                      ? [...selected, s.student_id] : selected.filter((x) => x !== s.student_id))} />
                  <span className="mono">{s.student_no}</span> {s.name}
                </label>
              ))}
            </div>
            <span className="hint">一张单默认只含同一负责辅导员范围内的学生，跨范围会提示拆单。</span>
          </div>
        )}

        {splitHint && (
          <Notice kind="warn">
            <strong>名单跨越多名负责辅导员，需要拆成 {splitHint.length} 张单：</strong>
            {splitHint.map((g) => (
              <div key={g.counselor_user_id}>
                · {g.students.map((s) => s.name).join('、')}（共 {g.students.length} 人）
              </div>
            ))}
          </Notice>
        )}

        <label className="field">
          请假事由 <span className="required">必填</span>
          <textarea required rows={3} maxLength={300} value={form.reason}
            onChange={(e) => set('reason', e.target.value)} />
        </label>
        <label className="field">
          证明材料{form.leave_type === 'sick' && <span className="required">必填</span>}
          <input value={form.evidence} onChange={(e) => set('evidence', e.target.value)}
            required={form.leave_type === 'sick'}
            placeholder="例如：门诊病历编号、医院证明说明" />
          <span className="hint">病假证明默认只有本人与对应辅导员可见。</span>
        </label>

        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button>
        </div>
      </form>
    </Modal>
  );
}

const leaveType = (t) => ({public: '公假', sick: '病假', personal: '事假', other: '其他'}[t] ?? t);
const approvalLabel = (s) => ({
  submitted: '待审批', approved: '已通过', rejected: '已驳回', cancelled: '已作废', draft: '草稿',
}[s] ?? s);
const syncLabel = (s) => ({
  pending: '待同步', applying: '同步中', applied: '已更新考勤', failed: '同步异常',
}[s] ?? s);
