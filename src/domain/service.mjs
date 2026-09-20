import { EventStore } from './store.mjs';
import { makeEvent, hashEvent } from './events.mjs';
import {
  createInitialState,
  fold,
  currentValuation,
  plotCap,
  creditCap,
  effectiveLimit,
  certificateView,
  creditView,
  listCertificateViews,
} from './projection.mjs';
import { createClock } from './clock.mjs';
import { DomainError } from './errors.mjs';

/**
 * 应用服务：命令 -> 校验 -> 追加事件。
 *
 * 串行提交模型：每次命令都从最新事件折叠状态，决策（是否超额、地块是否被占）
 * 基于该快照完成，提交时带 expectedVersion 乐观锁；竞争失败则重新折叠并重试。
 * 因此“两家银行同时锁定同一地块”只有一家成功，另一家拿到确定性冲突响应。
 */
export class FinancingService {
  constructor({ store, clock = createClock(), maxRetries = 10 } = {}) {
    this.store = store || new EventStore(process.env.EVENT_STORE_DIR || './data/events');
    this.clock = clock;
    this.maxRetries = maxRetries;
  }

  async #load() {
    const events = await this.store.readAll();
    return { events, state: fold(events) };
  }

  async #append(type, payload, { actor, state, idempotencyKey = null }) {
    const event = makeEvent({
      type,
      payload,
      actor,
      clock: this.clock,
      prevHash: state.lastHash,
      idempotencyKey,
    });
    const result = await this.store.append(event, state.version);
    return { result, event };
  }

  /**
   * 在最新快照上执行决策函数 decide(state)，返回事件构造信息；
   * 乐观锁冲突时整体重放重试，保证决策与提交之间没有穿插写入。
   */
  async #transact(idempotencyKey, actor, decide) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const { state } = await this.#load();

      if (idempotencyKey) {
        const seen = state.idempotency.get(idempotencyKey);
        if (seen) {
          return { idempotent: true, eventId: seen.eventId, eventType: seen.eventType, payload: seen.payload };
        }
      }

      const decision = decide(state); // 失败时抛 DomainError
      const { result, event } = await this.#append(decision.type, decision.payload, {
        actor,
        state,
        idempotencyKey,
      });
      if (result.ok) {
        return { idempotent: false, eventId: event.eventId, event, version: result.version };
      }
      if (result.code !== 'concurrent_modification') {
        throw new DomainError(result.code, `事件追加失败：${result.code}`, 500);
      }
    }
    throw new DomainError('busy_retry', '并发冲突过多，请稍后重试', 409);
  }

  #requireRegulator(actor) {
    if (!actor || actor.role !== 'regulator') {
      throw new DomainError('forbidden', '该操作仅监管协作人员可执行', 403);
    }
  }

  #requireInstitution(actor) {
    if (!actor || actor.role !== 'institution' || !actor.id) {
      throw new DomainError('forbidden', '金融机构身份缺失', 403);
    }
  }

  #getCredit(state, creditId, { ownerOnly = true } = {}) {
    const credit = state.credits.get(creditId);
    if (!credit) throw new DomainError('credit_not_found', `授信不存在：${creditId}`, 404);
    return credit;
  }

  #requireOwner(actor, credit) {
    if (actor.role === 'institution' && credit.institutionId !== actor.id) {
      throw new DomainError('forbidden', '只能操作本机构名下授信', 403);
    }
  }

  /* --------------------------- 监管：权证与估值 --------------------------- */

  async registerCertificate(command, actor) {
    this.#requireRegulator(actor);
    const { certificateId, warrantNumber, holderName, plots, registeredAt } = command;
    if (!certificateId || !warrantNumber) {
      throw new DomainError('invalid_request', 'certificateId 与 warrantNumber 必填', 400);
    }
    if (!Array.isArray(plots) || plots.length === 0) {
      throw new DomainError('invalid_request', '至少登记一个地块', 400);
    }
    const seen = new Set();
    for (const plot of plots) {
      if (!plot.plotId || !(plot.areaMu > 0)) {
        throw new DomainError('invalid_request', '地块标识与面积(亩)必须有效', 400);
      }
      if (seen.has(plot.plotId)) {
        throw new DomainError('invalid_request', `地块重复：${plot.plotId}`, 400);
      }
      seen.add(plot.plotId);
    }
    return this.#transact(null, actor, (state) => {
      if (state.certificates.has(certificateId)) {
        throw new DomainError('certificate_exists', `权证已登记：${certificateId}`, 409);
      }
      return {
        type: 'certificate.registered',
        payload: {
          certificateId,
          warrantNumber,
          holderName: holderName ?? null,
          registeredAt: registeredAt ?? new Date().toISOString(),
          plots: plots.map(({ plotId, areaMu, location }) => ({
            plotId,
            areaMu,
            location: location ?? null,
          })),
        },
      };
    });
  }

  async recordValuation(command, actor) {
    this.#requireRegulator(actor);
    const { certificateId, totalValue, plotValues, assessedAt, note } = command;
    if (!(totalValue > 0) || !plotValues || typeof plotValues !== 'object') {
      throw new DomainError('invalid_request', '估值总额与分地块估值必填', 400);
    }
    return this.#transact(command.idempotencyKey ?? null, actor, (state) => {
      const cert = state.certificates.get(certificateId);
      if (!cert) throw new DomainError('certificate_not_found', `权证不存在：${certificateId}`, 404);
      for (const plotId of Object.keys(plotValues)) {
        if (!cert.plots.has(plotId)) {
          throw new DomainError('unknown_plot', `估值包含未登记地块：${plotId}`, 400);
        }
      }
      const version = cert.valuations.length + 1;
      const previous = currentValuation(cert);
      return {
        type: 'valuation.recorded',
        payload: {
          certificateId,
          version,
          totalValue,
          plotValues,
          assessedAt: assessedAt ?? new Date().toISOString(),
          supersedesVersion: previous ? previous.version : null,
          note: note ?? null,
        },
      };
    });
  }

  /* --------------------------- 机构：冻结/提款/偿还/释放/撤销 --------------------------- */

  async freezeCredit(command, actor) {
    this.#requireInstitution(actor);
    const { certificateId, creditId, plotIds, amount, idempotencyKey } = command;
    if (!creditId || !Array.isArray(plotIds) || plotIds.length === 0 || !(amount > 0)) {
      throw new DomainError('invalid_request', 'creditId、plotIds(非空)、amount(正数)必填', 400);
    }
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      if (state.credits.has(creditId)) {
        throw new DomainError('credit_exists', `授信已存在：${creditId}`, 409);
      }
      const cert = state.certificates.get(certificateId);
      if (!cert) throw new DomainError('certificate_not_found', `权证不存在：${certificateId}`, 404);
      const valuation = currentValuation(cert);
      if (!valuation) {
        throw new DomainError('valuation_missing', '权证尚无估值版本，不能冻结授信', 422);
      }
      const unique = [...new Set(plotIds)];
      if (unique.length !== plotIds.length) {
        throw new DomainError('invalid_request', '附着地块重复', 400);
      }
      const conflicts = [];
      let cap = 0;
      for (const plotId of plotIds) {
        const plot = cert.plots.get(plotId);
        if (!plot) {
          throw new DomainError('unknown_plot', `地块未登记：${plotId}`, 400);
        }
        if (plot.attachedCreditId) {
          const holder = state.credits.get(plot.attachedCreditId);
          conflicts.push({
            plotId,
            attachedCreditId: plot.attachedCreditId,
            heldByInstitution: holder ? holder.institutionId : null,
            attachedAt: plot.attachedAt,
          });
        }
        cap += plotCap(valuation, plotId);
      }
      cap = Math.round(cap * 100) / 100;
      if (conflicts.length > 0) {
        throw new DomainError('plot_already_frozen', '部分地块已被其他授信占用', 409, {
          certificateId,
          conflicts,
        });
      }
      if (amount > cap + 1e-9) {
        throw new DomainError('amount_exceeds_cap', '冻结额度超过地块可融资上限(估值×抵质押率)', 422, {
          requestedAmount: amount,
          collateralCap: cap,
          valuationVersion: valuation.version,
        });
      }
      return {
        type: 'credit.frozen',
        payload: {
          creditId,
          certificateId,
          institutionId: actor.id,
          plotIds,
          amount,
          valuationVersion: valuation.version,
          frozenAt: new Date().toISOString(),
        },
      };
    });
  }

  async drawdown(command, actor) {
    this.#requireInstitution(actor);
    const { creditId, drawdownId, amount, idempotencyKey } = command;
    if (!drawdownId || !(amount > 0)) {
      throw new DomainError('invalid_request', 'drawdownId 与正数 amount 必填', 400);
    }
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      const credit = this.#getCredit(state, creditId);
      this.#requireOwner(actor, credit);
      if (credit.status === 'revoked') {
        throw new DomainError('credit_revoked', '授信已解除，不能提款', 409);
      }
      if (credit.status === 'revoking') {
        // 撤销进行中的新提款必须被挡下，次序由事件日志保证
        throw new DomainError('credit_revocation_in_progress', '授信正在解除，新提款被拒绝', 409, {
          revocationRequestedAt: credit.revocationRequestedAt,
        });
      }
      if (credit.drawdowns.some((d) => d.drawdownId === drawdownId)) {
        throw new DomainError('drawdown_exists', `提款已登记：${drawdownId}`, 409);
      }
      const cert = state.certificates.get(credit.certificateId);
      const valuation = currentValuation(cert);
      const limit = effectiveLimit(credit, valuation);
      const projected = Math.round((credit.outstanding + amount) * 100) / 100;
      if (projected > limit + 1e-9) {
        throw new DomainError('insufficient_remaining', '提款超过可用余量', 422, {
          creditId,
          requestedAmount: amount,
          outstanding: credit.outstanding,
          effectiveLimit: limit,
          frozenAmount: credit.amount,
          collateralCap: creditCap(credit, valuation),
          valuationVersion: valuation ? valuation.version : null,
        });
      }
      return {
        type: 'drawdown.accepted',
        payload: { creditId, drawdownId, amount, at: new Date().toISOString() },
      };
    });
  }

  async repay(command, actor) {
    this.#requireInstitution(actor);
    const { creditId, repaymentId, amount, idempotencyKey } = command;
    if (!repaymentId || !(amount > 0)) {
      throw new DomainError('invalid_request', 'repaymentId 与正数 amount 必填', 400);
    }
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      const credit = this.#getCredit(state, creditId);
      this.#requireOwner(actor, credit);
      if (credit.status === 'revoked') {
        throw new DomainError('credit_revoked', '授信已解除，不能再登记偿还', 409);
      }
      if (credit.repayments.some((r) => r.repaymentId === repaymentId)) {
        throw new DomainError('repayment_exists', `偿还已登记：${repaymentId}`, 409);
      }
      if (amount > credit.outstanding + 1e-9) {
        // 提前还款只能部分或全额清偿，不接受多缴，避免并发交错时吞没资金
        throw new DomainError('repayment_exceeds_outstanding', '偿还额超过当前未偿余额', 422, {
          outstanding: credit.outstanding,
        });
      }
      const outstandingAfter = Math.round((credit.outstanding - amount) * 100) / 100;
      return {
        type: 'repayment.recorded',
        payload: {
          creditId,
          repaymentId,
          amount,
          outstandingAfter,
          at: new Date().toISOString(),
        },
      };
    });
  }

  /**
   * 部分地块释放。释放按冻结附着次序（FIFO）校验：
   * 不允许跳过前面的地块先释放后面的地块，以免释放顺序说不清。
   * 自动释放后若全部地块释放且无欠款，授信结清关闭；尚有欠款时拒绝整笔释放。
   */
  async releaseCollateral(command, actor) {
    this.#requireInstitution(actor);
    const { creditId, refId, plotIds, reason, idempotencyKey } = command;
    if (!refId || !Array.isArray(plotIds) || plotIds.length === 0) {
      throw new DomainError('invalid_request', 'refId 与非空 plotIds 必填', 400);
    }
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      const credit = this.#getCredit(state, creditId);
      this.#requireOwner(actor, credit);
      if (credit.status === 'revoked') {
        throw new DomainError('credit_revoked', '授信已解除', 409);
      }
      const requested = [...new Set(plotIds)];
      for (const plotId of requested) {
        if (!credit.plotIds.includes(plotId)) {
          throw new DomainError('plot_not_attached', `地块未附着于本授信或已释放：${plotId}`, 409);
        }
      }
      // FIFO：要释放的地块必须是当前附着序列的一个前缀
      const prefix = credit.plotIds.slice(0, requested.length);
      const sameSet =
        prefix.length === requested.length &&
        requested.every((id) => prefix.includes(id)) &&
        prefix.every((id) => requested.includes(id));
      if (!sameSet) {
        throw new DomainError('release_order_violation', '释放必须按附着先后顺序（先附着先释放）', 409, {
          attachedOrder: credit.plotIds,
          requested: requested,
        });
      }
      const remainingAfter = credit.plotIds.slice(requested.length);
      if (remainingAfter.length === 0 && credit.outstanding > 1e-9) {
        throw new DomainError('outstanding_balance_blocks_release', '仍有未偿余额，不能释放全部地块', 409, {
          outstanding: credit.outstanding,
        });
      }
      const cert = state.certificates.get(credit.certificateId);
      return {
        type: 'collateral.released',
        payload: {
          refId,
          creditId,
          certificateId: credit.certificateId,
          plotIds: requested,
          reason: reason ?? null,
          at: new Date().toISOString(),
        },
      };
    });
  }

  /** 请求解除整笔授信：先进入“撤销中”，立即阻断新提款，再由机构确认。 */
  async requestRevocation(command, actor) {
    this.#requireInstitution(actor);
    const { creditId, idempotencyKey } = command;
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      const credit = this.#getCredit(state, creditId);
      this.#requireOwner(actor, credit);
      if (credit.status === 'revoked') {
        throw new DomainError('credit_revoked', '授信已解除', 409);
      }
      if (credit.status === 'revoking') {
        throw new DomainError('revocation_already_requested', '解除请求已在处理中', 409, {
          revocationRequestedAt: credit.revocationRequestedAt,
        });
      }
      return {
        type: 'credit.revocation_requested',
        payload: { creditId, at: new Date().toISOString() },
      };
    });
  }

  /** 确认解除：余额必须为零，剩余地块全部释放，确定次序由日志位置固定。 */
  async confirmRevocation(command, actor) {
    this.#requireInstitution(actor);
    const { creditId, idempotencyKey } = command;
    return this.#transact(idempotencyKey ?? null, actor, (state) => {
      const credit = this.#getCredit(state, creditId);
      this.#requireOwner(actor, credit);
      if (credit.status === 'revoked') {
        throw new DomainError('credit_revoked', '授信已解除', 409);
      }
      if (credit.status !== 'revoking') {
        throw new DomainError('revocation_not_requested', '需先发起解除请求', 409);
      }
      if (credit.outstanding > 1e-9) {
        throw new DomainError('outstanding_balance_blocks_revocation', '仍有未偿余额，不能解除授信', 409, {
          outstanding: credit.outstanding,
        });
      }
      return {
        type: 'credit.revoked',
        payload: { creditId, at: new Date().toISOString() },
      };
    });
  }

  /* ------------------------------- 查询 ------------------------------- */

  async queryCertificate(certificateId, actor) {
    if (!actor || (actor.role !== 'regulator' && actor.role !== 'institution')) {
      throw new DomainError('forbidden', '身份缺失', 403);
    }
    const { state } = await this.#load();
    const view = certificateView(state, certificateId, actor);
    if (!view) throw new DomainError('certificate_not_found', `权证不存在：${certificateId}`, 404);
    if (actor.role === 'institution') {
      const cert = state.certificates.get(certificateId);
      const belongs = [...cert.creditIds].some(
        (id) => state.credits.get(id)?.institutionId === actor.id,
      );
      // 机构只看到自身权限内的数据：无权证业务关系则不可见
      if (!belongs) throw new DomainError('forbidden', '无权查看该权证', 403);
    }
    return view;
  }

  async queryCredit(creditId, actor) {
    if (!actor || (actor.role !== 'regulator' && actor.role !== 'institution')) {
      throw new DomainError('forbidden', '身份缺失', 403);
    }
    const { state } = await this.#load();
    const credit = this.#getCredit(state, creditId);
    if (actor.role === 'institution' && credit.institutionId !== actor.id) {
      throw new DomainError('forbidden', '只能查看本机构名下授信', 403);
    }
    return creditView(state, credit);
  }

  async listCertificates(actor) {
    if (!actor || (actor.role !== 'regulator' && actor.role !== 'institution')) {
      throw new DomainError('forbidden', '身份缺失', 403);
    }
    const { state } = await this.#load();
    return listCertificateViews(state, actor);
  }

  /** 监管审计：重放全部事件并校验哈希链，给出可重算报告。 */
  async audit(actor) {
    this.#requireRegulator(actor);
    const events = await this.store.readAll();
    const state = createInitialState();
    const chain = [];
    let prevHash = null;
    let tampered = null;
    for (const event of events) {
      const recomputed = hashEvent(event);
      if (recomputed !== event.hash) {
        tampered = { eventId: event.eventId, reason: 'hash_mismatch' };
        break;
      }
      if (event.prevHash !== prevHash) {
        tampered = { eventId: event.eventId, reason: 'chain_broken' };
        break;
      }
      chain.push({ eventId: event.eventId, type: event.type, timeKey: event.timeKey, hash: event.hash });
      prevHash = event.hash;
      fold([event], state);
    }
    return {
      ok: !tampered,
      tampered,
      eventCount: events.length,
      stateVersion: state.version,
      lastHash: state.lastHash,
      order: chain,
      certificates: tampered
        ? null
        : listCertificateViews(state, { role: 'regulator' }).map((view) => ({
            certificateId: view.certificateId,
            margin: view.margin,
            creditCount: view.credits.length,
            credits: view.credits.map((c) => ({
              creditId: c.creditId,
              institutionId: c.institutionId,
              status: c.status,
              frozenAmount: c.frozenAmount,
              collateralCap: c.collateralCap,
              outstanding: c.outstanding,
              remaining: c.remaining,
              coverageBreached: c.coverageBreached,
            })),
          })),
    };
  }
}
