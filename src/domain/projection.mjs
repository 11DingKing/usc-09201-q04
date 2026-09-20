/**
 * 读模型投影：状态只能由 fold(state, event) 推进。
 * 活动服务在每次追加事件时即时 fold；监管审计可以从空状态重放整条日志，
 * 得到必须与活动投影逐字段一致的结果。
 */

export function createInitialState() {
  return {
    certificates: new Map(), // cid -> certificate
    facilities: new Map(), // fid -> facility（facilityId 全局唯一）
    facilityCertificate: new Map(), // fid -> cid
    releases: new Map(), // rid -> release
    receiptIndex: new Map(), // receiptId -> rid
  };
}

function asArray(value) {
  return value ? [...value] : [];
}

export function fold(state, event) {
  switch (event.type) {
    case 'certificate.registered':
      return onRegistered(state, event);
    case 'valuation.recorded':
      return onValuation(state, event);
    case 'facility.frozen':
      return onFacilityFrozen(state, event);
    case 'drawdown.made':
      return onDrawdown(state, event);
    case 'repayment.recorded':
      return onRepayment(state, event);
    case 'revocation.requested': {
      const facility = state.facilities.get(event.data.facilityId);
      facility.status = 'revocation_pending';
      facility.revocation = { revocationId: event.data.revocationId, status: 'pending', sinceSeq: event.seq };
      return state;
    }
    case 'revocation.cancelled': {
      const facility = state.facilities.get(event.data.facilityId);
      facility.status = 'active';
      facility.revocation.status = 'cancelled';
      return state;
    }
    case 'facility.revoked': {
      const facility = state.facilities.get(event.data.facilityId);
      facility.status = 'revoked';
      facility.revocation.status = 'finalized';
      facility.parcelIds = [];
      return state;
    }
    case 'release.requested': {
      state.releases.set(event.data.releaseId, {
        releaseId: event.data.releaseId,
        certificateId: event.certificateId,
        facilityId: event.data.facilityId,
        parcelIds: [...event.data.parcelIds],
        requiredParties: [...event.data.requiredParties],
        status: 'pending',
        requestedSeq: event.seq,
        receipts: [],
      });
      return state;
    }
    case 'receipt.recorded': {
      const release = state.releases.get(event.data.releaseId);
      release.receipts.push({
        party: event.data.party,
        receiptId: event.data.receiptId,
        decision: event.data.decision,
        reason: event.data.reason ?? null,
        seq: event.seq,
      });
      state.receiptIndex.set(event.data.receiptId, event.data.releaseId);
      return state;
    }
    case 'release.approved': {
      const release = state.releases.get(event.data.releaseId);
      const facility = state.facilities.get(release.facilityId);
      const freed = new Set(event.data.parcelIds);
      facility.parcelIds = facility.parcelIds.filter((parcelId) => !freed.has(parcelId));
      facility.limit = event.data.limitReducedTo;
      release.status = 'approved';
      release.decidedSeq = event.seq;
      return state;
    }
    case 'release.rejected': {
      const release = state.releases.get(event.data.releaseId);
      release.status = 'rejected';
      release.decidedSeq = event.seq;
      return state;
    }
    case 'command.rejected':
      // 冲突本身留痕，不改变业务占用
      return state;
    default:
      throw new Error(`未知事件类型：${event.type}`);
  }
}

function onRegistered(state, event) {
  const weights = event.data.weights ?? {};
  state.certificates.set(event.certificateId, {
    certificateId: event.certificateId,
    enterpriseId: event.data.enterpriseId,
    parcelIds: [...event.data.parcelIds],
    weights,
    currentValue: event.data.initialValue,
    currentVersionId: event.data.versionId ?? 'v1',
    versions: [
      {
        versionId: event.data.versionId ?? 'v1',
        value: event.data.initialValue,
        note: event.data.note ?? '登记初值',
        seq: event.seq,
      },
    ],
    facilities: [],
    seq: event.seq,
  });
  return state;
}

