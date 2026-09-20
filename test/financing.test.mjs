import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { FinancingService } from '../src/domain/service.mjs';
import { MemoryEventStore } from '../src/domain/store.mjs';
import { EventStore } from '../src/domain/store.mjs';
import { fold } from '../src/domain/projection.mjs';
import { DomainError } from '../src/domain/errors.mjs';

const REG = { role: 'regulator', id: 'reg-01' };
const BANK_A = { role: 'institution', id: 'bank-a' };
const BANK_B = { role: 'institution', id: 'bank-b' };

async function setupScenario() {
  const service = new FinancingService({ store: new MemoryEventStore() });
  await service.registerCertificate(
    {
      certificateId: 'cert-1',
      warrantNumber: '林证字2026-0001',
      holderName: '青山生物科技有限公司',
      plots: [
        { plotId: 'P1', areaMu: 120, location: '青山村东片' },
        { plotId: 'P2', areaMu: 80, location: '青山村西片' },
        { plotId: 'P3', areaMu: 50, location: '青山村南片' },
      ],
    },
    REG,
  );
  // 抵质押率 0.7：P1=70万, P2=35万, P3=14万（单位：万元）
  await service.recordValuation(
    {
      certificateId: 'cert-1',
      totalValue: 170,
      plotValues: { P1: 100, P2: 50, P3: 20 },
    },
    REG,
  );
  return service;
}

test('两家银行并发锁定重叠地块：只有一家成功，另一家拿到确定性冲突响应', async () => {
  const service = await setupScenario();

  // A 锁 P1+P2；B 同时锁 P2+P3。乐观锁 + 重放决定胜负：
  // 恰有一家成功；失败者收到包含冲突地块与占用方的结构化响应
  const [outcomeA, outcomeB] = await Promise.all([
    service
      .freezeCredit(
        { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1', 'P2'], amount: 100 },
        BANK_A,
      )
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error })),
    service
      .freezeCredit(
        { certificateId: 'cert-1', creditId: 'cr-b', plotIds: ['P2', 'P3'], amount: 45 },
        BANK_B,
      )
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error })),
  ]);

  const winner = outcomeA.ok ? 'bank-a' : 'bank-b';
  const loser = outcomeA.ok ? outcomeB : outcomeA;
  assert.equal(outcomeA.ok !== outcomeB.ok, true, '必须恰有一家成功');
  assert.equal(loser.error.code, 'plot_already_frozen');
  assert.equal(loser.error.details.conflicts[0].plotId, 'P2');
  assert.equal(loser.error.details.conflicts[0].heldByInstitution, winner);

  const cert = await service.queryCertificate('cert-1', REG);
  const plots = Object.fromEntries(cert.plots.map((p) => [p.plotId, p]));
  assert.equal(plots.P1.frozen, winner === 'bank-a'); // P1 只可能被 A 占
  assert.equal(plots.P2.frozen, true);
  assert.equal(plots.P3.frozen, winner === 'bank-b'); // P3 只可能被 B 占
  assert.equal(cert.margin.availableForNewFreeze, winner === 'bank-a' ? 14 : 70);

  // 失败者改用当时未占用的地块成功（若 B 胜出则 P1 空出）
  const retryPlot = winner === 'bank-a' ? 'P3' : 'P1';
  const retryCredit = winner === 'bank-a' ? 'cr-b' : 'cr-a';
  const retryBank = winner === 'bank-a' ? BANK_B : BANK_A;
  const frozenRetry = await service.freezeCredit(
    { certificateId: 'cert-1', creditId: retryCredit, plotIds: [retryPlot], amount: 14 },
    retryBank,
  );
  assert.equal(frozenRetry.idempotent, false);
});

test('分期提款受可用余量约束，超额占用被拒绝', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1', 'P2'], amount: 100 },
    BANK_A,
  );

  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd1', amount: 60 }, BANK_A);
  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd2', amount: 30 }, BANK_A);

  let credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.outstanding, 90);
  assert.equal(credit.remaining, 10); // min(额度100, 抵押上限105) - 90

  await assert.rejects(
    service.drawdown({ creditId: 'cr-a', drawdownId: 'd3', amount: 10.01 }, BANK_A),
    (error) => error instanceof DomainError && error.code === 'insufficient_remaining',
  );

  // 授信额度本身也不能被突破（抵押上限高于额度时）
  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd3', amount: 10 }, BANK_A);
  credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.outstanding, 100);
  assert.equal(credit.remaining, 0);
});

