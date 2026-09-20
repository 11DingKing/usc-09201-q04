import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '../src/domain/service.mjs';
import { createInitialState, fold, certificateView } from '../src/domain/projection.mjs';
import { hashOf } from '../src/domain/store.mjs';

const registrar = { role: 'registrar' };
const regulator = { role: 'regulator' };
const bankA = { role: 'institution', institutionId: 'BANK_A' };
const bankB = { role: 'institution', institutionId: 'BANK_B' };
const bankC = { role: 'institution', institutionId: 'BANK_C' };

async function setupTwoBankCertificate(service) {
  await service.registerCertificate(registrar, {
    certificateId: 'LQ-001',
    enterpriseId: 'ENT-7',
    parcelIds: ['P1', 'P2', 'P3'],
    weights: { P1: 0.5, P2: 0.3, P3: 0.2 },
    initialValue: 1000,
  });
  return 'LQ-001';
}

test('两家银行并发锁定同一地块：先提交者确定胜出，冲突留痕且可重算', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);

  // 同一事件循环内并发提交，次序必须确定
  const [a, b] = await Promise.all([
    service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 400 }),
    service.freezeFacility(bankB, cid, { facilityId: 'FB', parcelIds: ['P1', 'P2'], limit: 700 }),
  ]);

  assert.equal(a.status, 201);
  assert.equal(b.status, 409);
  assert.equal(b.body.reason, 'parcel_already_encumbered');
  assert.deepEqual(b.body.detail.parcelIds, ['P1']);
  assert.equal(b.body.detail.heldBy, 'BANK_A');

  // 乙银行改锁剩余地块成功
  const b2 = await service.freezeFacility(bankB, cid, { facilityId: 'FB', parcelIds: ['P2', 'P3'], limit: 500 });
  assert.equal(b2.status, 201);

  const view = service.viewCertificate(regulator, cid);
  assert.equal(view.availability.totalFrozenLimit, 900);
  assert.equal(view.availability.freezableLimit, 100);

  const rejectedEvents = service._store.events.filter((event) => event.type === 'command.rejected');
  assert.equal(rejectedEvents.length, 1);
  assert.equal(rejectedEvents[0].data.reason, 'parcel_already_encumbered');

  const audit = service.recompute(regulator);
  assert.equal(audit.stateMatches, true);
  assert.equal(audit.balances[cid].match, true);
});

test('分期提款、FIFO 还款与提前还款：余量实时更新，超额还款被拒', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 500 });

  const d1 = await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 200 });
  assert.equal(d1.status, 201);
  const d2 = await service.drawdown(bankA, 'FA', { drawdownId: 'D2', amount: 150 });
  assert.equal(d2.status, 201);

  let view = service.viewCertificate(regulator, cid);
  assert.equal(view.availability.totalOutstanding, 350);
  assert.equal(view.availability.freeMargin, 650);

  const over = await service.drawdown(bankA, 'FA', { drawdownId: 'D3', amount: 200 });
  assert.equal(over.status, 422);
  assert.equal(over.body.reason, 'limit_exceeded');

  // 提前还款 300：FIFO 先冲 D1 剩余 200，再冲 D2 的 100
  const repaid = await service.repay(bankA, 'FA', { amount: 300 });
  assert.equal(repaid.status, 201);
  assert.deepEqual(repaid.body.allocations, [
    { drawdownId: 'D1', amount: 200 },
    { drawdownId: 'D2', amount: 100 },
  ]);

  const facility = service.viewFacility(bankA, 'FA');
  assert.equal(facility.outstanding, 50);
  assert.equal(facility.drawdowns[0].settled, true);
  assert.equal(facility.drawdowns[1].remaining, 50);
  assert.equal(facility.availableToDraw, 450);

  // 多还被拒
  const overRepay = await service.repay(bankA, 'FA', { amount: 60 });
  assert.equal(overRepay.status, 422);
  assert.equal(overRepay.body.reason, 'repayment_exceeds_outstanding');
});