function onValuation(state, event) {
  const certificate = mustCertificate(state, event.certificateId);
  certificate.versions.push({
    versionId: event.data.versionId,
    value: event.data.value,
    note: event.data.note ?? '',
    seq: event.seq,
  });
  certificate.currentValue = event.data.value;
  certificate.currentVersionId = event.data.versionId;
  return state;
}

function onFacilityFrozen(state, event) {
  const certificate = mustCertificate(state, event.certificateId);
  const facility = {
    facilityId: event.data.facilityId,
    certificateId: event.certificateId,
    institutionId: event.data.institutionId,
    status: 'active',
    limit: event.data.limit,
    parcelIds: [...event.data.parcelIds],
    outstanding: 0,
    drawdowns: [],
    revocation: null,
    frozenSeq: event.seq,
  };
  state.facilities.set(event.data.facilityId, facility);
  state.facilityCertificate.set(event.data.facilityId, event.certificateId);
  certificate.facilities.push(event.data.facilityId);
  return state;
}

function onDrawdown(state, event) {
  const facility = state.facilities.get(event.data.facilityId);
  facility.drawdowns.push({
    drawdownId: event.data.drawdownId,
    amount: event.data.amount,
    repaid: 0,
    remaining: event.data.amount,
    seq: event.seq,
  });
  facility.outstanding += event.data.amount;
  return state;
}

function onRepayment(state, event) {
  const facility = state.facilities.get(event.data.facilityId);
  const byId = new Map(facility.drawdowns.map((drawdown) => [drawdown.drawdownId, drawdown]));
  for (const allocation of event.data.allocations) {
    const drawdown = byId.get(allocation.drawdownId);
    drawdown.repaid += allocation.amount;
    drawdown.remaining -= allocation.amount;
    facility.outstanding -= allocation.amount;
  }
  return state;
}

function mustCertificate(state, certificateId) {
  const certificate = state.certificates.get(certificateId);
  if (!certificate) throw new Error(`投影缺少权证 ${certificateId}`);
  return certificate;
}

/* ----------------------------- 派生计算 ----------------------------- */

export function totalWeight(certificate) {
  return certificate.parcelIds.reduce((sum, parcelId) => sum + (certificate.weights[parcelId] ?? 1), 0);
}

export function parcelShareValue(certificate, parcelId) {
  const weight = certificate.weights[parcelId] ?? 1;
  return (certificate.currentValue * weight) / totalWeight(certificate);
}

export function activeFacilities(state, certificate) {
  return certificate.facilities
    .map((facilityId) => state.facilities.get(facilityId))
    .filter((facility) => facility.status !== 'revoked');
}

export function totals(state, certificate) {
  const facilities = activeFacilities(state, certificate);
  const totalFrozenLimit = facilities.reduce((sum, facility) => sum + facility.limit, 0);
  const totalOutstanding = facilities.reduce((sum, facility) => sum + facility.outstanding, 0);
  return {
    currentValue: certificate.currentValue,
    currentVersionId: certificate.currentVersionId,
    totalFrozenLimit,
    totalOutstanding,
    // 可新增冻结的额度空间；估值下调后可能为负，余量按 0 展示但保留缺口数字
    freezableLimit: certificate.currentValue - totalFrozenLimit,
    // 可新增提款的价值空间
    freeMargin: certificate.currentValue - totalOutstanding,
  };
}

export function facilityCoverage(state, certificate, facility) {
  return facility.parcelIds.reduce((sum, parcelId) => sum + parcelShareValue(certificate, parcelId), 0);
}

/**
 * 按 FIFO（提款落账次序）分配还款，返回分配明细与剩余金额。
 * 命令侧据此生成事件，重放时不重新分配，保证释放顺序可追溯。
 */
export function allocateRepayment(facility, amount) {
  const allocations = [];
  let remaining = amount;
  for (const drawdown of facility.drawdowns) {
    if (remaining <= 0) break;
    if (drawdown.remaining <= 0) continue;
    const part = Math.min(remaining, drawdown.remaining);
    allocations.push({ drawdownId: drawdown.drawdownId, amount: part });
    remaining -= part;
  }
  return { allocations, unallocated: remaining };
}

