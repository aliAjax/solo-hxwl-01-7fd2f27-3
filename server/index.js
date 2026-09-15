// HTTP 服务：REST API + 静态托管前端构建产物。
// 并发约定：
//   - 所有变更经 Store.transact 串行执行；
//   - 写接口接受 expectedVersion（乐观锁，防覆盖他人记录）；
//   - 放行接口接受 Idempotency-Key 头（防双击/重试/刷新导致重复放行）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { seed } from './seed.js';
import * as dom from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createApp({ dataFile, nowFn = () => new Date(), sweepIntervalMs = 60_000 } = {}) {
  const store = new Store(dataFile || path.join(__dirname, '..', 'data', 'db.json'), () => seed(nowFn()));

  const runSweep = () => store.transact((s) => dom.sweep(s, nowFn())).catch(() => {});
  runSweep(); // 启动即清扫：跨夜/跨日积累的过期状态立即生效
  const timer = setInterval(runSweep, sweepIntervalMs);
  timer.unref();

  const actorOf = (req) => {
    const raw = req.headers['x-actor'] || '';
    if (!raw) return '系统';
    try {
      if (raw.includes('%')) return decodeURIComponent(raw);
      // 兼容直发 UTF-8 字节的客户端（Node 按 latin1 解析请求头）
      const fixed = Buffer.from(raw, 'latin1').toString('utf8');
      return fixed.includes('�') ? raw : fixed;
    } catch { return raw; }
  };

  async function handleApi(req, res, url) {
    const m = req.method;
    const p = url.pathname;
    const body = ['POST', 'PATCH', 'PUT'].includes(m) ? await readBody(req) : {};
    const actor = actorOf(req);
    const now = nowFn();
    const q = url.searchParams;
    // 幂等变更：携带 Idempotency-Key 的请求，并发/双击/失败重试/刷新重发都返回首次结果，绝不重复执行
    const mutate = (fn) => store.transact((s) => dom.withIdempotency(s, now, req.headers['idempotency-key'] || null, () => fn(s)));

    // ---- 只读 ----
    if (m === 'GET' && p === '/api/health') return { ok: true, now: dom.iso(now) };
    if (m === 'GET' && p === '/api/state') {
      await store.transact((s) => dom.sweep(s, now));
      return store.read((s) => dom.dashboard(s, now));
    }
    if (m === 'GET' && p === '/api/alerts') {
      await store.transact((s) => dom.sweep(s, now));
      return store.read((s) => ({ alerts: dom.computeAlerts(s, now) }));
    }
    if (m === 'GET' && p === '/api/operators') return store.read((s) => ({ operators: s.operators }));
    if (m === 'GET' && p === '/api/equipment') return store.read((s) => ({ equipment: s.equipment }));
    if (m === 'GET' && p === '/api/instruments') {
      return store.read((s) => {
        let list = s.instruments;
        if (q.get('status')) list = list.filter((i) => i.status === q.get('status'));
        if (q.get('q')) {
          const kw = q.get('q').toLowerCase();
          list = list.filter((i) => i.code.toLowerCase().includes(kw) || i.name.toLowerCase().includes(kw));
        }
        return { instruments: list };
      });
    }
    if (m === 'GET' && p === '/api/batches') {
      return store.read((s) => {
        let list = s.batches.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        if (q.get('status')) list = list.filter((b) => b.releaseStatus === q.get('status'));
        return { batches: list.map((b) => enrichBatch(s, b)) };
      });
    }
    const batchMatch = p.match(/^\/api\/batches\/([^/]+)$/);
    if (m === 'GET' && batchMatch) {
      return store.read((s) => ({ batch: enrichBatch(s, mustBatch(s, batchMatch[1])) }));
    }
    if (m === 'GET' && p === '/api/usage') {
      return store.read((s) => {
        let list = s.usage.slice().sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
        if (q.get('open') === '1') list = list.filter((u) => u.endAt == null);
        return { usage: list.map((u) => ({ ...u, instrument: briefInstrument(s, u.instrumentId) })) };
      });
    }
    if (m === 'GET' && p === '/api/pauses') {
      return store.read((s) => ({
        pauses: s.pauses.slice().reverse().map((ps) => ({
          ...ps,
          items: ps.items.map((it) => ({ ...it, instrument: briefInstrument(s, it.instrumentId) })),
        })),
      }));
    }
    const traceMatch = p.match(/^\/api\/instruments\/([^/]+)\/trace$/);
    if (m === 'GET' && traceMatch) return store.read((s) => dom.traceInstrument(s, traceMatch[1]));
    if (m === 'GET' && p === '/api/audit') {
      return store.read((s) => {
        let list = s.audit.slice().reverse();
        if (q.get('entityType')) list = list.filter((a) => a.entityType === q.get('entityType'));
        if (q.get('entityId')) list = list.filter((a) => a.entityId === q.get('entityId'));
        return { audit: list.slice(0, Number(q.get('limit')) || 200) };
      });
    }
    if (m === 'GET' && p === '/api/handover') {
      await store.transact((s) => dom.sweep(s, now));
      return store.read((s) => dom.handoverSummary(s, now));
    }

    // ---- 变更（全部串行事务 + 幂等包装）----
    if (m === 'POST' && p === '/api/instruments') {
      return mutate((s) => dom.createInstrument(s, now, { actor, ...body }));
    }
    if (m === 'POST' && p === '/api/batches') {
      return mutate((s) => dom.createBatch(s, now, { actor, ...body }));
    }
    const equipMatch = p.match(/^\/api\/equipment\/([^/]+)$/);
    if (m === 'PATCH' && equipMatch) {
      return mutate((s) => dom.updateEquipment(s, now, { actor, equipmentId: equipMatch[1], ...body }));
    }
    const act = p.match(/^\/api\/batches\/([^/]+)\/(complete|monitor|release|lock|rechecks)$/);
    if (m === 'POST' && act) {
      const [, batchId, action] = act;
      if (action === 'complete') return mutate((s) => dom.completeBatch(s, now, { actor, batchId, ...body }));
      if (action === 'monitor') return mutate((s) => dom.recordMonitor(s, now, { actor, batchId, ...body }));
      if (action === 'lock') return mutate((s) => dom.lockBatch(s, now, { actor, batchId, ...body }));
      if (action === 'rechecks') return mutate((s) => dom.recheckBatch(s, now, { actor, batchId, ...body }));
      if (action === 'release') return mutate((s) => dom.releaseBatch(s, now, { actor, batchId, ...body }));
    }
    const instAct = p.match(/^\/api\/instruments\/([^/]+)\/(checkout|return|pause-related)$/);
    if (m === 'POST' && instAct) {
      const [, instrumentId, action] = instAct;
      if (action === 'checkout') return mutate((s) => dom.checkoutInstrument(s, now, { actor, instrumentId, ...body }));
      if (action === 'return') return mutate((s) => dom.returnInstrument(s, now, { actor, instrumentId, ...body }));
      if (action === 'pause-related') return mutate((s) => dom.pauseRelated(s, now, { actor, rootInstrumentId: instrumentId, ...body }));
    }
    const liftMatch = p.match(/^\/api\/pauses\/([^/]+)\/lift$/);
    if (m === 'POST' && liftMatch) {
      return mutate((s) => dom.liftPause(s, now, { actor, pauseId: liftMatch[1], ...body }));
    }
    if (m === 'POST' && p === '/api/handover') {
      return mutate((s) => dom.recordHandover(s, now, { actor, ...body }));
    }
    throw new dom.DomainError(404, 'NO_ROUTE', `接口不存在：${m} ${p}`);
  }

  function enrichBatch(s, b) {
    const eq = (id) => (s.equipment.find((e) => e.id === id) || {}).name || id;
    const op = (id) => (s.operators.find((o) => o.id === id) || {}).name || id;
    return {
      ...b,
      washerName: eq(b.washerId),
      sterilizerName: eq(b.sterilizerId),
      operatorName: op(b.operatorId),
      itemDetails: b.items.map((id) => briefInstrument(s, id)),
      recheckDetails: s.rechecks.filter((r) => r.batchId === b.id),
    };
  }
  function briefInstrument(s, id) {
    const i = s.instruments.find((x) => x.id === id);
    return i ? { id: i.id, code: i.code, name: i.name, status: i.status } : { id };
  }
  function mustBatch(s, id) {
    const b = s.batches.find((x) => x.id === id);
    if (!b) throw new dom.DomainError(404, 'NOT_FOUND', `批次不存在：${id}`);
    return b;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Actor,Idempotency-Key');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (url.pathname.startsWith('/api/')) {
        const data = await handleApi(req, res, url);
        if (data && data._replay === true) res.setHeader('Idempotent-Replay', 'true');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      serveStatic(res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.code || 'INTERNAL', message: e.message, extra: e.extra || null } }));
      if (status === 500) console.error(e);
    }
  });

  function serveStatic(res, pathname) {
    if (!fs.existsSync(DIST)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('API 运行中。前端未构建：请先 npm run build，或使用 npm run dev 启动 Vite 开发服。');
      return;
    }
    let fp = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
    if (!fp.startsWith(DIST) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  }

  return {
    store,
    server,
    listen(port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(timer);
      server.closeAllConnections?.(); // 断开 keep-alive，确保端口立即释放（重启场景）
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new dom.DomainError(413, 'TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new dom.DomainError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 直接运行：node server/index.js [port]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || process.argv[2] || 5102);
  const app = createApp({});
  app.listen(port).then((p) => console.log(`[消毒与校准追踪台] API 已启动: http://localhost:${p}  (数据文件: ${app.store.file})`));
}
