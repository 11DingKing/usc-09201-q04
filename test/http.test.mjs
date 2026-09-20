import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, TOKENS } from '../src/http.mjs';

const base = async (server, method, path, token, body, headers = {}) => {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, headers: response.headers, json };
};

const listen = async (server, context) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
};

test('HTTP：无令牌拒绝，机构按令牌隔离数据', async (context) => {
  const server = createServer();
  await listen(server, context);

  const unauthorized = await base(server, 'GET', '/certificates/LQ-1', null);
  assert.equal(unauthorized.status, 401);

  const reg = await base(server, 'POST', '/certificates', 'token-registrar', {
    certificateId: 'LQ-1',
    enterpriseId: 'E1',
    parcelIds: ['P1', 'P2'],
    initialValue: 1000,
  });
  assert.equal(reg.status, 201);

  // 登记令牌不能冻结授信
  const wrongRole = await base(server, 'POST', '/certificates/LQ-1/facilities', 'token-registrar', {
    facilityId: 'FA',
    parcelIds: ['P1'],
    limit: 100,
  });
  assert.equal(wrongRole.status, 403);

  const freeze = await base(server, 'POST', '/certificates/LQ-1/facilities', 'token-bank-a', {
    facilityId: 'FA',
    parcelIds: ['P1'],
    limit: 400,
  });
  assert.equal(freeze.status, 201);

  // 乙银行看不到甲银行授信明细，只看到地块被占用
  const viewB = await base(server, 'GET', '/certificates/LQ-1', 'token-bank-b');
  assert.equal(viewB.status, 200);
  assert.equal(viewB.json.facilities.length, 0);
  assert.equal(viewB.json.parcels[0].status, 'encumbered');

  // 甲银行看到完整明细
  const viewA = await base(server, 'GET', '/certificates/LQ-1', 'token-bank-a');
  assert.equal(viewA.json.facilities[0].facilityId, 'FA');
  assert.equal(viewA.json.availability.totalFrozenLimit, 400);
});

test('HTTP：并发冻结经同权证串行队列分出确定赢家，冲突响应可审计', async (context) => {
  const server = createServer();
  await listen(server, context);

  await base(server, 'POST', '/certificates', 'token-registrar', {
    certificateId: 'LQ-2',
    enterpriseId: 'E2',
    parcelIds: ['P1', 'P2'],
    initialValue: 1000,
  });

  const [a, b] = await Promise.all([
    base(server, 'POST', '/certificates/LQ-2/facilities', 'token-bank-a', {
      facilityId: 'FA', parcelIds: ['P1'], limit: 400,
    }),
    base(server, 'POST', '/certificates/LQ-2/facilities', 'token-bank-b', {
      facilityId: 'FB', parcelIds: ['P1'], limit: 400,
    }),
  ]);

  const winner = a.status === 201 ? a : b;
  const loser = a.status === 201 ? b : a;
  assert.equal(winner.status, 201);
  assert.equal(loser.status, 409);
  assert.equal(loser.json.reason, 'parcel_already_encumbered');
  assert.ok(['BANK_A', 'BANK_B'].includes(loser.json.detail.heldBy));

  const events = await base(server, 'GET', '/regulator/events', 'token-bank-b');
  assert.equal(events.status, 403);
  const audit = await base(server, 'GET', '/regulator/events', 'token-regulator');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.events.some((event) => event.type === 'command.rejected'));
  // 哈希链逐事件存在
  for (const event of audit.json.events) assert.match(event.hash, /^[0-9a-f]{64}$/);
});

test('HTTP：幂等头保证重试不产生第二笔；监管重算端点返回一致', async (context) => {
  const server = createServer();
  await listen(server, context);

  await base(server, 'POST', '/certificates', 'token-registrar', {
    certificateId: 'LQ-3',
    enterpriseId: 'E3',
    parcelIds: ['P1'],
    initialValue: 1000,
  });

  const payload = { facilityId: 'FA', parcelIds: ['P1'], limit: 300 };
  const first = await base(server, 'POST', '/certificates/LQ-3/facilities', 'token-bank-a', payload, {
    'idempotency-key': 'freeze-77',
  });
  const replay = await base(server, 'POST', '/certificates/LQ-3/facilities', 'token-bank-a', payload, {
    'idempotency-key': 'freeze-77',
  });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');

  const recompute = await base(server, 'POST', '/regulator/recompute', 'token-regulator');
  assert.equal(recompute.status, 200);
  assert.equal(recompute.json.stateMatches, true);
  assert.equal(recompute.json.balances['LQ-3'].match, true);
  assert.equal(recompute.json.balances['LQ-3'].live.totalFrozenLimit, 300);
});

test('HTTP：联调脚本——冻结、提款、提前还款、估值更正、回执释放全链路', async (context) => {
  const server = createServer();
  await listen(server, context);
  const call = (token, method, path, body) => base(server, method, path, token, body);

  await call('token-registrar', 'POST', '/certificates', {
    certificateId: 'LQ-9',
    enterpriseId: 'E9',
    parcelIds: ['P1', 'P2', 'P3'],
    weights: { P1: 0.5, P2: 0.3, P3: 0.2 },
    initialValue: 1000,
  });
  assert.equal((await call('token-bank-a', 'POST', '/certificates/LQ-9/facilities', {
    facilityId: 'FA', parcelIds: ['P1', 'P2'], limit: 700,
  })).status, 201);
  assert.equal((await call('token-bank-b', 'POST', '/certificates/LQ-9/facilities', {
    facilityId: 'FB', parcelIds: ['P3'], limit: 200,
  })).status, 201);

  assert.equal((await call('token-bank-a', 'POST', '/facilities/FA/drawdowns', {
    drawdownId: 'D1', amount: 400,
  })).status, 201);

  // 提前还款
  const repay = await call('token-bank-a', 'POST', '/facilities/FA/repayments', { amount: 250 });
  assert.equal(repay.status, 201);
  assert.equal(repay.json.allocations[0].amount, 250);

  // 申请释放 P2：剩余 P1 覆盖 500，覆盖 150 余额
  const releaseReq = await call('token-bank-a', 'POST', '/facilities/FA/releases', {
    releaseId: 'REL-1', parcelIds: ['P2'],
  });
  assert.equal(releaseReq.status, 201);
  assert.deepEqual(releaseReq.json.requiredParties.sort(), ['BANK_B', 'registrar']);

  // 乱序回执
  assert.equal((await call('token-bank-b', 'POST', '/releases/REL-1/receipts', {
    decision: 'approve',
  })).status, 201);
  const decided = await call('token-registrar', 'POST', '/releases/REL-1/receipts', {
    decision: 'approve',
  });
  assert.equal(decided.status, 201);

  const facility = await call('token-bank-a', 'GET', '/facilities/FA');
  assert.deepEqual(facility.json.parcelIds, ['P1']);
  assert.equal(facility.json.limit, 400);
  assert.equal(facility.json.outstanding, 150);

  const view = await call('token-regulator', 'GET', '/certificates/LQ-9');
  assert.equal(view.json.availability.totalOutstanding, 150);
  assert.equal(view.json.releases[0].status, 'approved');

  const recompute = await call('token-regulator', 'POST', '/regulator/recompute');
  assert.equal(recompute.json.stateMatches, true);
  assert.equal(recompute.json.balances['LQ-9'].match, true);

  assert.ok(Object.keys(TOKENS).length >= 4);
});
