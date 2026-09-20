import { EventStore, stableStringify } from './store.mjs';
import {
  allocateRepayment,
  certificateView,
  createInitialState,
  facilityCoverage,
  fold,
  parcelShareValue,
  round2,
} from './projection.mjs';

const EPS = 0.005;

export class ValidationError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

const positiveNumber = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError('invalid_field', { field });
  }
};

const nonEmptyStringArray = (value, field) => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) {
    throw new ValidationError('invalid_field', { field });
  }
  if (new Set(value).size !== value.length) throw new ValidationError('duplicate_entry', { field });
};

export function createService() {
  const store = new EventStore();
  const state = createInitialState();
  store.state = state;
  store.apply = (event) => fold(state, event);

  const requireRole = (principal, ...roles) => {
    if (!roles.includes(principal.role)) {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403, reason: 'forbidden' });
    }
  };

  const getCertificate = (certificateId) => state.certificates.get(certificateId);
  const mustCertificate = (certificateId) => {
    const certificate = getCertificate(certificateId);
    if (!certificate) throw Object.assign(new Error('not_found'), { httpStatus: 404, reason: 'certificate_not_found' });
    return certificate;
  };
  const mustFacility = (facilityId) => {
    const facility = state.facilities.get(facilityId);
    if (!facility) throw Object.assign(new Error('not_found'), { httpStatus: 404, reason: 'facility_not_found' });
    return facility;
  };
  const ownFacility = (principal, facility) => {
    if (principal.role !== 'institution' || facility.institutionId !== principal.institutionId) {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403, reason: 'not_facility_holder' });
    }
  };

  /* --------------------------- 登记与估值 --------------------------- */

  const registerCertificate = async (principal, body, idempotencyKey) => {
    requireRole(principal, 'registrar');
    const certificateId = body.certificateId;
    if (typeof certificateId !== 'string' || !certificateId) throw new ValidationError('invalid_field', { field: 'certificateId' });
    if (typeof body.enterpriseId !== 'string' || !body.enterpriseId) throw new ValidationError('invalid_field', { field: 'enterpriseId' });
    nonEmptyStringArray(body.parcelIds, 'parcelIds');
    positiveNumber(body.initialValue, 'initialValue');
    const weights = {};
    for (const parcelId of body.parcelIds) weights[parcelId] = Number(body.weights?.[parcelId] ?? 1);
    if (Object.values(weights).some((weight) => !(weight > 0))) throw new ValidationError('invalid_field', { field: 'weights' });

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      if (state.certificates.has(certificateId)) {
        reject(certificateId, 'register_certificate', 'certificate_exists', { certificateId }, 409);
        return;
      }
      const data = {
        enterpriseId: body.enterpriseId,
        parcelIds: body.parcelIds,
        weights,
        initialValue: body.initialValue,
        versionId: body.versionId ?? 'v1',
        note: body.note ?? '登记初值',
      };
      accept('certificate.registered', certificateId, data, { certificateId });
    });
  };

  const recordValuation = async (principal, certificateId, body, idempotencyKey) => {
    requireRole(principal, 'registrar');
    positiveNumber(body.value, 'value');
    if (typeof body.versionId !== 'string' || !body.versionId) throw new ValidationError('invalid_field', { field: 'versionId' });
    mustCertificate(certificateId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const certificate = state.certificates.get(certificateId);
      if (certificate.versions.some((version) => version.versionId === body.versionId)) {
        reject(certificateId, 'record_valuation', 'version_exists', { versionId: body.versionId }, 409);
        return;
      }
      const data = { versionId: body.versionId, value: body.value, note: body.note ?? '' };
      accept('valuation.recorded', certificateId, data);
    });
  };

  /* ----------------------------- 授信冻结 ----------------------------- */

  const freezeFacility = async (principal, certificateId, body, idempotencyKey) => {
    requireRole(principal, 'institution');
    const facilityId = body.facilityId;
    if (typeof facilityId !== 'string' || !facilityId) throw new ValidationError('invalid_field', { field: 'facilityId' });
    nonEmptyStringArray(body.parcelIds, 'parcelIds');
    positiveNumber(body.limit, 'limit');
    mustCertificate(certificateId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const certificate = state.certificates.get(certificateId);
      if (state.facilities.has(facilityId)) {
        reject(certificateId, 'freeze_facility', 'facility_exists', { facilityId }, 409);
        return;
      }
      const active = certificate.facilities
        .map((fid) => state.facilities.get(fid))
        .filter((facility) => facility.status !== 'revoked');

      const unknown = body.parcelIds.find((parcelId) => !certificate.parcelIds.includes(parcelId));
      if (unknown) {
        reject(certificateId, 'freeze_facility', 'parcel_not_on_certificate', { parcelId: unknown }, 422);
        return;
      }
      const holder = active.find((facility) => body.parcelIds.some((parcelId) => facility.parcelIds.includes(parcelId)));
      if (holder) {
        // 并发冻结的确定性冲突：先提交者得地，后者留痕失败
        reject(certificateId, 'freeze_facility', 'parcel_already_encumbered', {
          parcelIds: body.parcelIds.filter((parcelId) => holder.parcelIds.includes(parcelId)),
          heldBy: holder.institutionId,
          holderFacilityId: holder.facilityId,
        }, 409);
        return;
      }
      const coverage = body.parcelIds.reduce((sum, parcelId) => sum + parcelShareValue(certificate, parcelId), 0);
      if (body.limit > coverage + EPS) {
        reject(certificateId, 'freeze_facility', 'limit_exceeds_parcel_value', {
          limit: round2(body.limit),
          parcelCoverage: round2(coverage),
        }, 422);
        return;
      }
      const totalFrozen = active.reduce((sum, facility) => sum + facility.limit, 0);
      if (totalFrozen + body.limit > certificate.currentValue + EPS) {
        reject(certificateId, 'freeze_facility', 'certificate_value_overoccupied', {
          certificateValue: certificate.currentValue,
          alreadyFrozen: round2(totalFrozen),
          requested: round2(body.limit),
        }, 422);
        return;
      }
      const data = {
        facilityId,
        institutionId: principal.institutionId,
        parcelIds: body.parcelIds,
        limit: body.limit,
      };
      accept('facility.frozen', certificateId, data, { facilityId });
    });
  };

  /* ------------------------------ 提款 ------------------------------ */

  const drawdown = async (principal, facilityId, body, idempotencyKey) => {
    requireRole(principal, 'institution');
    const drawdownId = body.drawdownId;
    if (typeof drawdownId !== 'string' || !drawdownId) throw new ValidationError('invalid_field', { field: 'drawdownId' });
    positiveNumber(body.amount, 'amount');
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      const certificate = state.certificates.get(certificateId);
      if (current.status === 'revoked') {
        reject(certificateId, 'drawdown', 'facility_revoked', { facilityId }, 409);
        return;
      }
      // 撤销进行中：新提款一律拒绝，次序由事件日志固定
      if (current.status === 'revocation_pending') {
        reject(certificateId, 'drawdown', 'revocation_in_progress', {
          facilityId,
          revocationId: current.revocation.revocationId,
        }, 409);
        return;
      }
      if (current.drawdowns.some((item) => item.drawdownId === drawdownId)) {
        reject(certificateId, 'drawdown', 'drawdown_exists', { drawdownId }, 409);
        return;
      }
      if (current.outstanding + body.amount > current.limit + EPS) {
        reject(certificateId, 'drawdown', 'limit_exceeded', {
          facilityId,
          limit: current.limit,
          outstanding: round2(current.outstanding),
          requested: round2(body.amount),
        }, 422);
        return;
      }
      // 以当前估值版本重算覆盖价值：估值下调后超额提款被挡下
      const coverage = facilityCoverage(state, certificate, current);
      if (current.outstanding + body.amount > coverage + EPS) {
        reject(certificateId, 'drawdown', 'insufficient_coverage', {
          facilityId,
          valuationVersionId: certificate.currentVersionId,
          parcelCoverage: round2(coverage),
          outstanding: round2(current.outstanding),
          requested: round2(body.amount),
        }, 422);
        return;
      }
      accept('drawdown.made', certificateId, { facilityId, drawdownId, amount: body.amount }, { facilityId, drawdownId });
    });
  };

  /* ------------------------------ 还款 ------------------------------ */

  const repay = async (principal, facilityId, body, idempotencyKey) => {
    requireRole(principal, 'institution');
    positiveNumber(body.amount, 'amount');
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      if (current.outstanding <= EPS) {
        reject(certificateId, 'repay', 'no_outstanding_balance', { facilityId }, 422);
        return;
      }
      if (body.amount > current.outstanding + EPS) {
        reject(certificateId, 'repay', 'repayment_exceeds_outstanding', {
          facilityId,
          outstanding: round2(current.outstanding),
          requested: round2(body.amount),
        }, 422);
        return;
      }
      // FIFO：按提款落账次序冲抵，提前还款同样适用；分配方案随事件固化
      const { allocations } = allocateRepayment(current, body.amount);
      accept(
        'repayment.recorded',
        certificateId,
        { facilityId, repaymentId: body.repaymentId ?? null, amount: body.amount, allocations },
        { facilityId, allocations },
      );
    });
  };

  /* ------------------------------ 撤销 ------------------------------ */

  const requestRevocation = async (principal, facilityId, body, idempotencyKey) => {
    requireRole(principal, 'institution');
    const revocationId = body.revocationId;
    if (typeof revocationId !== 'string' || !revocationId) throw new ValidationError('invalid_field', { field: 'revocationId' });
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      if (current.status === 'revoked') {
        reject(certificateId, 'request_revocation', 'facility_revoked', { facilityId }, 409);
        return;
      }
      if (current.status === 'revocation_pending') {
        reject(certificateId, 'request_revocation', 'revocation_already_pending', {
          revocationId: current.revocation.revocationId,
        }, 409);
        return;
      }
      accept('revocation.requested', certificateId, { facilityId, revocationId }, { facilityId, revocationId });
    });
  };

  const cancelRevocation = async (principal, facilityId, idempotencyKey) => {
    requireRole(principal, 'institution');
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      if (current.status !== 'revocation_pending') {
        reject(certificateId, 'cancel_revocation', 'no_pending_revocation', { facilityId, status: current.status }, 409);
        return;
      }
      accept('revocation.cancelled', certificateId, {
        facilityId,
        revocationId: current.revocation.revocationId,
      });
    });
  };

  const finalizeRevocation = async (principal, facilityId, idempotencyKey) => {
    requireRole(principal, 'institution');
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      if (current.status === 'revoked') {
        reject(certificateId, 'finalize_revocation', 'facility_revoked', { facilityId }, 409);
        return;
      }
      if (current.status !== 'revocation_pending') {
        reject(certificateId, 'finalize_revocation', 'revocation_not_requested', { facilityId }, 409);
        return;
      }
      if (current.outstanding > EPS) {
        reject(certificateId, 'finalize_revocation', 'outstanding_balance_remains', {
          facilityId,
          outstanding: round2(current.outstanding),
        }, 422);
        return;
      }
      accept('facility.revoked', certificateId, {
        facilityId,
        revocationId: current.revocation.revocationId,
        parcelIds: [...current.parcelIds],
      });
    });
  };

  /* --------------------------- 部分地块释放 --------------------------- */

  const requestRelease = async (principal, facilityId, body, idempotencyKey) => {
    requireRole(principal, 'institution');
    const releaseId = body.releaseId;
    if (typeof releaseId !== 'string' || !releaseId) throw new ValidationError('invalid_field', { field: 'releaseId' });
    nonEmptyStringArray(body.parcelIds, 'parcelIds');
    const facility = mustFacility(facilityId);
    ownFacility(principal, facility);
    const certificateId = state.facilityCertificate.get(facilityId);

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.facilities.get(facilityId);
      const certificate = state.certificates.get(certificateId);
      if (current.status !== 'active') {
        reject(certificateId, 'request_release', 'facility_not_active', { facilityId, status: current.status }, 409);
        return;
      }
      const notHeld = body.parcelIds.filter((parcelId) => !current.parcelIds.includes(parcelId));
      if (notHeld.length > 0) {
        reject(certificateId, 'request_release', 'parcel_not_held', { parcelIds: notHeld }, 422);
        return;
      }
      const pending = [...state.releases.values()].find(
        (release) => release.facilityId === facilityId && release.status === 'pending',
      );
      if (pending) {
        reject(certificateId, 'request_release', 'release_already_pending', { releaseId: pending.releaseId }, 409);
        return;
      }
      // 申请时即按当前估值校验剩余覆盖，决策时再复核一次（中间可能插入估值更正）
      const releasedCoverage = body.parcelIds.reduce((sum, parcelId) => sum + parcelShareValue(certificate, parcelId), 0);
      const remainingCoverage = facilityCoverage(state, certificate, current) - releasedCoverage;
      if (remainingCoverage + EPS < current.outstanding) {
        reject(certificateId, 'request_release', 'release_undercollateralized', {
          outstanding: round2(current.outstanding),
          remainingCoverage: round2(remainingCoverage),
        }, 422);
        return;
      }
      // 需要回执的确定集合：登记机构 + 该权证上其他持有授信的机构（按机构去重）
      const otherInstitutions = new Set(
        certificate.facilities
          .map((fid) => state.facilities.get(fid))
          .filter((other) => other.status !== 'revoked' && other.facilityId !== facilityId)
          .map((other) => other.institutionId),
      );
      const requiredParties = ['registrar', ...[...otherInstitutions].sort()];
      accept('release.requested', certificateId, {
        facilityId,
        releaseId,
        parcelIds: body.parcelIds,
        requiredParties,
      }, { releaseId, requiredParties, status: 'pending' });
    });
  };

  const recordReceipt = async (principal, releaseId, body, idempotencyKey) => {
    if (!['approve', 'reject'].includes(body.decision)) throw new ValidationError('invalid_field', { field: 'decision' });
    const release = state.releases.get(releaseId);
    if (!release) throw Object.assign(new Error('not_found'), { httpStatus: 404, reason: 'release_not_found' });
    const party = principal.role === 'registrar' ? 'registrar' : principal.institutionId;
    if (principal.role !== 'registrar' && principal.role !== 'institution') {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403, reason: 'forbidden' });
    }
    const certificateId = release.certificateId;

    return store.command(certificateId, principal, idempotencyKey, ({ accept, reject }) => {
      const current = state.releases.get(releaseId);
      if (current.status !== 'pending') {
        reject(certificateId, 'record_receipt', 'release_not_pending', { releaseId, status: current.status }, 409);
        return;
      }
      if (!current.requiredParties.includes(party)) {
        reject(certificateId, 'record_receipt', 'not_required_party', { releaseId, party }, 403);
        return;
      }
      if (current.receipts.some((receipt) => receipt.party === party)) {
        // 回执不可更改，重复回执按冲突留痕
        reject(certificateId, 'record_receipt', 'receipt_already_recorded', { releaseId, party }, 409);
        return;
      }
      // 先落回执本身：乱序到达也按到达次序入日志
      const handle = accept('receipt.recorded', certificateId, {
        releaseId,
        party,
        receiptId: body.receiptId ?? `receipt-${releaseId}-${party}`,
        decision: body.decision,
        reason: body.reason ?? null,
      });
      decideRelease(current, handle, [
        ...current.receipts,
        { party, decision: body.decision, reason: body.reason ?? null },
      ]);
    });
  };

  /**
   * 回执集齐后的决策与回执同锁原子入日志；规则只看“集合”，与到达次序无关。
   * prospectiveReceipts 含本次尚未落账的回执，覆盖价值按当前投影复核。
   */
  function decideRelease(release, handle, prospectiveReceipts) {
    const replied = new Set(prospectiveReceipts.map((receipt) => receipt.party));
    if (!release.requiredParties.every((party) => replied.has(party))) return;

    const rejecting = prospectiveReceipts.filter((receipt) => receipt.decision === 'reject');
    if (rejecting.length > 0) {
      handle.andEmit('release.rejected', {
        releaseId: release.releaseId,
        rejectedBy: rejecting.map((receipt) => ({ party: receipt.party, reason: receipt.reason })),
      });
      return;
    }
    const facility = state.facilities.get(release.facilityId);
    const certificate = state.certificates.get(release.certificateId);
    const releasedCoverage = release.parcelIds.reduce((sum, parcelId) => sum + parcelShareValue(certificate, parcelId), 0);
    const remainingCoverage = facilityCoverage(state, certificate, facility) - releasedCoverage;
    if (remainingCoverage + EPS < facility.outstanding) {
      // 等待回执期间插入了估值下调：按当前版本复核失败
      handle.andEmit('release.rejected', {
        releaseId: release.releaseId,
        rejectedBy: [],
        reason: 'coverage_shortfall_after_revision',
        outstanding: round2(facility.outstanding),
        remainingCoverage: round2(remainingCoverage),
        valuationVersionId: certificate.currentVersionId,
      });
      return;
    }
    const limitReducedTo = round2(Math.max(0, Math.min(facility.limit - releasedCoverage, remainingCoverage)));
    handle.andEmit('release.approved', {
      releaseId: release.releaseId,
      parcelIds: release.parcelIds,
      releasedCoverage: round2(releasedCoverage),
      limitReducedTo,
      valuationVersionId: certificate.currentVersionId,
    });
  }

  /* ------------------------------ 查询 ------------------------------ */

  const viewCertificate = (principal, certificateId) => {
    const certificate = mustCertificate(certificateId);
    return certificateView(state, certificate.certificateId, principal);
  };

  const listFacilities = (principal) => {
    const all = [...state.facilities.values()];
    const visible = principal.role === 'regulator'
      ? all
      : all.filter((facility) => facility.institutionId === principal.institutionId);
    return visible.map((facility) => {
      const certificate = state.certificates.get(facility.certificateId);
      return certificateView(state, certificate.certificateId, principal)
        .facilities.find((view) => view.facilityId === facility.facilityId);
    }).filter(Boolean);
  };

  const viewFacility = (principal, facilityId) => {
    const facility = mustFacility(facilityId);
    if (principal.role !== 'regulator' && facility.institutionId !== principal.institutionId) {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403, reason: 'not_facility_holder' });
    }
    const certificate = state.certificates.get(facility.certificateId);
    const view = certificateView(state, certificate.certificateId, principal);
    return view.facilities.find((item) => item.facilityId === facilityId) ?? null;
  };

  const viewRelease = (principal, releaseId) => {
    const release = state.releases.get(releaseId);
    if (!release) throw Object.assign(new Error('not_found'), { httpStatus: 404, reason: 'release_not_found' });
    const facility = state.facilities.get(release.facilityId);
    if (
      principal.role !== 'regulator'
      && facility.institutionId !== principal.institutionId
      && !release.requiredParties.includes(principal.institutionId)
    ) {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403, reason: 'not_release_party' });
    }
    return {
      releaseId: release.releaseId,
      certificateId: release.certificateId,
      facilityId: release.facilityId,
      parcelIds: release.parcelIds,
      requiredParties: release.requiredParties,
      status: release.status,
      requestedSeq: release.requestedSeq,
      decidedSeq: release.decidedSeq ?? null,
      receipts: release.receipts,
    };
  };

  /* --------------------------- 监管审计重算 --------------------------- */

  const auditEvents = (principal) => {
    requireRole(principal, 'regulator');
    return store.events.map((event) => ({ ...event }));
  };

  const snapshotState = (snapshotStateMap) => {
    const certificates = {};
    for (const [certificateId, certificate] of snapshotStateMap.certificates) {
      certificates[certificateId] = {
        enterpriseId: certificate.enterpriseId,
        parcelIds: certificate.parcelIds,
        weights: certificate.weights,
        currentValue: round2(certificate.currentValue),
        currentVersionId: certificate.currentVersionId,
        facilities: certificate.facilities.map((facilityId) => {
          const facility = snapshotStateMap.facilities.get(facilityId);
          return {
            facilityId,
            institutionId: facility.institutionId,
            status: facility.status,
            limit: round2(facility.limit),
            outstanding: round2(facility.outstanding),
            parcelIds: facility.parcelIds,
            drawdowns: facility.drawdowns.map((drawdown) => ({
              drawdownId: drawdown.drawdownId,
              amount: round2(drawdown.amount),
              repaid: round2(drawdown.repaid),
              remaining: round2(drawdown.remaining),
            })),
          };
        }),
      };
    }
    return certificates;
  };

  const recompute = (principal) => {
    requireRole(principal, 'regulator');
    const replay = createInitialState();
    for (const event of store.events) fold(replay, event);

    const expected = stableStringify(snapshotState(state));
    const actual = stableStringify(snapshotState(replay));
    const balances = {};
    for (const [certificateId] of state.certificates) {
      const live = certificateView(state, certificateId, principal).availability;
      const replayed = certificateView(replay, certificateId, principal).availability;
      balances[certificateId] = { live, replayed, match: stableStringify(live) === stableStringify(replayed) };
    }
    return {
      eventCount: store.events.length,
      stateMatches: expected === actual,
      balances,
    };
  };

  return {
    registerCertificate,
    recordValuation,
    freezeFacility,
    drawdown,
    repay,
    requestRevocation,
    cancelRevocation,
    finalizeRevocation,
    requestRelease,
    recordReceipt,
    viewCertificate,
    listFacilities,
    viewFacility,
    viewRelease,
    auditEvents,
    recompute,
    _store: store,
  };
}
