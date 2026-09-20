import http from 'node:http';
import { FinancingService } from './domain/service.mjs';
import { EventStore } from './domain/store.mjs';
import { DomainError } from './domain/errors.mjs';

/**
 * 身份由网关注入的请求头表示（联调环境）：
 *   x-actor-role: regulator | institution
 *   x-actor-id:   机构编号（机构身份必填）
 * 生产环境应替换为 mTLS/签名验签后的主体。
 */
function readActor(request) {
  const role = request.headers['x-actor-role'];
  const id = request.headers['x-actor-id'] ? String(request.headers['x-actor-id']) : null;
  if (!role) return null;
  return { role: String(role), id };
}

async function readJsonBody(request, { maxBytes = 1_000_000 } = {}) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > maxBytes) {
      throw new DomainError('payload_too_large', '请求体过大', 413);
    }
  }
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError('invalid_json', '请求体不是合法 JSON', 400);
  }
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createServer({ service } = {}) {
  const financing =
    service ||
    new FinancingService({
      store: new EventStore(process.env.EVENT_STORE_DIR || './data/events'),
    });

  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (name) => {
        names.push(name.slice(1));
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, regex, names, handler });
  };

  /* ----------------------------- 监管端点 ----------------------------- */
  route('POST', '/v1/certificates', async (body, actor) => {
    const result = await financing.registerCertificate(body, actor);
    return { status: 201, body: result };
  });
  route('POST', '/v1/certificates/:certificateId/valuations', async (body, actor, params) => {
    const result = await financing.recordValuation({ ...body, certificateId: params.certificateId }, actor);
    return { status: 201, body: result };
  });
  route('GET', '/v1/audit', async (_body, actor) => {
    return { status: 200, body: await financing.audit(actor) };
  });

  /* ----------------------------- 共用查询 ----------------------------- */
  route('GET', '/v1/certificates', async (_body, actor) => {
    return { status: 200, body: { items: await financing.listCertificates(actor) } };
  });
  route('GET', '/v1/certificates/:certificateId', async (_body, actor, params) => {
    return { status: 200, body: await financing.queryCertificate(params.certificateId, actor) };
  });
  route('GET', '/v1/credits/:creditId', async (_body, actor, params) => {
    return { status: 200, body: await financing.queryCredit(params.creditId, actor) };
  });

  /* ----------------------------- 机构端点 ----------------------------- */
  route('POST', '/v1/credits/freeze', async (body, actor) => {
    return { status: 201, body: await financing.freezeCredit(body, actor) };
  });
  route('POST', '/v1/credits/:creditId/drawdowns', async (body, actor, params) => {
    return { status: 201, body: await financing.drawdown({ ...body, creditId: params.creditId }, actor) };
  });
  route('POST', '/v1/credits/:creditId/repayments', async (body, actor, params) => {
    return { status: 201, body: await financing.repay({ ...body, creditId: params.creditId }, actor) };
  });
  route('POST', '/v1/credits/:creditId/releases', async (body, actor, params) => {
    return { status: 201, body: await financing.releaseCollateral({ ...body, creditId: params.creditId }, actor) };
  });
  route('POST', '/v1/credits/:creditId/revocation', async (body, actor, params) => {
    return { status: 202, body: await financing.requestRevocation({ ...body, creditId: params.creditId }, actor) };
  });
  route('POST', '/v1/credits/:creditId/revocation/confirm', async (body, actor, params) => {
    return { status: 200, body: await financing.confirmRevocation({ ...body, creditId: params.creditId }, actor) };
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { status: 'ok' });
        return;
      }
      const match = routes.find(
        (entry) => entry.method === request.method && entry.regex.test(url.pathname),
      );
      if (!match) {
        send(response, 404, { error: 'not_found' });
        return;
      }
      const actor = readActor(request);
      if (!actor) {
        send(response, 401, { error: 'unauthorized', message: '缺少身份请求头 x-actor-role/x-actor-id' });
        return;
      }
      const parts = url.pathname.match(match.regex);
      const params = Object.fromEntries(match.names.map((name, i) => [name, decodeURIComponent(parts[i + 1])]));
      const body = await readJsonBody(request);
      const outcome = await match.handler(body, actor, params);
      send(response, outcome.status, outcome.body);
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.statusCode, { error: error.code, message: error.message, details: error.details });
        return;
      }
      send(response, 500, { error: 'internal_error', message: error.message });
    }
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