test('估值版本下调：超额新提款按新版本被挡，估值历史可审计', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 500 });
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 300 });

  // P1 占一半价值：1000 -> 550 后覆盖仅 275，低于已提 300
  const revised = await service.recordValuation(registrar, cid, { versionId: 'v2', value: 550, note: '林分更正' });
  assert.equal(revised.status, 201);

  const blocked = await service.drawdown(bankA, 'FA', { drawdownId: 'D2', amount: 10 });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.reason, 'insufficient_coverage');
  assert.equal(blocked.body.detail.valuationVersionId, 'v2');

  // 存量不被追溯抹除，但缺口在视图中暴露
  const facility = service.viewFacility(bankA, 'FA');
  assert.equal(facility.outstanding, 300);
  assert.ok(facility.coverageShortfall > 0);

  const view = service.viewCertificate(regulator, cid);
  assert.deepEqual(view.valuationHistory.map((version) => version.versionId), ['v1', 'v2']);
  assert.equal(view.availability.freezableLimit, 50); // 550 - 500 已冻结额度（不追溯削减旧冻结）

  // 同版本号不可重复入账
  const dup = await service.recordValuation(registrar, cid, { versionId: 'v2', value: 900 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.reason, 'version_exists');
});

test('撤销进行中的新提款按确定次序被拒，撤销可撤回，结清后才可解除', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 500 });
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 300 });

  const requested = await service.requestRevocation(bankA, 'FA', { revocationId: 'R1' });
  assert.equal(requested.status, 201);

  const blocked = await service.drawdown(bankA, 'FA', { drawdownId: 'D2', amount: 10 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, 'revocation_in_progress');

  // 未结清不能解除
  const stillOwed = await service.finalizeRevocation(bankA, 'FA');
  assert.equal(stillOwed.status, 422);
  assert.equal(stillOwed.body.reason, 'outstanding_balance_remains');

  // 撤回撤销后提款恢复
  const cancelled = await service.cancelRevocation(bankA, 'FA');
  assert.equal(cancelled.status, 201);
  const resumed = await service.drawdown(bankA, 'FA', { drawdownId: 'D2', amount: 10 });
  assert.equal(resumed.status, 201);

  // 再次申请、结清、解除，地块释放给权证
  await service.requestRevocation(bankA, 'FA', { revocationId: 'R2' });
  await service.repay(bankA, 'FA', { amount: 310 });
  const finalized = await service.finalizeRevocation(bankA, 'FA');
  assert.equal(finalized.status, 201);

  const view = service.viewCertificate(regulator, cid);
  assert.deepEqual(view.parcels.find((parcel) => parcel.parcelId === 'P1').status, 'free');
});

test('部分地块释放：回执乱序到达不影响最终决策，释放后额度与地块同步缩减', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1', 'P2'], limit: 800 });
  await service.freezeFacility(bankB, cid, { facilityId: 'FB', parcelIds: ['P3'], limit: 200 });
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 200 });

  // 申请释放 P2（价值 300）：剩余 P1 覆盖 500，足以覆盖 200 余额
  const requested = await service.requestRelease(bankA, 'FA', { releaseId: 'REL-1', parcelIds: ['P2'] });
  assert.equal(requested.status, 201);
  assert.deepEqual(requested.body.requiredParties.sort(), ['BANK_B', 'registrar']);

  // 回执乱序：乙银行先到，登记机构后到；未集齐前保持 pending
  const first = await service.recordReceipt(bankB, 'REL-1', { decision: 'approve' });
  assert.equal(first.status, 201);
  assert.equal(service.viewRelease(bankA, 'REL-1').status, 'pending');

  const second = await service.recordReceipt(registrar, 'REL-1', { decision: 'approve' });
  assert.equal(second.status, 201);
  assert.equal(second.events.at(-1).type, 'release.approved');

  const release = service.viewRelease(regulator, 'REL-1');
  assert.equal(release.status, 'approved');
  assert.deepEqual(release.receipts.map((receipt) => receipt.party), ['BANK_B', 'registrar']);

  const facility = service.viewFacility(bankA, 'FA');
  assert.deepEqual(facility.parcelIds, ['P1']);
  assert.equal(facility.limit, 500); // 800 - 释放覆盖价值 300

  // P2 已可被其他机构冻结
  const reuse = await service.freezeFacility(bankB, cid, { facilityId: 'FB2', parcelIds: ['P2'], limit: 300 });
  assert.equal(reuse.status, 201);
});

test('任一回执拒绝即整体拒绝；等待期间估值下调则决策时按新版本复核失败', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1', 'P2'], limit: 800 });
  await service.freezeFacility(bankB, cid, { facilityId: 'FB', parcelIds: ['P3'], limit: 200 });
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 250 });

  await service.requestRelease(bankA, 'FA', { releaseId: 'REL-X', parcelIds: ['P2'] });
  // 申请时 P1 覆盖 500 > 250；等待期间估值腰斩到 400，P1 仅剩 200
  await service.recordReceipt(bankB, 'REL-X', { decision: 'approve' });
  await service.recordValuation(registrar, cid, { versionId: 'v2', value: 400 });
  const last = await service.recordReceipt(registrar, 'REL-X', { decision: 'approve' });
  assert.equal(last.events.at(-1).type, 'release.rejected');

  const release = service.viewRelease(regulator, 'REL-X');
  assert.equal(release.status, 'rejected');
  // 被拒后地块与额度都不变
  const facility = service.viewFacility(bankA, 'FA');
  assert.deepEqual(facility.parcelIds, ['P1', 'P2']);
  assert.equal(facility.limit, 800);
});

