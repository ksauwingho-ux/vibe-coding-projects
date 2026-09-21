// 本班工作台 / 辅导员工作台：待核对、待审、复核任务。

import {useState} from 'react';
import {api} from '../api.js';
import {Async, Badge, Modal, Notice, useAsync, formatDate, label} from '../ui.jsx';
import {AttendanceDetail} from './MyAttendance.jsx';

export function Workbench({me, onToast}) {
  const [tab, setTab] = useState('verify');
  const verify = useAsync(() => api.verificationQueue({limit: 50}), []);
  const appeals = useAsync(() => api.appealTodos(), []);
  const approvals = useAsync(() => api.approvalTodos(), []);
  const review = useAsync(() => (me.is_counselor ? api.reviewQueue({limit: 50}) : Promise.resolve({items: []})), []);

  const reloadAll = () => { verify.reload(); appeals.reload(); approvals.reload(); review.reload(); };
  const tabs = [
    ['verify', '待核实核对', verify.data?.items.filter((i) => i.can_verify).length],
    ['appeal', '待我审核', appeals.data?.items.length],
    ['approval', '审批待办', approvals.data?.items.length],
    ...(me.is_counselor ? [['review', '复核任务', review.data?.items.length]] : []),
  ];

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{me.is_counselor ? '辅导员工作台' : '本班工作台'}</h1>
          <p>负责范围：{me.manageable_classes.length} 个班级 · 所有操作均在服务端重新校验权限</p>
        </div>
      </div>

      <div className="toolbar">
        {tabs.map(([key, text, count]) => (
          <button key={key} className={tab === key ? 'chip selected' : 'chip'} onClick={() => setTab(key)}>
            {text}<span>{count ?? 0}</span>
          </button>
        ))}
      </div>

      {tab === 'verify' && <VerifyQueue state={verify} onToast={onToast} onDone={reloadAll} />}
      {tab === 'appeal' && <AppealTodos state={appeals} onToast={onToast} onDone={reloadAll} />}
      {tab === 'approval' && <ApprovalTodos state={approvals} onToast={onToast} onDone={reloadAll} />}
      {tab === 'review' && <ReviewQueue state={review} onToast={onToast} onDone={reloadAll} />}
    </>
  );
}

/* ---------------------------------------------------------- 待核实 */

