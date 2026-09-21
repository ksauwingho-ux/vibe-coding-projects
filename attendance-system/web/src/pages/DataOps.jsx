// 数据接入 / 映射异常 / 运行台账 / 政策配置。辅导员与运维使用。

import {useRef, useState} from 'react';
import {api} from '../api.js';
import {Async, Notice, useAsync, formatDate} from '../ui.jsx';

export function DataOps({me, onToast}) {
  const [tab, setTab] = useState('ingest');
  const tabs = [
    ['ingest', '数据接入'],
    ['exceptions', '映射异常'],
    ['operations', '消息与任务'],
    ['policies', '规则配置'],
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>数据与运行</h1>
          <p>接入、映射异常、消息任务与业务口径配置</p>
        </div>
      </div>
      <div className="toolbar">
        {tabs.map(([k, t]) => (
          <button key={k} className={tab === k ? 'chip selected' : 'chip'} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>
      {tab === 'ingest' && <Ingest onToast={onToast} />}
      {tab === 'exceptions' && <Exceptions onToast={onToast} />}
      {tab === 'operations' && <Operations onToast={onToast} />}
      {tab === 'policies' && <Policies me={me} onToast={onToast} />}
    </>
  );
}

/* ---------------------------------------------------------- 接入 */

function Ingest({onToast}) {
  const sources = useAsync(() => api.ingestSources(), []);
  const batches = useAsync(() => api.ingestBatches(), []);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function run(dryRun) {
    const file = fileRef.current?.files?.[0];
    if (!file) { onToast('请先选择文件', 'error'); return; }
    setBusy(true);
    try {
      const out = await api.ingestUpload(file, {dryRun});
      setPreview(out);
      if (out.duplicate_source) onToast(out.message);
      else if (dryRun) onToast(`预览完成：共 ${out.report.total_rows} 行`);
      else { onToast(`接入完成：新增 ${out.report.inserted_rows} 条`); batches.reload(); }
    } catch (err) {
      onToast(err.message, 'error');
      if (err.detail) setPreview({error: err});
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <h2>统一考勤接入层</h2>
        <p className="sub">考勤数据只经由接入层进入系统。下游的判定、审批、统计与推送不依赖任何来源特有格式。</p>
        <div className="grid cols-2" style={{marginTop: 14}}>
          {sources.data?.items.map((s) => (
            <div key={s.type} className="card" style={{background: s.enabled ? 'var(--sage)' : '#f4f4f1'}}>
              <h2 style={{fontSize: 15}}>{s.label}</h2>
              <p className="sub">{s.enabled ? '已启用' : '未启用'} · {s.note}</p>
              {!!s.pending?.length && (
                <ul className="hint" style={{paddingLeft: 18, marginTop: 8}}>
                  {s.pending.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{marginTop: 18}}>
        <h2>上传学校考勤文件</h2>
        <p className="sub">按列名识别，与列顺序无关。建议先预览再正式接入。</p>
        <div className="toolbar">
          <input ref={fileRef} type="file" accept=".xlsx" />
          <button className="secondary" disabled={busy} onClick={() => run(true)}>预览校验</button>
          <button className="primary" disabled={busy} onClick={() => run(false)}>正式接入</button>
        </div>

        {preview?.error && (
          <Notice kind="error">
            <strong>{preview.error.message}</strong>
            {Array.isArray(preview.error.detail) && (
              <ul style={{paddingLeft: 18}}>{preview.error.detail.map((x, i) => <li key={i}>{x}</li>)}</ul>
            )}
          </Notice>
        )}

        {preview?.report && <BatchReport report={preview.report} extra={preview} />}
      </div>

      <div className="card" style={{marginTop: 18}}>
        <h2>接入批次</h2>
        <Async state={batches} empty={batches.data && !batches.data.items.length
          ? {title: '还没有接入记录', hint: '上传学校考勤文件开始。'} : null}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>来源</th><th>日期范围</th><th>总数 / 新增</th><th>重复 / 冲突</th><th>异常</th><th>日期语义</th><th>状态</th></tr>
              </thead>
              <tbody>
                {batches.data?.items.map((b) => (
                  <tr key={b.batch_id}>
                    <td data-label="来源">
                      <div className="stack">
                        <span>{b.source_ref}</span>
                        <span className="dim">{b.source_type} · {formatDate(b.started_at)}</span>
                      </div>
                    </td>
                    <td data-label="日期范围" className="mono">{b.date_from} ~ {b.date_to}</td>
                    <td data-label="总数" className="mono">{b.total_rows} / {b.inserted_rows}</td>
                    <td data-label="重复" className="mono">{b.duplicate_rows} / {b.conflict_rows}</td>
                    <td data-label="异常" className="mono">{b.invalid_rows + b.unmatched_rows}</td>
                    <td data-label="日期语义">
                      <span className={b.date_semantics === 'confirmed_same' ? 'chip selected' : 'chip'}>
                        {b.date_semantics === 'confirmed_same' ? '已取证一致' : '待确认'}
                      </span>
                    </td>
                    <td data-label="状态">{b.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </div>
    </>
  );
}

function BatchReport({report, extra}) {
  const ev = report.date_evidence;
  return (
    <>
      <div className="metrics" style={{marginTop: 14}}>
        <div className="metric"><span>总行数</span><strong className="neutral">{report.total_rows}</strong></div>
        <div className="metric"><span>新增</span><strong>{report.inserted_rows}</strong></div>
        <div className="metric"><span>重复跳过</span><strong className="neutral">{report.duplicate_rows}</strong></div>
        <div className="metric"><span>来源更正</span><strong className="warning">{report.conflict_rows}</strong></div>
        <div className="metric"><span>数据错误</span><strong className="warning">{report.invalid_rows}</strong></div>
        <div className="metric"><span>未匹配学生</span><strong className="warning">{report.unmatched_rows}</strong></div>
      </div>
      {ev?.basis && (
        <Notice kind={report.date_semantics === 'confirmed_same' ? 'info' : 'warn'}>
          <strong>日期语义取证：</strong>{ev.basis}
        </Notice>
      )}
      {extra?.exception_summary && Object.keys(extra.exception_summary).length > 0 && (
        <Notice kind="warn">
          <strong>异常分类：</strong>
          {Object.entries(extra.exception_summary).map(([k, v]) => `${exceptionLabel(k)} ${v}`).join(' · ')}
        </Notice>
      )}
      {!!extra?.preview?.length && (
        <div className="table-scroll" style={{marginTop: 12}}>
          <table>
            <thead>
              <tr>{Object.keys(extra.preview[0]).map((k) => <th key={k}>{k}</th>)}</tr>
            </thead>
            <tbody>
              {extra.preview.map((row, i) => (
                <tr key={i}>{Object.entries(row).map(([k, v]) => <td key={k} data-label={k}>{String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- 映射异常 */

function Exceptions({onToast}) {
  const state = useAsync(() => api.ingestExceptions({status: 'open'}), []);
  return (
    <div className="card">
      <h2>映射异常与数据错误</h2>
      <p className="sub">{state.data?.note}</p>
      <Async state={state} empty={state.data && !state.data.items.length
        ? {title: '没有待处理的映射异常', hint: '最近一次接入没有产生数据错误。'} : null}>
        <div className="table-scroll" style={{marginTop: 12}}>
          <table>
            <thead><tr><th>类型</th><th>来源行</th><th>说明</th><th>原始内容</th></tr></thead>
            <tbody>
              {state.data?.items.map((e) => (
                <tr key={e.exception_id}>
                  <td data-label="类型"><span className="chip">{exceptionLabel(e.kind)}</span></td>
                  <td data-label="来源行" className="mono">{e.source_row_number}</td>
                  <td data-label="说明">{e.detail}</td>
                  <td data-label="原始内容">
                    <span className="dim">
                      {e.payload?.name_raw} / {e.payload?.class_raw} / {e.payload?.att_date_raw} / 第{e.payload?.period_raw}节
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Async>
    </div>
  );
}

/* ---------------------------------------------------------- 运行台账 */

function Operations({onToast}) {
  const state = useAsync(() => api.operations(), []);
  const [busy, setBusy] = useState(false);

  async function run(fn, msg) {
    setBusy(true);
    try { const out = await fn(); onToast(msg(out)); state.reload(); }
    catch (err) { onToast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const d = state.data;
  return (
    <>
      <div className="toolbar">
        <button className="secondary" disabled={busy}
          onClick={() => run(() => api.runJobs(), (o) => `已执行 ${o.executed} 项任务`)}>
          立即执行任务队列
        </button>
        <button className="secondary" disabled={busy}
          onClick={() => run(() => api.runDigest({}), (o) => `日报已生成：学生 ${o.student.queued} 条，辅导员 ${o.counselor.queued} 条`)}>
          生成今日日报
        </button>
      </div>

      <Async state={state}>
        {d && (
          <div className="grid cols-2">
            <div className="card">
              <h2>消息台账</h2>
              <p className="sub">{d.notifications.unknown_note}</p>
              <div className="toolbar">
                {Object.entries(d.notifications.by_status).map(([k, v]) => (
                  <span key={k} className="chip">{statusLabel(k)}<span>{v}</span></span>
                ))}
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>类型</th><th>接收人</th><th>状态</th><th>时间</th></tr></thead>
                  <tbody>
                    {d.notifications.items.slice(0, 20).map((n) => (
                      <tr key={n.notification_id}>
                        <td data-label="类型">{notifyKind(n.kind)}</td>
                        <td data-label="接收人" className="dim">{n.receiver}</td>
                        <td data-label="状态">
                          <div className="stack">
                            <span>{statusLabel(n.status)}</span>
                            {n.last_error && <span className="dim">{n.last_error}</span>}
                          </div>
                        </td>
                        <td data-label="时间" className="dim mono">{formatDate(n.sent_at ?? n.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2>同步任务</h2>
              <p className="sub">{d.jobs.dead_note}</p>
              <div className="toolbar">
                {Object.entries(d.jobs.by_status).map(([k, v]) => (
                  <span key={k} className="chip">{statusLabel(k)}<span>{v}</span></span>
                ))}
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>类型</th><th>状态</th><th>重试</th><th>时间</th></tr></thead>
                  <tbody>
                    {d.jobs.items.slice(0, 20).map((j) => (
                      <tr key={j.event_id}>
                        <td data-label="类型">{j.event_type}</td>
                        <td data-label="状态">
                          <div className="stack">
                            <span>{statusLabel(j.status)}</span>
                            {j.last_error && <span className="dim">{j.last_error}</span>}
                          </div>
                        </td>
                        <td data-label="重试" className="mono">{j.attempts}</td>
                        <td data-label="时间" className="dim mono">{formatDate(j.finished_at ?? j.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Async>
    </>
  );
}

/* ---------------------------------------------------------- 政策 */

function Policies({me, onToast}) {
  const state = useAsync(() => api.policies(), []);
  const [busy, setBusy] = useState(null);

  async function toggle(p) {
    setBusy(p.key);
    try {
      await api.setPolicy(p.key, {value: p.value, confirmed: !p.confirmed});
      onToast(p.confirmed ? '已标记为待业务确认' : '已标记为业务已确认');
      state.reload();
    } catch (err) { onToast(err.message, 'error'); } finally { setBusy(null); }
  }

  async function edit(p) {
    const value = window.prompt(`修改「${p.key}」的取值`, p.value);
    if (value == null || value === p.value) return;
    setBusy(p.key);
    try {
      await api.setPolicy(p.key, {value, confirmed: false});
      onToast('已更新，并重置为待业务确认');
      state.reload();
    } catch (err) { onToast(err.message, 'error'); } finally { setBusy(null); }
  }

  const d = state.data;
  return (
    <>
      <Notice kind="warn">
        {d?.note} 当前有 <strong>{d?.unconfirmed.length ?? 0}</strong> 项口径尚未经业务确认。
      </Notice>
      <div className="card">
        <Async state={state}>
          <div className="table-scroll">
            <table>
              <thead><tr><th>口径</th><th>取值</th><th>决策依据</th><th>说明</th><th>确认状态</th></tr></thead>
              <tbody>
                {d?.items.map((p) => (
                  <tr key={p.key}>
                    <td data-label="口径" className="mono">{p.key}</td>
                    <td data-label="取值"><strong>{p.value}</strong></td>
                    <td data-label="依据"><span className="chip">{p.decision_ref}</span></td>
                    <td data-label="说明"><span className="dim">{p.note}</span></td>
                    <td data-label="确认">
                      <div className="stack">
                        <span style={{color: p.confirmed ? 'var(--green)' : 'var(--warn)'}}>
                          {p.confirmed ? '业务已确认' : '测试默认值'}
                        </span>
                        {me.is_counselor && (
                          <>
                            <button className="text-button" disabled={busy === p.key} onClick={() => edit(p)}>修改取值</button>
                            <button className="text-button" disabled={busy === p.key} onClick={() => toggle(p)}>
                              {p.confirmed ? '取消确认' : '标记已确认'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </div>
    </>
  );
}

const exceptionLabel = (k) => ({
  missing_date: '日期缺失或非法', invalid_period: '节次非法', unknown_class: '班级未匹配',
  unmatched_student: '学生未匹配', ambiguous_student: '同班同名', missing_required: '必填字段缺失',
  ambiguous_period_range: '节次粒度待确认',
}[k] ?? k);

const statusLabel = (s) => ({
  queued: '待发送', sending: '发送中', sent: '已发送', failed: '发送失败',
  unknown: '结果未知', skipped: '已跳过', running: '执行中', succeeded: '已完成',
  retry: '待重试', dead: '需人工处理',
}[s] ?? s);

const notifyKind = (k) => ({
  student_daily: '学生个人日报', counselor_daily: '辅导员日报', review_todo: '审核待办',
  appeal_result: '申诉结果', leave_result: '请假结果', verification_result: '核对结果',
  correction: '结果更正', supplemental_import: '补充导入',
}[k] ?? k);
