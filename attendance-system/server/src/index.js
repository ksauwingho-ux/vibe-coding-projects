// HTTP 服务入口。

import {createServer} from 'node:http';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {join, dirname, extname, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb} from './db/index.js';
import {Identity} from './adapters/identity.js';
import {buildPrincipal} from './domain/authz.js';
import {router, sendError} from './api/routes.js';
import {json} from './api/http.js';
import {startWorker, scheduleDailyJobs} from './jobs/worker.js';
import {newId, businessDate} from './lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, '../../web/dist');
const PORT = Number(process.env.PORT || 8787);

/** 无需登录的接口。其余一律要求已认证身份。 */
const PUBLIC_PATHS = new Set([
  '/api/auth/dev-login', '/api/dev/users', '/api/health',
  '/api/ingest/sources', '/api/admin/capabilities',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createApp() {
  openDb();

  return createServer(async (req, res) => {
    const requestId = newId('req');
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // CORS：仅开发期放开，生产由同源部署或网关控制
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-file-name,x-source-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (pathname === '/api/health') {
      return json(res, 200, {ok: true, business_date: businessDate(), request_id: requestId});
    }

    if (pathname.startsWith('/api/')) {
      try {
        const route = router.match(req.method, pathname);
        if (!route) return json(res, 404, {error: {code: 'NOT_FOUND', message: '接口不存在', request_id: requestId}});

        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
        let principal = null;
        if (!PUBLIC_PATHS.has(pathname)) {
          const user = Identity.resolveCurrentUser(token);
          if (!user) {
            return json(res, 401, {
              error: {code: 'UNAUTHENTICATED', message: '未登录或登录已失效', request_id: requestId},
            });
          }
          principal = buildPrincipal(user);
        }

        const ctx = {
          principal, token, requestId, params: route.params,
          query: Object.fromEntries(url.searchParams),
        };
        // 数组型查询参数：judgments=旷课,迟到
        if (ctx.query.judgments) ctx.query.judgments = ctx.query.judgments.split(',').filter(Boolean);

        await route.handler(req, res, ctx);
        if (!res.writableEnded) res.end();
      } catch (err) {
        if (!res.headersSent) sendError(res, err, requestId);
        else res.end();
      }
      return;
    }

    serveStatic(res, pathname);
  });
}

function serveStatic(res, pathname) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    return res.end('<!doctype html><meta charset="utf-8"><title>考勤系统</title>'
      + '<p style="font-family:system-ui;padding:2rem">前端尚未构建。'
      + '开发模式请运行 <code>npm run web:dev</code>，或先执行 <code>npm run web:build</code>。</p>');
  }
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(WEB_DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(WEB_DIST)) { res.writeHead(403); return res.end(); }
  // SPA 路由回退
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createApp();
  const worker = startWorker();
  scheduleDailyJobs();
  server.listen(PORT, () => {
    console.log(`考勤系统服务已启动: http://localhost:${PORT}`);
    console.log('运行环境：本地仿真。WPS 365 平台能力全部由适配器模拟，未在真实租户验证。');
  });
  const shutdown = () => {
    worker.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
