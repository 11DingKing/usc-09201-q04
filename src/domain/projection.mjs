/**
 * 投影：把不可变事件流折叠成当前状态。
 * 这是唯一的状态来源——落盘的只有事件，重启或监管检查时整体重放即可得到一致结果。
 */

export const LOAN_TO_VALUE_RATE = 0.7;

export function createInitialState() {
  return {
    version: 0,
    lastHash: null,
    certificates: new Map(), // certificateId -> 权证聚合
    credits: new Map(), // creditId -> 授信占用聚合
    idempotency: new Map(), // 机构回执键 -> 首次处理记录
  };
}

function ensureCertificate(state, certificateId) {
  let cert = state.certificates.get(certificateId);
  if (!cert) {
    cert = {
      certificateId,
      warrantNumber: null,
      holderName: null,
      registeredAt: null,
      plots: new Map(), // plotId -> {plotId, areaMu, location, attachedCreditId, attachedAt}
      plotOrder: [],
      valuations: [], // 按登记次序排列的估值版本
      creditIds: new Set(),
    };
    state.certificates.set(certificateId, cert);
  }
  return cert;
}

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.type) {
    case 'certificate.registered': {
      const cert = ensureCertificate(state, p.certificateId);
      cert.warrantNumber = p.warrantNumber;
      cert.holderName = p.holderName;
      cert.registeredAt = p.registeredAt;
      for (const plot of p.plots) {
        cert.plots.set(plot.plotId, {
          plotId: plot.plotId,
          areaMu: plot.areaMu,
          location: plot.location,
          attachedCreditId: null,
          attachedAt: null,
        });
        cert.plotOrder.push(plot.plotId);
      }
      break;
    }

    case 'valuation.recorded': {
      const cert = ensureCertificate(state, p.certificateId);
      cert.valuations.push({
        version: p.version,
        totalValue: p.totalValue,
        plotValues: { ...p.plotValues },
        assessedAt: p.assessedAt,
        recordedAt: event.time,
        supersedesVersion: p.supersedesVersion,
        eventId: event.eventId,
      });
      break;
    }

    case 'credit.frozen': {
      const cert = ensureCertificate(state, p.certificateId);
      const credit = {
        creditId: p.creditId,
        certificateId: p.certificateId,
        institutionId: p.institutionId,
        plotIds: [...p.plotIds], // 附着次序即后续自动释放次序（FIFO）
        amount: p.amount, // 授信额度（冻结额度）
        valuationVersion: p.valuationVersion,
        outstanding: 0,
        status: 'frozen',
        frozenAt: p.frozenAt,
        revocationRequestedAt: null,
        drawdowns: [],
        repayments: [],
        releases: [],
      };
      state.credits.set(p.creditId, credit);
      cert.creditIds.add(p.creditId);
      for (const plotId of p.plotIds) {
        const plot = cert.plots.get(plotId);
        if (plot) {
          plot.attachedCreditId = p.creditId;
          plot.attachedAt = p.frozenAt;
        }
      }
      break;
    }

    case 'drawdown.accepted': {
      const credit = state.credits.get(p.creditId);
      if (credit) {
        credit.outstanding += p.amount;
        credit.drawdowns.push({
          drawdownId: p.drawdownId,
          amount: p.amount,
          at: p.at,
          eventId: event.eventId,
        });
      }
      break;
    }

    case 'repayment.recorded': {
      const credit = state.credits.get(p.creditId);
      if (credit) {
        credit.outstanding = p.outstandingAfter;
        credit.repayments.push({
          repaymentId: p.repaymentId,
          amount: p.amount,
          outstandingAfter: p.outstandingAfter,
          at: p.at,
          eventId: event.eventId,
        });
      }
      break;
    }

    case 'collateral.released': {
      const credit = state.credits.get(p.creditId);
      const cert = state.certificates.get(p.certificateId);
      if (credit && cert) {
        const released = new Set(p.plotIds);
        credit.plotIds = credit.plotIds.filter((id) => !released.has(id));
        credit.releases.push({
          releaseId: p.refId,
          plotIds: [...p.plotIds],
          reason: p.reason,
          at: p.at,
          eventId: event.eventId,
        });
        for (const plotId of p.plotIds) {
          const plot = cert.plots.get(plotId);
          if (plot && plot.attachedCreditId === credit.creditId) {
            plot.attachedCreditId = null;
            plot.attachedAt = null;
          }
        }
        if (credit.plotIds.length === 0 && credit.status === 'frozen') {
          credit.status = 'closed';
        }
      }
      break;
    }

    case 'credit.revocation_requested': {
      const credit = state.credits.get(p.creditId);
      if (credit) {
        credit.status = 'revoking';
        credit.revocationRequestedAt = p.at;
      }
      break;
    }

    case 'credit.revoked': {
      const credit = state.credits.get(p.creditId);
      const cert = credit ? state.certificates.get(credit.certificateId) : null;
      if (credit && cert) {
        for (const plotId of credit.plotIds) {
          const plot = cert.plots.get(plotId);
          if (plot && plot.attachedCreditId === credit.creditId) {
            plot.attachedCreditId = null;
            plot.attachedAt = null;
          }
        }
        credit.releases.push({
          releaseId: null,
          plotIds: [...credit.plotIds],
          reason: 'revocation',
          at: p.at,
          eventId: event.eventId,
        });
        credit.plotIds = [];
        credit.status = 'revoked';
      }
      break;
    }

    default:
      break;
  }

  if (event.idempotencyKey) {
    state.idempotency.set(event.idempotencyKey, {
      eventType: event.type,
      eventId: event.eventId,
      payload: event.payload,
    });
  }
  state.version += 1;
  state.lastHash = event.hash;
  return state;
}

