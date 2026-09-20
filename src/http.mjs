import http from 'node:http';
import { createService, ValidationError } from './domain/service.mjs';

/**
 * 演示用令牌表：外部机构持自身令牌，只能看到本机构授信数据；
 * 生产环境应替换为签名验签，这里保持零依赖可联调。
 */
export const TOKENS = {
  'token-registrar': { role: 'registrar', displayName: '林权登记机构' },
  'token-regulator': { role: 'regulator', displayName: '金融监管协作方' },
  'token-bank-a': { role: 'institution', institutionId: 'BANK_A', displayName: '甲银行' },
  'token-bank-b': { role: 'institution', institutionId: 'BANK_B', displayName: '乙银行' },
};

const json = (response, status, payload, extraHeaders = {}) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  response.end(JSON.stringify(payload));
};

const readBody = async (request) => {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('payload_too_large'), { httpStatus: 413 });
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
    return parsed;
  } catch {
    throw Object.assign(new Error('invalid_json'), { httpStatus: 400, reason: 'invalid_json' });
  }
};

export function createServer(service = createService()) {
  const authenticate = (request) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const principal = token ? TOKENS[token] : null;
    if (!principal) throw Object.assign(new Error('unauthorized'), { httpStatus: 401, reason: 'unauthorized' });
    return principal;
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }

      const principal = authenticate(request);
      const body = request.method === 'POST' ? await readBody(request) : {};
      const idempotencyKey = request.headers['idempotency-key']?.toString() ?? null;

      let result;
      const route = matchRoute(request.method, path);
      if (!route) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      result = await route.run(service, principal, body, idempotencyKey);

      if (result.kind === 'view') {
        json(response, 200, result.body);
      } else {
        json(response, result.status, result.body, result.replayed ? { 'x-idempotent-replay': 'true' } : {});
      }
    } catch (error) {
      const status = error.httpStatus ?? (error instanceof ValidationError ? 400 : 500);
      if (status === 500) console.error(error);
      json(response, status, {
        error: status === 400 ? 'invalid_request' : error.reason ?? 'internal_error',
        reason: error.reason ?? null,
        detail: error.detail ?? {},
      });
    }
  });
}

function matchRoute(method, path) {
  const routes = [
    ['POST', /^\/certificates$/, (s, p, b, k) => s.registerCertificate(p, b, k)],
    ['GET', /^\/certificates\/([^/]+)$/, (s, p, b, k, m) => viewWrap(() => s.viewCertificate(p, m[1]))],
    ['POST', /^\/certificates\/([^/]+)\/valuations$/, (s, p, b, k, m) => s.recordValuation(p, m[1], b, k)],
    ['POST', /^\/certificates\/([^/]+)\/facilities$/, (s, p, b, k, m) => s.freezeFacility(p, m[1], b, k)],
    ['GET', /^\/facilities$/, (s, p) => viewWrap(() => s.listFacilities(p))],
    ['GET', /^\/facilities\/([^/]+)$/, (s, p, b, k, m) => viewWrap(() => s.viewFacility(p, m[1]))],
    ['POST', /^\/facilities\/([^/]+)\/drawdowns$/, (s, p, b, k, m) => s.drawdown(p, m[1], b, k)],
    ['POST', /^\/facilities\/([^/]+)\/repayments$/, (s, p, b, k, m) => s.repay(p, m[1], b, k)],
    ['POST', /^\/facilities\/([^/]+)\/revocations$/, (s, p, b, k, m) => s.requestRevocation(p, m[1], b, k)],
    ['POST', /^\/facilities\/([^/]+)\/revocations\/cancel$/, (s, p, b, k, m) => s.cancelRevocation(p, m[1], k)],
    ['POST', /^\/facilities\/([^/]+)\/revocations\/finalize$/, (s, p, b, k, m) => s.finalizeRevocation(p, m[1], k)],
    ['POST', /^\/facilities\/([^/]+)\/releases$/, (s, p, b, k, m) => s.requestRelease(p, m[1], b, k)],
    ['POST', /^\/releases\/([^/]+)\/receipts$/, (s, p, b, k, m) => s.recordReceipt(p, m[1], b, k)],
    ['GET', /^\/releases\/([^/]+)$/, (s, p, b, k, m) => viewWrap(() => s.viewRelease(p, m[1]))],
    ['GET', /^\/regulator\/events$/, (s, p) => viewWrap(() => ({ events: s.auditEvents(p) }))],
    ['POST', /^\/regulator\/recompute$/, (s, p) => viewWrap(() => s.recompute(p))],
  ];
  for (const [routeMethod, pattern, run] of routes) {
    if (routeMethod !== method) continue;
    const match = path.match(pattern);
    if (match) return { run: (service, principal, body, key) => run(service, principal, body, key, match) };
  }
  return null;
}

const viewWrap = (fn) => ({ kind: 'view', body: fn() });
