// 应用外壳：身份、导航、路由。
// 导航项按角色显示，但这只是入口可见性 —— 真正的权限在服务端每次请求时校验。

import {useCallback, useEffect, useState} from 'react';
import {api, getToken, setToken} from './api.js';
import {Async, Notice, Toast, useAsync} from './ui.jsx';
import {MyAttendance} from './pages/MyAttendance.jsx';
import {MyApplications} from './pages/MyApplications.jsx';
import {Workbench} from './pages/Workbench.jsx';
import {Dashboard} from './pages/Dashboard.jsx';
import {DataOps} from './pages/DataOps.jsx';

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [toast, setToast] = useState(null);
  const notify = useCallback((message, kind) => setToast({message, kind}), []);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => { setToken(null); setAuthed(false); }} toast={toast} notify={notify} clearToast={() => setToast(null)} />;
}

function Shell({onLogout, toast, notify, clearToast}) {
  const me = useAsync(() => api.me(), []);

  if (me.error?.status === 401) {
    setToken(null);
    window.location.reload();
    return null;
  }

  const u = me.data;
  const pages = u ? buildPages(u) : [];
  const [page, setPage] = useState(null);
  const current = page && pages.some((p) => p.key === page) ? page : pages[0]?.key;

  useEffect(() => {
    // 深链接：IM 消息里的链接直接落到对应页
    const path = window.location.pathname;
    if (path.startsWith('/my-attendance')) setPage('attendance');
    else if (path.startsWith('/my-applications')) setPage('applications');
    else if (path.startsWith('/dashboard')) setPage('dashboard');
    else if (path.startsWith('/approvals')) setPage('workbench');
  }, []);

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={() => setPage(pages[0]?.key)}>
          <span className="mark">考</span>
          <span>课堂考勤</span>
        </button>
        <nav aria-label="主导航">
          {pages.map((p) => (
            <button key={p.key}
              className={current === p.key ? 'nav-item active' : 'nav-item'}
              aria-current={current === p.key ? 'page' : undefined}
              onClick={() => setPage(p.key)}>{p.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        {u && (
          <button className="profile" onClick={onLogout} title="退出登录">
            <span className="avatar">{u.display_name?.[0] ?? '?'}</span>
            <span className="stack" style={{alignItems: 'flex-start'}}>
              <span>{u.display_name}</span>
              <span className="role-tag">{u.roles.map(roleName).join(' / ')}</span>
            </span>
          </button>
        )}
      </header>

      <main>
        <Async state={me}>
          {u && (
            <>
              {u.mapping_status !== 'verified' && !u.is_counselor && (
                <Notice kind="warn">{u.mapping_note}</Notice>
              )}
              {current === 'attendance' && <MyAttendance me={u} onToast={notify} />}
              {current === 'applications' && <MyApplications me={u} onToast={notify} />}
              {current === 'workbench' && <Workbench me={u} onToast={notify} />}
              {current === 'dashboard' && <Dashboard me={u} onToast={notify} />}
              {current === 'dataops' && <DataOps me={u} onToast={notify} />}
            </>
          )}
        </Async>
      </main>

      <Toast message={toast?.message} kind={toast?.kind} onDone={clearToast} />
    </>
  );
}

function buildPages(u) {
  const pages = [];
  if (u.student_id) {
    pages.push({key: 'attendance', label: '我的考勤'});
    pages.push({key: 'applications', label: '我的申请'});
  }
  const hasManage = u.manageable_classes.length > 0;
  if (hasManage) pages.push({key: 'workbench', label: u.is_counselor ? '辅导员工作台' : '本班工作台'});
  if (hasManage) pages.push({key: 'dashboard', label: '数据看板'});
  if (u.is_counselor) pages.push({key: 'dataops', label: '数据与运行'});
  if (!pages.length) pages.push({key: 'attendance', label: '我的考勤'});
  return pages;
}

function roleName(r) {
  return {student: '学生', monitor: '副班长', student_cadre: '学生干部', counselor: '辅导员', admin: '技术管理员'}[r] ?? r;
}

/**
 * 本地身份入口。
 * 真实环境这一步由 WPS 365 完成 —— 学生从 IM 点进来就已经是已认证身份，
 * 不需要也不应该有独立的账号密码体系。
 */
function Login({onDone}) {
  const users = useAsync(() => api.devUsers(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function login(userId) {
    setBusy(true);
    try {
      const out = await api.login(userId);
      setToken(out.token);
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <main style={{maxWidth: 720, paddingTop: 56}}>
      <div className="page-heading">
        <div>
          <h1>课堂考勤管理</h1>
          <p>基于 WPS 365 的学院考勤系统 · 本地仿真环境</p>
        </div>
      </div>

      <Notice kind="info">
        <strong>关于登录</strong>
        <div>
          正式环境由 WPS 365 提供统一身份，学生从 IM 消息点进来即已认证，不存在独立账号密码。
          当前是本地仿真环境，下面的身份选择器仅用于演示各角色视图。
        </div>
      </Notice>

      {error && <Notice kind="error">{error.message}</Notice>}

      <div className="card">
        <h2>选择一个身份进入</h2>
        <p className="sub">角色与数据范围由服务端按角色授权表判定</p>
        <Async state={users}>
          <div className="grid cols-2" style={{marginTop: 14}}>
            {users.data?.users.map((u) => (
              <button key={u.user_id} className="card" disabled={busy}
                style={{textAlign: 'left', cursor: 'pointer'}}
                onClick={() => login(u.user_id)}>
                <strong style={{color: 'var(--deep)'}}>{u.display_name}</strong>
                <div className="dim">{u.roles.map(roleName).join(' / ') || '无角色'}</div>
              </button>
            ))}
          </div>
        </Async>
      </div>
    </main>
  );
}
