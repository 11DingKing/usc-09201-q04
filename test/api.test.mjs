import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { FinancingService } from '../src/domain/service.mjs';
import { MemoryEventStore } from '../src/domain/store.mjs';

async function start(context, service) {
  const server = createServer({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function request(base, method, path, { actor, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (actor) headers['x-actor-role'] = actor.role;
  if (actor?.id) headers['x-actor-id'] = actor.id;
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const REG = { role: 'regulator', id: 'reg-01' };
const BANK_A = { role: 'institution', id: 'bank-a' };
const BANK_B = { role: 'institution', id: 'bank-b' };

async function seed(base) {
  await request(base, 'POST', '/v1/certificates', {
    actor: REG,
    body: {
      certificateId: 'cert-1',
      warrantNumber: '林证字2026-1001',
      holderName: '青山生物科技有限公司',
      plots: [
        { plotId: 'P1', areaMu: 120, location: '东片' },
        { plotId: 'P2', areaMu: 80, location: '西片' },
        { plotId: 'P3', areaMu: 50, location: '南片' },
      ],
    },
  });
  await request(base, 'POST', '/v1/certificates/cert-1/valuations', {
    actor: REG,
    body: { certificateId: 'cert-1', totalValue: 170, plotValues: { P1: 100, P2: 50, P3: 20 } },
  });
}

test('HTTP 联调整链路：并发冻结→分期提款→提前还款→估值更正→释放→审计', async (context) => {
  const service = new FinancingService({ store: new MemoryEventStore() });
  const base = await start(context, service);
  await seed(base);

  // 无身份头：401
  const anon = await request(base, 'GET', '/v1/certificates');
  assert.equal(anon.status, 401);

  // 机构不能登记权证
  const forbidden = await request(base, 'POST', '/v1/certificates', {
    actor: BANK_A,
    body: { certificateId: 'x', warrantNumber: 'x', plots: [{ plotId: 'P1', areaMu: 1 }] },
  });
  assert.equal(forbidden.status, 403);

  // 两家银行同时锁定，P2 冲突
  const [resA, resB] = await Promise.all([
    request(base, 'POST', '/v1/credits/freeze', {
      actor: BANK_A,
      body: {
        certificateId: 'cert-1',
        creditId: 'cr-a',
        plotIds: ['P1', 'P2'],
        amount: 100,
        idempotencyKey: 'A:freeze:1',
      },
    }),
    request(base, 'POST', '/v1/credits/freeze', {
      actor: BANK_B,
      body: {
        certificateId: 'cert-1',
        creditId: 'cr-b',
        plotIds: ['P2', 'P3'],
        amount: 49,
        idempotencyKey: 'B:freeze:1',
      },
    }),
  ]);
  assert.notEqual(resA.status === 201, resB.status === 201, '恰有一家冻结成功');
  const winner = resA.status === 201 ? BANK_A : BANK_B;
  const winnerCredit = winner === BANK_A ? 'cr-a' : 'cr-b';
  const winnerPlots = winner === BANK_A ? ['P1', 'P2'] : ['P2', 'P3'];
  const winnerAmount = winner === BANK_A ? 100 : 49;
  const loserResponse = winner === BANK_A ? await resB.json() : await resA.json();
  assert.equal(loserResponse.error, 'plot_already_frozen');
  assert.equal(loserResponse.details.conflicts[0].plotId, 'P2');

  // 幂等重投：赢家冻结回执再送一次，返回首次结果
  const retry = await request(base, 'POST', '/v1/credits/freeze', {
    actor: winner,
    body: {
      certificateId: 'cert-1',
      creditId: winnerCredit,
      plotIds: winnerPlots,
      amount: winnerAmount,
      idempotencyKey: winner === BANK_A ? 'A:freeze:1' : 'B:freeze:1',
    },
  });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).idempotent, true);

  // 输家锁定剩余地块
  const freePlot = winner === BANK_A ? 'P3' : 'P1';
  const loser = winner === BANK_A ? BANK_B : BANK_A;
  const loserCredit = winner === BANK_A ? 'cr-b' : 'cr-a';
  const freeze2 = await request(base, 'POST', '/v1/credits/freeze', {
    actor: loser,
    body: { certificateId: 'cert-1', creditId: loserCredit, plotIds: [freePlot], amount: 14 },
  });
  assert.equal(freeze2.status, 201);

  // 赢家分期提款两笔（金额对两种赢家情形都在余量内）
  const d1 = await request(base, 'POST', `/v1/credits/${winnerCredit}/drawdowns`, {
    actor: winner,
    body: { drawdownId: 'd1', amount: 20 },
  });
  assert.equal(d1.status, 201);
  const d2 = await request(base, 'POST', `/v1/credits/${winnerCredit}/drawdowns`, {
    actor: winner,
    body: { drawdownId: 'd2', amount: 15 },
  });
  assert.equal(d2.status, 201);

  // 超额提款被挡
  const d3 = await request(base, 'POST', `/v1/credits/${winnerCredit}/drawdowns`, {
    actor: winner,
    body: { drawdownId: 'd3', amount: 999 },
  });
  assert.equal(d3.status, 422);
  assert.equal((await d3.json()).error, 'insufficient_remaining');

  // 提前还款
  const r1 = await request(base, 'POST', `/v1/credits/${winnerCredit}/repayments`, {
    actor: winner,
    body: { repaymentId: 'r1', amount: 25 },
  });
  assert.equal(r1.status, 201);

  // 监管插入估值更正（下调）
  const valuation = await request(base, 'POST', '/v1/certificates/cert-1/valuations', {
    actor: REG,
    body: {
      certificateId: 'cert-1',
      totalValue: 120,
      plotValues: { P1: 70, P2: 35, P3: 15 },
      note: '林木市价回调重估',
    },
  });
  assert.equal(valuation.status, 201);

  // 赢家余量按新估值重算：余额 = 35 - 25 = 10
  const creditView = await (
    await request(base, 'GET', `/v1/credits/${winnerCredit}`, { actor: winner })
  ).json();
  assert.equal(creditView.currentValuationVersion, 2);
  assert.equal(creditView.outstanding, 10);

  // 输家不能查看赢家授信；权证视图只暴露自身授信
  const peek = await request(base, 'GET', `/v1/credits/${winnerCredit}`, { actor: loser });
  assert.equal(peek.status, 403);
  const certLoserView = await (
    await request(base, 'GET', '/v1/certificates/cert-1', { actor: loser })
  ).json();
  assert.equal(certLoserView.credits.length, 1);
  assert.equal(certLoserView.credits[0].creditId, loserCredit);
  assert.ok(
    certLoserView.plots.some(
      (plot) => plot.frozen && plot.attachedCreditId === null && plot.heldBy === 'other_institution',
    ),
  );

  // 撤销赢家授信：先清偿剩余 10，请求解除期间拒绝提款，确认解除
  const repayAll = await request(base, 'POST', `/v1/credits/${winnerCredit}/repayments`, {
    actor: winner,
    body: { repaymentId: 'r2', amount: 10 },
  });
  assert.equal(repayAll.status, 201);
  const revokeReq = await request(base, 'POST', `/v1/credits/${winnerCredit}/revocation`, {
    actor: winner,
    body: {},
  });
  assert.equal(revokeReq.status, 202);
  const drawDuringRevoke = await request(base, 'POST', `/v1/credits/${winnerCredit}/drawdowns`, {
    actor: winner,
    body: { drawdownId: 'd4', amount: 1 },
  });
  assert.equal(drawDuringRevoke.status, 409);
  assert.equal((await drawDuringRevoke.json()).error, 'credit_revocation_in_progress');
  const confirm = await request(base, 'POST', `/v1/credits/${winnerCredit}/revocation/confirm`, {
    actor: winner,
    body: {},
  });
  assert.equal(confirm.status, 200);

  // 监管审计：哈希链完整、最终状态可重算
  const audit = await (await request(base, 'GET', '/v1/audit', { actor: REG })).json();
  assert.equal(audit.ok, true);
  assert.ok(audit.eventCount >= 10);
  assert.equal(audit.certificates[0].certificateId, 'cert-1');
  const winnerSummary = audit.certificates[0].credits.find((c) => c.creditId === winnerCredit);
  assert.equal(winnerSummary.status, 'revoked');
  assert.equal(winnerSummary.outstanding, 0);
});

test('健康检查仍可匿名访问', async (context) => {
  const service = new FinancingService({ store: new MemoryEventStore() });
  const base = await start(context, service);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
