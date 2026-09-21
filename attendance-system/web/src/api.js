// 数据访问层。前端只通过它与服务端对话。
//
// 重要：这里返回的 allowed_actions 等字段只是界面提示。
// 权限判断一律以服务端为准 —— 前端筛选不是访问控制。

const TOKEN_KEY = 'attendance.token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* 隐私模式下忽略 */ }
}

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message ?? '请求失败');
    this.code = payload?.code ?? 'UNKNOWN';
    this.detail = payload?.detail;
    this.requestId = payload?.request_id;
    this.retryable = payload?.retryable ?? false;
    this.status = status;
  }
}

async function request(path, {method = 'GET', body, raw, headers = {}} = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body && !raw ? {'content-type': 'application/json'} : {}),
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw new ApiError({message: `请求失败（${res.status}）`}, res.status);
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error ?? {}, res.status);
  return data;
}

const qs = (params = {}) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    usp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  devUsers: () => request('/api/dev/users'),
  login: (userId) => request('/api/auth/dev-login', {method: 'POST', body: {user_id: userId}}),
  logout: () => request('/api/auth/logout', {method: 'POST'}),
  me: () => request('/api/me'),

  attendance: (params) => request(`/api/attendance${qs(params)}`),
  attendanceDetail: (id) => request(`/api/attendance/${id}`),
  summary: (params) => request(`/api/summary${qs(params)}`),
  dashboard: (params) => request(`/api/dashboard${qs(params)}`),
  exportUrl: (params) => `/api/export/attendance${qs({...params, token: getToken()})}`,

  verificationQueue: (params) => request(`/api/verification/queue${qs(params)}`),
  verify: (body) => request('/api/verification/verify', {method: 'POST', body}),
  verifyBatch: (body) => request('/api/verification/verify-batch', {method: 'POST', body}),
  reviewQueue: (params) => request(`/api/review/queue${qs(params)}`),
  resolveReview: (body) => request('/api/review/resolve', {method: 'POST', body}),

  leaves: () => request('/api/leaves'),
  leave: (id) => request(`/api/leaves/${id}`),
  submitLeave: (body) => request('/api/leaves', {method: 'POST', body}),
  revokeLeave: (id, reason) => request(`/api/leaves/${id}/revoke`, {method: 'POST', body: {reason}}),
  leaveCandidates: () => request('/api/leaves/candidates'),

  appeals: () => request('/api/appeals'),
  appeal: (id) => request(`/api/appeals/${id}`),
  appealTodos: () => request('/api/appeals/todos'),
  submitAppeal: (body) => request('/api/appeals', {method: 'POST', body}),
  decideAppeal: (id, body) => request(`/api/appeals/${id}/decide`, {method: 'POST', body}),
  withdrawAppeal: (id, reason) => request(`/api/appeals/${id}/withdraw`, {method: 'POST', body: {reason}}),

  approvalTodos: () => request('/api/approvals/todos'),
  decideApproval: (id, body) => request(`/api/approvals/${id}/decide`, {method: 'POST', body}),

  registerEvidence: (body) => request('/api/evidence', {method: 'POST', body}),

  ingestSources: () => request('/api/ingest/sources'),
  ingestBatches: () => request('/api/ingest/batches'),
  ingestExceptions: (params) => request(`/api/ingest/exceptions${qs(params)}`),
  ingestUpload: (file, {dryRun, termId} = {}) => request(
    `/api/ingest/upload${qs({dry_run: dryRun ? '1' : '', term_id: termId})}`,
    {method: 'POST', raw: file, headers: {'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream'}},
  ),
  confirmCoverage: (body) => request('/api/coverage/confirm', {method: 'POST', body}),

  policies: () => request('/api/admin/policies'),
  setPolicy: (key, body) => request(`/api/admin/policies/${key}`, {method: 'PUT', body}),
  operations: () => request('/api/admin/operations'),
  runJobs: () => request('/api/admin/jobs/run', {method: 'POST'}),
  runDigest: (body) => request('/api/admin/digest/run', {method: 'POST', body}),
  capabilities: () => request('/api/admin/capabilities'),
};