function VerifyQueue({state, onToast, onDone}) {
  const [active, setActive] = useState(null);
  const blocked = state.data?.items.filter((i) => !i.can_verify) ?? [];

  return (
    <>
      {!!blocked.length && (
        <Notice kind="warn">
          有 {blocked.length} 条记录你不能处理（本人记录或超出授权班级），已在列表中标注并给出转交对象。
        </Notice>
      )}
      <div className="card">
        <Async state={state} empty={state.data && !state.data.items.length
          ? {title: '没有待核实的记录', hint: '待核实来自"原始结果正常但方式为空或未知"的记录。'} : null}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>学生</th><th>课程 / 时间</th><th>原始值</th><th>待核实原因</th><th>操作</th></tr>
              </thead>
              <tbody>
                {state.data?.items.map((r) => (
                  <tr key={r.attendance_id}>
                    <td data-label="学生">
                      <div className="stack">
                        <span>{r.name}</span>
                        <span className="dim mono">{r.student_no} · {r.class_name}</span>
                      </div>
                    </td>
                    <td data-label="课程">
                      <div className="stack">
                        <span>{r.course_name}</span>
                        <span className="dim mono">{r.att_date} 第 {r.period} 节</span>
                      </div>
                    </td>
                    <td data-label="原始值">
                      <div className="stack">
                        <span>{r.raw_result} / {r.raw_way ?? '（空）'}</span>
                        <span className="dim mono">{r.sign_time ?? '未打卡'}</span>
                      </div>
                    </td>
                    <td data-label="原因"><span className="dim">{r.pending_reason}</span></td>
                    <td data-label="操作">
                      {r.can_verify
                        ? <button className="text-button" onClick={() => setActive(r)}>核对</button>
                        : <span className="dim">{r.blocked_reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </div>

      {active && (
        <VerifyForm record={active} onClose={() => setActive(null)}
          onDone={(msg) => { setActive(null); onToast(msg); onDone(); }} onToast={onToast} />
      )}
    </>
  );
}

function VerifyForm({record, onClose, onDone, onToast}) {
  const [action, setAction] = useState('confirm_present');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.verify({
        attendance_id: record.attendance_id,
        action, note: note.trim(),
        expected_revision: record.business_revision,
        idempotency_key: `${record.attendance_id}:${record.business_revision}`,
      });
      onDone(`已${action === 'confirm_present' ? '确认到场' : '确认缺勤'}，学生会收到结果通知`);
    } catch (err) {
      onToast(err.code === 'REVISION_CONFLICT' || err.code === 'ALREADY_HANDLED'
        ? '该记录已被他人处理，请刷新后查看最新结果' : err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <Modal eyebrow="待核实核对" title={`${record.name} · ${record.att_date} 第 ${record.period} 节`} onClose={onClose}>
      <dl className="detail-grid">
        <div><dt>课程</dt><dd>{record.course_name}</dd></div>
        <div><dt>原始结果</dt><dd>{record.raw_result}</dd></div>
        <div><dt>考勤方式</dt><dd>{record.raw_way ?? '（空）'}</dd></div>
        <div><dt>签到时间</dt><dd className="mono">{record.sign_time ?? '未打卡'}</dd></div>
      </dl>
      <Notice kind="info">{record.pending_reason}</Notice>
      <form onSubmit={submit}>
        <label className="field">
          核对结论 <span className="required">必填</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="confirm_present">确认到场（记为正常）</option>
            <option value="confirm_absent">确认缺勤（记为旷课）</option>
          </select>
        </label>
        <label className="field">
          核对说明 <span className="required">必填</span>
          <textarea required rows={3} maxLength={300} value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="说明依据，例如：已向任课教师核实该生当堂在场" />
        </label>
        <p className="hint">核对结论将作为人工结论生效，优先于自动判定；只有授权人员显式撤销后才恢复自动结果。</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !note.trim()}>{busy ? '提交中…' : '确认核对'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- 申诉审核 */

function AppealTodos({state, onToast, onDone}) {
  const [active, setActive] = useState(null);
  return (
    <>
      <div className="card">
        <Async state={state} empty={state.data && !state.data.items.length
          ? {title: '没有待你审核的申诉', hint: '自己提交的申诉不会出现在这里。'} : null}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>学生</th><th>申诉对象</th><th>阶段</th><th>时限</th><th>操作</th></tr>
              </thead>
              <tbody>
                {state.data?.items.map((a) => (
                  <tr key={a.appeal_id}>
                    <td data-label="学生">
                      <div className="stack">
                        <span>{a.attendance?.name}</span>
                        <span className="dim mono">{a.attendance?.student_no} · {a.attendance?.class_name}</span>
                      </div>
                    </td>
                    <td data-label="对象">
                      <div className="stack">
                        <span>{a.attendance?.att_date} 第 {a.attendance?.period} 节 {a.attendance?.course_name}</span>
                        <span className="dim">
                          当前 <Badge judgment={a.attendance?.final_judgment} />
                          {a.attendance?.has_active_leave && ' · 已有生效请假'}
                        </span>
                      </div>
                    </td>
                    <td data-label="阶段">{stageLabel(a.stage)}</td>
                    <td data-label="时限">
                      {a.overdue
                        ? <span style={{color: 'var(--danger)'}}>{a.overdue_note}</span>
                        : <span className="dim mono">{formatDate(a.first_deadline)}</span>}
                    </td>
                    <td data-label="操作">
                      <button className="text-button" onClick={() => setActive(a)}>审核</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </div>
      {active && (
        <AppealDecide appeal={active} onClose={() => setActive(null)}
          onDone={(msg) => { setActive(null); onToast(msg); onDone(); }} onToast={onToast} />
      )}
    </>
  );
}

function AppealDecide({appeal, onClose, onDone, onToast}) {
  const detail = useAsync(() => api.appeal(appeal.appeal_id), [appeal.appeal_id]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function decide(decision) {
    if (decision === 'rejected' && !comment.trim()) {
      onToast('驳回必须填写理由', 'error');
      return;
    }
    setBusy(true);
    try {
      const out = await api.decideAppeal(appeal.appeal_id, {decision, comment: comment.trim()});
      onDone(decision === 'rejected' ? '已驳回，学生可补充证据后重新提交'
        : (out.stage === 'done'
          ? `终审通过，考勤已更正${out.public_until ? '并开始公示' : ''}`
          : `一审通过，已转${stageLabel(out.stage)}`));
    } catch (err) {
      onToast(err.message, 'error');
      setBusy(false);
    }
  }

  const d = detail.data;
  return (
    <Modal eyebrow="申诉审核" title="审核考勤申诉" onClose={onClose} wide>
      <Async state={detail}>
        {d && (
          <>
            {appeal.overdue && <Notice kind="error">{appeal.overdue_note}</Notice>}
            {appeal.attendance?.has_active_leave && (
              <Notice kind="warn">该记录已命中生效中的请假单，请确认是否仍需按申诉处理。</Notice>
            )}
            <dl className="detail-grid">
              <div><dt>学生</dt><dd>{appeal.attendance?.name}（{appeal.attendance?.student_no}）</dd></div>
              <div><dt>课程</dt><dd>{appeal.attendance?.course_name}</dd></div>
              <div><dt>时间</dt><dd className="mono">{appeal.attendance?.att_date} 第 {appeal.attendance?.period} 节</dd></div>
              <div><dt>原始结果 / 方式</dt><dd>{appeal.attendance?.raw_result} / {appeal.attendance?.raw_way || '（空）'}</dd></div>
              <div><dt>签到时间</dt><dd className="mono">{appeal.attendance?.sign_time ?? '未打卡'}</dd></div>
              <div><dt>当前结果</dt><dd>{label(appeal.attendance?.final_judgment)}</dd></div>
            </dl>
            <h3 style={{fontSize: 14}}>申诉理由</h3>
            <p style={{fontSize: 14, lineHeight: 1.8}}>{d.reason}</p>
            {!!d.evidence_refs.length && (
              <p className="hint">附证据 {d.evidence_refs.length} 项（访问需单独鉴权）</p>
            )}
            {!!d.steps.length && (
              <>
                <h3 style={{fontSize: 14, marginTop: 14}}>处理过程</h3>
                <ul className="timeline">
                  {d.steps.map((s, i) => (
                    <li key={i}>
                      <div style={{fontSize: 13}}>{stageLabel(s.stage)} · {s.assignee_role}</div>
                      <div className="dim">{s.decision ? `${decisionLabel(s.decision)}${s.comment ? `：${s.comment}` : ''}` : '处理中'}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <label className="field" style={{marginTop: 14}}>
              审核意见{' '}<span className="dim">（驳回时必填）</span>
              <textarea rows={3} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="dialog-actions">
              <button className="secondary" disabled={busy} onClick={() => decide('rejected')}>驳回</button>
              <button className="primary" disabled={busy} onClick={() => decide('approved')}>通过</button>
            </div>
          </>
        )}
      </Async>
    </Modal>
  );
}

/* ---------------------------------------------------------- 审批待办 */

function ApprovalTodos({state, onToast, onDone}) {
  const [busy, setBusy] = useState(null);

  async function decide(id, decision) {
    const comment = decision === 'rejected' ? window.prompt('请填写驳回理由') : '';
    if (decision === 'rejected' && !comment) return;
    setBusy(id);
    try {
      await api.decideApproval(id, {decision, comment});
      onToast(decision === 'approved' ? '已通过，考勤同步由后台任务完成' : '已驳回');
      onDone();
    } catch (err) { onToast(err.message, 'error'); } finally { setBusy(null); }
  }

  return (
    <div className="card">
      <Async state={state} empty={state.data && !state.data.items.length
        ? {title: '没有待办审批', hint: '请假与撤销的审批会出现在这里。'} : null}>
        <div className="grid cols-2">
          {state.data?.items.map((i) => (
            <div key={i.instance_id} className="card" style={{background: 'var(--sage)'}}>
              <h2>{i.summary?.title ?? i.business_type}</h2>
              <p className="sub">{i.summary?.detail}</p>
              {i.summary?.student && <p className="sub">{i.summary.student} · {i.summary.class_name}</p>}
              {i.summary?.member_count > 1 && <p className="sub">涉及 {i.summary.member_count} 名学生</p>}
              <p style={{fontSize: 14, marginTop: 10}}>{i.summary?.reason}</p>
              {i.summary?.has_active_leave && <p className="hint">该记录已有生效请假</p>}
              <div className="dialog-actions">
                <button className="secondary" disabled={busy === i.instance_id}
                  onClick={() => decide(i.instance_id, 'rejected')}>驳回</button>
                <button className="primary" disabled={busy === i.instance_id}
                  onClick={() => decide(i.instance_id, 'approved')}>通过</button>
              </div>
            </div>
          ))}
        </div>
      </Async>
    </div>
  );
}

/* ---------------------------------------------------------- 复核任务 */

function ReviewQueue({state, onToast, onDone}) {
  const [detailId, setDetailId] = useState(null);
  const [busy, setBusy] = useState(null);

  async function resolve(item, decision) {
    const reason = window.prompt(decision === 'keep' ? '维持原判的理由' : '改判理由');
    if (!reason) return;
    setBusy(item.attendance_id);
    try {
      await api.resolveReview({
        attendance_id: item.attendance_id, decision, reason,
        to_judgment: decision === 'keep' ? undefined : window.prompt('改判为（正常/旷课/迟到/早退）') ?? '正常',
        expected_revision: item.business_revision,
      });
      onToast('复核已处理');
      onDone();
    } catch (err) { onToast(err.message, 'error'); } finally { setBusy(null); }
  }

  return (
    <>
      <Notice kind="info">
        复核任务来自：来源数据更正与当前结果冲突、公示锁定后收到自动更正、人工结论与已批准请假冲突。
        这些情况系统不会自动改判，须由辅导员带理由处理。
      </Notice>
      <div className="card">
        <Async state={state} empty={state.data && !state.data.items.length
          ? {title: '没有复核任务', hint: '一切正常。'} : null}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>学生</th><th>记录</th><th>当前结果</th><th>复核原因</th><th>操作</th></tr>
              </thead>
              <tbody>
                {state.data?.items.map((r) => (
                  <tr key={r.attendance_id}>
                    <td data-label="学生">
                      <div className="stack">
                        <span>{r.name}</span>
                        <span className="dim mono">{r.student_no} · {r.class_name}</span>
                      </div>
                    </td>
                    <td data-label="记录">
                      <span className="mono">{r.att_date} 第 {r.period} 节</span>
                      <div className="dim">{r.course_name}</div>
                    </td>
                    <td data-label="结果">
                      <Badge judgment={r.final_judgment} />
                      {r.locked_at && <div className="dim">已锁定</div>}
                    </td>
                    <td data-label="原因"><span className="dim">{r.review_reason}</span></td>
                    <td data-label="操作">
                      <div className="stack">
                        <button className="text-button" onClick={() => setDetailId(r.attendance_id)}>详情</button>
                        <button className="text-button" disabled={busy === r.attendance_id}
                          onClick={() => resolve(r, 'keep')}>维持原判</button>
                        <button className="text-button" disabled={busy === r.attendance_id}
                          onClick={() => resolve(r, 'override')}>改判</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </div>
      {detailId && <AttendanceDetail id={detailId} onClose={() => setDetailId(null)} onToast={onToast} />}
    </>
  );
}

const stageLabel = (s) => ({first: '一审', second: '终审', counselor: '辅导员代审', done: '已结束'}[s] ?? s);
const decisionLabel = (d) => ({approved: '通过', rejected: '驳回', timeout: '超时转办', escalated: '转办'}[d] ?? d);
