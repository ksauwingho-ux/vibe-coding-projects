// 共用界面组件。
// 空状态、加载失败、权限不足、同步中、数据未齐都要显式展示，
// 不用无限加载代替错误（03 §7）。

import {useEffect, useRef, useState} from 'react';

export const DISPLAY = {待处理: '待核实'};
export const label = (j) => DISPLAY[j] ?? j;

export function Badge({judgment}) {
  return <span className={`badge ${judgment}`}>{label(judgment)}</span>;
}

export function Notice({kind = 'info', children}) {
  if (!children) return null;
  return <div className={`notice ${kind}`}>{children}</div>;
}

/** 统一的异步状态壳：加载中 / 出错 / 空 / 内容，四态都有明确呈现。 */
export function Async({state, empty, children}) {
  if (state.loading) return <div className="empty"><p>加载中…</p></div>;
  if (state.error) {
    const e = state.error;
    const kind = e.code === 'FORBIDDEN' ? 'warn' : 'error';
    return (
      <div className="empty">
        <Notice kind={kind}>
          <strong>{e.code === 'FORBIDDEN' ? '权限不足' : '加载失败'}</strong>
          <div>{e.message}</div>
          {e.requestId && <div className="dim">请求编号 {e.requestId}</div>}
        </Notice>
        {state.retry && <button className="secondary" onClick={state.retry}>重试</button>}
      </div>
    );
  }
  if (empty) return <div className="empty"><h3>{empty.title}</h3><p>{empty.hint}</p></div>;
  return children;
}

/** 简单的数据获取 hook，带重试与竞态保护。 */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({loading: true, error: null, data: null});
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setState((s) => ({...s, loading: true, error: null}));
    fn()
      .then((data) => { if (alive.current) setState({loading: false, error: null, data}); })
      .catch((error) => { if (alive.current) setState({loading: false, error, data: null}); });
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {...state, retry: () => setNonce((n) => n + 1), reload: () => setNonce((n) => n + 1)};
}

export function Modal({title, eyebrow, onClose, children, wide}) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog
      ref={ref}
      style={wide ? {maxWidth: '900px'} : undefined}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <div>
            {eyebrow && <div className="dim">{eyebrow}</div>}
            <h2>{title}</h2>
          </div>
          <button className="text-button" onClick={onClose} aria-label="关闭">关闭</button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Metric({label: text, value, tone = '', note}) {
  return (
    <div className="metric">
      <span>{text}</span>
      <strong className={tone}>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function Toast({message, kind, onDone}) {
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return <div className={`toast ${kind === 'error' ? 'error' : ''}`} role="status">{message}</div>;
}

/** 六类结果计数条。待核实单列，不并入异常。 */
export function JudgmentCounts({counts}) {
  const order = ['正常', '旷课', '迟到', '早退', '请假', '待处理'];
  return (
    <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
      {order.map((j) => (
        <span key={j} className="chip">
          {label(j)}<span>{counts?.[j] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

export function formatDate(iso) {
  if (!iso) return '—';
  return iso.length > 10 ? new Date(iso).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) : iso;
}