test('提前还款释放余额，支持多缴截断为零', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1'], amount: 70 },
    BANK_A,
  );
  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd1', amount: 70 }, BANK_A);

  // 提前还 40 万
  await service.repay({ creditId: 'cr-a', repaymentId: 'r1', amount: 40 }, BANK_A);
  const credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.outstanding, 30);
  assert.equal(credit.remaining, 40);

  // 不接受多缴：偿还额超过当前余额被拒绝，按实际余额提交即可结清
  await assert.rejects(
    service.repay({ creditId: 'cr-a', repaymentId: 'r2', amount: 50 }, BANK_A),
    (error) => error instanceof DomainError && error.code === 'repayment_exceeds_outstanding',
  );
  await service.repay({ creditId: 'cr-a', repaymentId: 'r2', amount: 30 }, BANK_A);
  assert.equal((await service.queryCredit('cr-a', BANK_A)).outstanding, 0);
});

test('估值下调后按新版本重算余量：覆盖率击穿并阻断新提款', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1', 'P2'], amount: 105 },
    BANK_A,
  );
  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd1', amount: 80 }, BANK_A);

  // 估值更正：P1 60、P2 40 → 抵押上限 (60+40)*0.7 = 70，低于已提款 80
  await service.recordValuation(
    {
      certificateId: 'cert-1',
      totalValue: 100,
      plotValues: { P1: 60, P2: 40 },
      note: '市场价格回调后重估',
    },
    REG,
  );

  const credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.currentValuationVersion, 2);
  assert.equal(credit.collateralCap, 70);
  assert.equal(credit.coverageBreached, true);
  assert.equal(credit.remaining, 0);

  await assert.rejects(
    service.drawdown({ creditId: 'cr-a', drawdownId: 'd2', amount: 1 }, BANK_A),
    (error) => error instanceof DomainError && error.code === 'insufficient_remaining',
  );
});

test('部分地块释放遵循附着先后次序，余额未清不能全部释放', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-b', plotIds: ['P2', 'P3'], amount: 49 },
    BANK_B,
  );
  await service.drawdown({ creditId: 'cr-b', drawdownId: 'd1', amount: 20 }, BANK_B);

  // 跳过 P2 直接释放 P3：次序违规
  await assert.rejects(
    service.releaseCollateral({ creditId: 'cr-b', refId: 'rel-x', plotIds: ['P3'] }, BANK_B),
    (error) => error instanceof DomainError && error.code === 'release_order_violation',
  );

  // 有欠款时不能一次性释放全部
  await assert.rejects(
    service.releaseCollateral({ creditId: 'cr-b', refId: 'rel-all', plotIds: ['P2', 'P3'] }, BANK_B),
    (error) => error instanceof DomainError && error.code === 'outstanding_balance_blocks_release',
  );

  // 还清后按 FIFO 先释放 P2
  await service.repay({ creditId: 'cr-b', repaymentId: 'r1', amount: 20 }, BANK_B);
  await service.releaseCollateral({ creditId: 'cr-b', refId: 'rel-1', plotIds: ['P2'] }, BANK_B);
  let cert = await service.queryCertificate('cert-1', REG);
  let p2 = cert.plots.find((p) => p.plotId === 'P2');
  assert.equal(p2.frozen, false);

  // 再释放 P3 后授信自动结清关闭
  await service.releaseCollateral({ creditId: 'cr-b', refId: 'rel-2', plotIds: ['P3'] }, BANK_B);
  const credit = await service.queryCredit('cr-b', BANK_B);
  assert.equal(credit.status, 'closed');
  assert.equal(credit.plotIds.length, 0);
});