export function fold(events, state = createInitialState()) {
  for (const event of events) applyEvent(state, event);
  return state;
}

/* ----------------------------- 派生查询 ----------------------------- */

export function currentValuation(cert) {
  return cert.valuations.length === 0 ? null : cert.valuations[cert.valuations.length - 1];
}

export function plotCap(valuation, plotId) {
  if (!valuation) return 0;
  return Math.round((valuation.plotValues[plotId] || 0) * LOAN_TO_VALUE_RATE * 100) / 100;
}

export function creditCap(credit, valuation) {
  return Math.round(
    credit.plotIds.reduce((sum, plotId) => sum + plotCap(valuation, plotId), 0) * 100,
  ) / 100;
}

/** 受当前估值版本约束后的实际可提款上限：授信额度与抵质押率上限取小。 */
export function effectiveLimit(credit, valuation) {
  return Math.min(credit.amount, creditCap(credit, valuation));
}

export function creditView(state, credit) {
  const cert = state.certificates.get(credit.certificateId);
  const valuation = currentValuation(cert);
  const cap = creditCap(credit, valuation);
  const limit = effectiveLimit(credit, valuation);
  return {
    creditId: credit.creditId,
    certificateId: credit.certificateId,
    institutionId: credit.institutionId,
    status: credit.status,
    frozenAmount: credit.amount,
    valuationVersion: credit.valuationVersion,
    currentValuationVersion: valuation ? valuation.version : null,
    collateralCap: cap,
    outstanding: credit.outstanding,
    remaining: Math.max(0, Math.round((limit - credit.outstanding) * 100) / 100),
    coverageBreached: credit.outstanding > cap + 1e-9,
    frozenAt: credit.frozenAt,
    revocationRequestedAt: credit.revocationRequestedAt,
    plotIds: [...credit.plotIds],
    drawdowns: credit.drawdowns.map((d) => ({
      drawdownId: d.drawdownId,
      amount: d.amount,
      at: d.at,
    })),
    repayments: credit.repayments.map((r) => ({
      repaymentId: r.repaymentId,
      amount: r.amount,
      outstandingAfter: r.outstandingAfter,
      at: r.at,
    })),
    releases: credit.releases,
  };
}

/**
 * 权证可用余量。
 * - availableForNewFreeze：未被任何授信占用的地块，按当前估值与抵质押率折算，可用于新增冻结；
 * - outstanding：全机构已提款余额；
 * - frozenReserve：已冻结但尚未提款的额度（别家机构的预留）。
 */
export function certificateView(state, certificateId, viewer = { role: 'regulator' }) {
  const cert = state.certificates.get(certificateId);
  if (!cert) return null;
  const valuation = currentValuation(cert);
  const credits = [...cert.creditIds].map((id) => state.credits.get(id));
  const activeCredits = credits.filter((c) => c.status !== 'revoked');

  let outstanding = 0;
  let frozenReserve = 0;
  for (const credit of activeCredits) {
    if (credit.plotIds.length === 0) continue; // 已结清、地块全部归还的授信不再占用余量
    outstanding += credit.outstanding;
    // 预留额按当前估值下的有效可提上限计算，估值下调会即时收缩
    frozenReserve += Math.max(0, effectiveLimit(credit, valuation) - credit.outstanding);
  }
  outstanding = Math.round(outstanding * 100) / 100;
  frozenReserve = Math.round(frozenReserve * 100) / 100;

  let availableForNewFreeze = 0;
  const plots = cert.plotOrder.map((plotId) => {
    const plot = cert.plots.get(plotId);
    const cap = plotCap(valuation, plotId);
    const frozen = plot.attachedCreditId !== null;
    if (!frozen) availableForNewFreeze += cap;
    return {
      plotId: plot.plotId,
      areaMu: plot.areaMu,
      location: plot.location,
      cap: valuation ? cap : null,
      frozen,
      ...(frozen
        ? viewer.role === 'regulator' ||
          (viewer.role === 'institution' &&
            state.credits.get(plot.attachedCreditId)?.institutionId === viewer.id)
          ? { attachedCreditId: plot.attachedCreditId, attachedAt: plot.attachedAt }
          : { attachedCreditId: null, attachedAt: null, heldBy: 'other_institution' }
        : {}),
    };
  });
  availableForNewFreeze = Math.round(availableForNewFreeze * 100) / 100;

  const view = {
    certificateId: cert.certificateId,
    warrantNumber: cert.warrantNumber,
    holderName: cert.holderName,
    registeredAt: cert.registeredAt,
    currentValuationVersion: valuation ? valuation.version : null,
    totalCollateralValue: valuation ? valuation.totalValue : null,
    plots,
    margin: {
      loanToValueRate: LOAN_TO_VALUE_RATE,
      outstanding,
      frozenReserve,
      availableForNewFreeze,
    },
  };

  if (viewer.role === 'regulator') {
    // 监管可见全部授信，包括已解除/已结清等终态记录
    view.credits = credits.map((credit) => creditView(state, credit));
  } else {
    view.credits = credits
      .filter((credit) => credit.institutionId === viewer.id)
      .map((credit) => creditView(state, credit));
  }
  return view;
}

export function listCertificateViews(state, viewer) {
  const ids = [...state.certificates.keys()];
  if (viewer.role === 'regulator') return ids.map((id) => certificateView(state, id, viewer));
  return ids
    .filter((id) => {
      const cert = state.certificates.get(id);
      return [...cert.creditIds].some(
        (creditId) => state.credits.get(creditId)?.institutionId === viewer.id,
      );
    })
    .map((id) => certificateView(state, id, viewer));
}