export function facilityView(state, certificate, facility) {
  const coverage = facilityCoverage(state, certificate, facility);
  const ownOutstanding = facility.outstanding;
  const availableToDraw =
    facility.status === 'active'
      ? Math.max(0, Math.min(facility.limit - ownOutstanding, certificate.currentValue - totalGlobalOutstanding(state, certificate)))
      : 0;
  return {
    facilityId: facility.facilityId,
    institutionId: facility.institutionId,
    status: facility.status,
    limit: facility.limit,
    outstanding: ownOutstanding,
    availableToDraw,
    parcelIds: asArray(facility.parcelIds),
    coverageValue: round2(coverage),
    coverageShortfall: round2(ownOutstanding - coverage) > 0 ? round2(ownOutstanding - coverage) : 0,
    revocation: facility.revocation
      ? { revocationId: facility.revocation.revocationId, status: facility.revocation.status }
      : null,
    drawdowns: facility.drawdowns.map((drawdown) => ({
      drawdownId: drawdown.drawdownId,
      amount: drawdown.amount,
      repaid: drawdown.repaid,
      remaining: drawdown.remaining,
      settled: drawdown.remaining === 0,
    })),
    frozenSeq: facility.frozenSeq,
  };
}

function totalGlobalOutstanding(state, certificate) {
  return activeFacilities(state, certificate).reduce((sum, facility) => sum + facility.outstanding, 0);
}

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 按调用方权限裁剪视图：机构看不到其他机构的授信明细，
 * 只能看到权证级聚合余量与他人地块“已占用”状态；监管看全量。
 */
export function certificateView(state, certificateId, principal) {
  const certificate = state.certificates.get(certificateId);
  if (!certificate) return null;
  const summary = totals(state, certificate);
  const facilities = activeFacilities(state, certificate);
  const allFacilities = certificate.facilities.map((facilityId) => state.facilities.get(facilityId));
  const facilityViews = [];

  for (const facility of allFacilities) {
    const mine = principal.role === 'institution' && facility.institutionId === principal.institutionId;
    if (principal.role === 'regulator' || mine) {
      facilityViews.push(facilityView(state, certificate, facility));
    }
  }

  const parcels = certificate.parcelIds.map((parcelId) => {
    const holder = facilities.find((facility) => facility.parcelIds.includes(parcelId));
    const base = {
      parcelId,
      shareValue: round2(parcelShareValue(certificate, parcelId)),
    };
    if (!holder) return { ...base, status: 'free' };
    const mine = principal.role === 'institution' && holder.institutionId === principal.institutionId;
    if (principal.role === 'regulator' || mine) {
      return { ...base, status: 'locked', facilityId: holder.facilityId };
    }
    return { ...base, status: 'encumbered' };
  });

  const view = {
    certificateId: certificate.certificateId,
    enterpriseId: certificate.enterpriseId,
    seq: certificate.seq,
    valuation: {
      versionId: certificate.currentVersionId,
      value: certificate.currentValue,
    },
    availability: {
      totalFrozenLimit: round2(summary.totalFrozenLimit),
      totalOutstanding: round2(summary.totalOutstanding),
      freezableLimit: round2(summary.freezableLimit),
      freeMargin: round2(summary.freeMargin),
    },
    parcels,
    facilities: facilityViews,
  };

  if (principal.role === 'regulator') {
    view.valuationHistory = certificate.versions;
    view.releases = [...state.releases.values()]
      .filter((release) => release.certificateId === certificateId)
      .map((release) => ({
        releaseId: release.releaseId,
        facilityId: release.facilityId,
        parcelIds: release.parcelIds,
        status: release.status,
        requestedSeq: release.requestedSeq,
        decidedSeq: release.decidedSeq ?? null,
        receipts: release.receipts,
      }));
  }
  return view;
}