test('权限隔离：机构只能看到自身授信，他方操作被拒绝；监管看全量', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 500 });

  const viewB = service.viewCertificate(bankB, cid);
  assert.equal(viewB.facilities.length, 0); // 看不到甲银行明细
  assert.equal(viewB.parcels.find((parcel) => parcel.parcelId === 'P1').status, 'encumbered');
  assert.equal(viewB.parcels.find((parcel) => parcel.parcelId === 'P1').facilityId, undefined);

  const viewA = service.viewCertificate(bankA, cid);
  assert.equal(viewA.facilities[0].facilityId, 'FA');
  assert.equal(viewA.parcels.find((parcel) => parcel.parcelId === 'P1').status, 'locked');
  assert.equal(viewA.valuationHistory, undefined); // 估值历史仅监管可见

  assert.throws(() => service.viewFacility(bankB, 'FA'), /forbidden/);
  await assert.rejects(
    () => service.drawdown(bankB, 'FA', { drawdownId: 'DX', amount: 1 }),
    /forbidden/,
  );

  assert.throws(() => service.auditEvents(bankA), /forbidden/);
  assert.throws(() => service.recompute(bankA), /forbidden/);

  const listB = service.listFacilities(bankB);
  assert.equal(listB.length, 0);
  assert.equal(service.listFacilities(regulator).length, 1);
});

test('幂等键：同一请求重放返回首次结果，不产生第二笔占用', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  const first = await service.freezeFacility(
    bankA,
    cid,
    { facilityId: 'FA', parcelIds: ['P1'], limit: 400 },
    'idem-freeze-1',
  );
  const replay = await service.freezeFacility(
    bankA,
    cid,
    { facilityId: 'FA', parcelIds: ['P1'], limit: 400 },
    'idem-freeze-1',
  );
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.replayed, true);

  const view = service.viewCertificate(regulator, cid);
  assert.equal(view.facilities.length, 1);
});

test('哈希链：逐事件可校验，篡改任意事件导致链断裂', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  await service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1'], limit: 400 });
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 100 });

  const verify = (events) => {
    let previous = '0'.repeat(64);
    for (const event of events) {
      if (hashOf(previous, event) !== event.hash) return false;
      previous = event.hash;
    }
    return true;
  };

  const events = service.auditEvents(regulator);
  assert.equal(verify(events), true);

  const tampered = events.map((event) => ({ ...event }));
  tampered[2].data = { ...tampered[2].data, limit: 9999 };
  assert.equal(verify(tampered), false);
});

test('重放确定次序：同一日志从空状态重放与活动投影逐字段一致', async () => {
  const service = createService();
  const cid = await setupTwoBankCertificate(service);
  // 并发、撤销、还款、回执全部交织一遍
  await Promise.all([
    service.freezeFacility(bankA, cid, { facilityId: 'FA', parcelIds: ['P1', 'P2'], limit: 600 }),
    service.freezeFacility(bankB, cid, { facilityId: 'FB', parcelIds: ['P1'], limit: 400 }),
  ]);
  await service.drawdown(bankA, 'FA', { drawdownId: 'D1', amount: 300 });
  await service.requestRevocation(bankA, 'FA', { revocationId: 'R1' });
  await service.cancelRevocation(bankA, 'FA');
  await service.repay(bankA, 'FA', { amount: 100 });
  await service.recordValuation(registrar, cid, { versionId: 'v2', value: 900 });

  const replayed = createInitialState();
  for (const event of service._store.events) fold(replayed, event);

  const liveView = certificateView(service._store.state, cid, regulator);
  const replayView = certificateView(replayed, cid, regulator);
  assert.deepEqual(replayView.availability, liveView.availability);
  assert.deepEqual(
    replayView.facilities.map((facility) => [facility.facilityId, facility.status, facility.outstanding]),
    liveView.facilities.map((facility) => [facility.facilityId, facility.status, facility.outstanding]),
  );

  const audit = service.recompute(regulator);
  assert.equal(audit.stateMatches, true);
  assert.equal(audit.balances[cid].match, true);
});