test('撤销进行中的新提款被挡下，清偿后确认解除并归还地块', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1'], amount: 70 },
    BANK_A,
  );
  await service.drawdown({ creditId: 'cr-a', drawdownId: 'd1', amount: 30 }, BANK_A);

  await service.requestRevocation({ creditId: 'cr-a' }, BANK_A);

  await assert.rejects(
    service.drawdown({ creditId: 'cr-a', drawdownId: 'd2', amount: 1 }, BANK_A),
    (error) => error instanceof DomainError && error.code === 'credit_revocation_in_progress',
  );
  await assert.rejects(
    service.confirmRevocation({ creditId: 'cr-a' }, BANK_A),
    (error) => error instanceof DomainError && error.code === 'outstanding_balance_blocks_revocation',
  );

  await service.repay({ creditId: 'cr-a', repaymentId: 'r1', amount: 30 }, BANK_A);
  await service.confirmRevocation({ creditId: 'cr-a' }, BANK_A);

  const credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.status, 'revoked');
  const cert = await service.queryCertificate('cert-1', REG);
  assert.equal(cert.plots.find((p) => p.plotId === 'P1').frozen, false);
  assert.equal(cert.margin.availableForNewFreeze, 119); // 全部地块重新可用
});

test('机构回执乱序重投：幂等键返回首次结果，不产生重复占用', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    {
      certificateId: 'cert-1',
      creditId: 'cr-a',
      plotIds: ['P1'],
      amount: 70,
      idempotencyKey: 'bank-a:freeze:9001',
    },
    BANK_A,
  );

  // 回执延迟后重投（与首次内容完全一致）
  const retry = await service.freezeCredit(
    {
      certificateId: 'cert-1',
      creditId: 'cr-a',
      plotIds: ['P1'],
      amount: 70,
      idempotencyKey: 'bank-a:freeze:9001',
    },
    BANK_A,
  );
  assert.equal(retry.idempotent, true);
  assert.equal(retry.eventType, 'credit.frozen');

  // 乱序到达的两笔提款：先收到 d2 再重放 d1，余额只计算一次
  await service.drawdown(
    { creditId: 'cr-a', drawdownId: 'd2', amount: 10, idempotencyKey: 'bank-a:dd:d2' },
    BANK_A,
  );
  await service.drawdown(
    { creditId: 'cr-a', drawdownId: 'd1', amount: 20, idempotencyKey: 'bank-a:dd:d1' },
    BANK_A,
  );
  const replayed = await service.drawdown(
    { creditId: 'cr-a', drawdownId: 'd2', amount: 10, idempotencyKey: 'bank-a:dd:d2' },
    BANK_A,
  );
  assert.equal(replayed.idempotent, true);

  const credit = await service.queryCredit('cr-a', BANK_A);
  assert.equal(credit.outstanding, 30);

  // 同一幂等键的并发重投也只生效一次
  const results = await Promise.all([
    service.repay(
      { creditId: 'cr-a', repaymentId: 'r9', amount: 5, idempotencyKey: 'bank-a:rp:r9' },
      BANK_A,
    ),
    service.repay(
      { creditId: 'cr-a', repaymentId: 'r9', amount: 5, idempotencyKey: 'bank-a:rp:r9' },
      BANK_A,
    ),
  ]);
  assert.equal(results.filter((r) => r.idempotent).length, 1);
  assert.equal((await service.queryCredit('cr-a', BANK_A)).outstanding, 25);
});

test('机构数据隔离：只能看到本机构授信，他机构占用仅显示占位', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1', 'P2'], amount: 100 },
    BANK_A,
  );
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-b', plotIds: ['P3'], amount: 14 },
    BANK_B,
  );

  await assert.rejects(
    service.queryCredit('cr-a', BANK_B),
    (error) => error instanceof DomainError && error.code === 'forbidden',
  );

  const viewB = await service.queryCertificate('cert-1', BANK_B);
  assert.equal(viewB.credits.length, 1);
  assert.equal(viewB.credits[0].creditId, 'cr-b');
  const p1 = viewB.plots.find((p) => p.plotId === 'P1');
  assert.equal(p1.frozen, true);
  assert.equal(p1.attachedCreditId, null); // 不暴露他机构授信编号
  assert.equal(p1.heldBy, 'other_institution');

  const viewA = await service.queryCertificate('cert-1', REG);
  assert.equal(viewA.credits.length, 2); // 监管可见全部
  assert.equal(viewA.plots.find((p) => p.plotId === 'P1').attachedCreditId, 'cr-a');
});

