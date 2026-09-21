// 极简 HTTP 框架：路由、JSON、错误映射。零依赖。

import {Forbidden} from '../domain/authz.js';
import {WriteRejected} from '../domain/writer.js';
import {RevisionConflict} from '../adapters/table.js';
import {newId} from '../lib/util.js';

const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  REVISION_CONFLICT: 409,
  ALREADY_HANDLED: 409,
  ALREADY_FINISHED: 409,
  SPLIT_REQUIRED: 409,
  NOT_APPEALABLE: 409,
  IN_PUBLIC_PERIOD: 409,
  LOCKED: 409,
  DEADLINE_PASSED: 409,
  POLICY_UNCONFIRMED: 409,
  NO_APPROVER: 422,
  NO_REVIEWER: 422,
  SOURCE_DISABLED: 501,
  SOURCE_NOT_AVAILABLE: 501,
  RATE_LIMITED: 429,
};

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:([A-Za-z_]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`);
    this.routes.push({method, regex, keys, handler});
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return {handler: r.handler, params};
    }
    return null;
  }
}

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function readBody(req, {limit = 64 * 1024 * 1024} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new WriteRejected('VALIDATION_ERROR', '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req, {limit: 2 * 1024 * 1024});
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch {
    throw new WriteRejected('VALIDATION_ERROR', '请求体不是合法 JSON');
  }
}

/** 统一错误响应。把内部异常映射成稳定的错误码，不把栈泄漏给前端。 */
export function sendError(res, err, requestId = newId('req')) {
  let code = err.code ?? 'INTERNAL_ERROR';
  if (err instanceof Forbidden) code = 'FORBIDDEN';
  if (err instanceof RevisionConflict) code = 'REVISION_CONFLICT';

  const status = ERROR_STATUS[code] ?? 500;
  if (status >= 500) console.error(`[${requestId}]`, err);

  json(res, status, {
    error: {
      code,
      message: status >= 500 ? '服务内部错误，请稍后重试' : err.message,
      request_id: requestId,
      retryable: ['REVISION_CONFLICT', 'RATE_LIMITED'].includes(code),
      detail: status >= 500 ? undefined : err.detail ?? err.pending,
    },
  });
}