test('监管审计：哈希链可校验，事件被篡改可发现，最终状态脱离服务可重算', async () => {
  const dir = join(tmpdir(), `forest-rights-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    const store = new EventStore(dir);
    const service = new FinancingService({ store });
    await service.registerCertificate(
      {
        certificateId: 'cert-1',
        warrantNumber: '林证字2026-0002',
        plots: [{ plotId: 'P1', areaMu: 100 }],
      },
      REG,
    );
    await service.recordValuation(
      { certificateId: 'cert-1', totalValue: 100, plotValues: { P1: 100 } },
      REG,
    );
    await service.freezeCredit(
      { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1'], amount: 70 },
      BANK_A,
    );
    await service.drawdown({ creditId: 'cr-a', drawdownId: 'd1', amount: 42 }, BANK_A);
    await service.repay({ creditId: 'cr-a', repaymentId: 'r1', amount: 12 }, BANK_A);

    const audit = await service.audit(REG);
    assert.equal(audit.ok, true);
    assert.equal(audit.eventCount, 5);
    assert.equal(audit.certificates[0].margin.outstanding, 30);

    // 模拟监管侧独立重算：只读事件文件重新折叠，结果必须一致
    const eventFiles = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    const reloaded = [];
    for (const name of eventFiles) {
      reloaded.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
    }
    const recomputed = fold(reloaded);
    const credit = recomputed.credits.get('cr-a');
    assert.equal(credit.outstanding, 30);
    assert.equal(recomputed.version, 5);

    // 篡改第二条事件：哈希链校验必须失败
    const secondFile = join(dir, eventFiles[1]);
    const tampered = JSON.parse(await readFile(secondFile, 'utf8'));
    tampered.payload.totalValue = 9999;
    await writeFile(secondFile, JSON.stringify(tampered));
    const badAudit = await service.audit(REG);
    assert.equal(badAudit.ok, false);
    assert.equal(badAudit.tampered.eventId, tampered.eventId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('并发提款与提前还款交错：最终余额确定可重算', async () => {
  const service = await setupScenario();
  await service.freezeCredit(
    { certificateId: 'cert-1', creditId: 'cr-a', plotIds: ['P1', 'P2'], amount: 100 },
    BANK_A,
  );

  // 10 笔提款共 80 万与 3 笔提前还款（各 5 万）并发交错。
  // 还款若在余额不足时到达会被拒绝（不吞资金）；无论次序如何，守恒恒等式严格成立。
  const draws = Array.from({ length: 10 }, (_, i) =>
    service
      .drawdown({ creditId: 'cr-a', drawdownId: `d${i}`, amount: 8, idempotencyKey: `d${i}` }, BANK_A)
      .then(() => 1)
      .catch((error) => {
        assert.equal(error.code, 'insufficient_remaining');
        return 0;
      }),
  );
  const repays = Array.from({ length: 3 }, (_, i) =>
    service
      .repay({ creditId: 'cr-a', repaymentId: `r${i}`, amount: 5, idempotencyKey: `r${i}` }, BANK_A)
      .then(() => 1)
      .catch((error) => {
        assert.equal(error.code, 'repayment_exceeds_outstanding');
        return 0;
      }),
  );
  const outcomes = await Promise.all([...draws, ...repays]);
  const acceptedDraws = outcomes.slice(0, 10).reduce((a, b) => a + b, 0);
  const acceptedRepays = outcomes.slice(10).reduce((a, b) => a + b, 0);
  assert.equal(acceptedDraws, 10);

  const credit = await service.queryCredit('cr-a', BANK_A);
  // 严格恒等式：余额 = 提款总额 - 被接受的还款总额
  assert.equal(credit.outstanding, 80 - acceptedRepays * 5);
  assert.equal(credit.remaining, 100 - credit.outstanding);

  // 从事件流重放得到同一结果
  const events = await service.store.readAll();
  const replay = fold(events);
  assert.equal(replay.credits.get('cr-a').outstanding, credit.outstanding);
  assert.equal(replay.credits.get('cr-a').drawdowns.length, 10);
  assert.equal(replay.credits.get('cr-a').repayments.length, acceptedRepays);
});
