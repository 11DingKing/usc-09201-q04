import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键递归排序，保证同一事件在任何进程里算出同一哈希。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashOf(previousHash, event) {
  const record = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    certificateId: event.certificateId,
    data: event.data,
  };
  return createHash('sha256').update(`${previousHash}|${stableStringify(record)}`).digest('hex');
}

/**
 * 追加式事件存储。
 * - 全部状态变更只通过 append 进入日志；
 * - withLock 按权证串行化命令，提交次序即确定次序；
 * - state 是随追加即时折叠的活动投影，replay 时从空状态走同一个 fold。
 */
export class EventStore {
  constructor() {
    this.events = [];
    this.chains = new Map();
    this.idempotency = new Map();
    this.state = undefined; // 由服务层注入初始状态
  }

  withLock(scope, fn) {
    const previous = this.chains.get(scope) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    // 上一条命令的业务异常不得毒化队列：只排队、不传拒因
    this.chains.set(scope, previous.then(() => current, () => current));
    return previous.then(fn, fn).finally(release);
  }

  #idempotencyKey(principal, key) {
    return `${principal.role}:${principal.institutionId ?? ''}:${key}`;
  }

  /**
   * 在某权证的串行队列里执行命令。
   * fn 收到 { accept, reject }，二者恰好调用其一；
   * accept/acceptReject 的事件统一在锁内落账，杜绝同一命令双写。
   */
  async command(scope, principal, idempotencyKey, fn) {
    const idemKey = idempotencyKey ? this.#idempotencyKey(principal, idempotencyKey) : null;
    if (idemKey && this.idempotency.has(idemKey)) {
      return { ...this.idempotency.get(idemKey), replayed: true };
    }
    return this.withLock(scope, async () => {
      if (idemKey) {
        const hit = this.idempotency.get(idemKey);
        if (hit) return { ...hit, replayed: true };
      }
      let decision = null;
      const accept = (type, certificateId, data, body, status = 201) => {
        decision = { kind: 'accept', events: [{ type, certificateId, data }], body, status };
        // 同一决议可在锁内级联追加事件（如回执集齐后立刻产生释放决定）
        return {
          andEmit(followType, followData, followCertificateId = certificateId) {
            decision.events.push({ type: followType, certificateId: followCertificateId, data: followData });
            return this;
          },
        };
      };
      const reject = (certificateId, commandType, reason, detail = {}, status = 409) => {
        decision = { kind: 'reject', certificateId, commandType, reason, detail, status };
      };
      const body = await fn({ accept, reject });
      if (!decision) throw new Error('命令未给出决议');
      let result;
      if (decision.kind === 'accept') {
        const events = decision.events.map((entry) => this.#append(entry.type, entry.certificateId, entry.data));
        const lastEvent = events[events.length - 1];
        result = {
          status: decision.status,
          body: body ?? decision.body ?? { seq: lastEvent.seq },
          replayed: false,
          events: events.map((event) => ({ seq: event.seq, type: event.type })),
        };
      } else {
        const data = {
          commandType: decision.commandType,
          actorRole: principal.role,
          actorInstitutionId: principal.institutionId ?? null,
          reason: decision.reason,
          detail: decision.detail,
        };
        const event = this.#append('command.rejected', decision.certificateId, data);
        result = {
          status: decision.status,
          body: { error: 'conflict', reason: decision.reason, detail: decision.detail, seq: event.seq },
          replayed: false,
        };
      }
      if (idemKey) this.idempotency.set(idemKey, { status: result.status, body: result.body });
      return result;
    });
  }

  #append(type, certificateId, data) {
    const seq = this.events.length + 1;
    const ts = new Date().toISOString();
    const previousHash = this.events[this.events.length - 1]?.hash ?? '0'.repeat(64);
    const event = { seq, ts, type, certificateId, data, hash: null };
    event.hash = hashOf(previousHash, event);
    this.events.push(event);
    this.applyEvent(event);
    return event;
  }

  applyEvent(event) {
    if (!this.apply) throw new Error('store.apply 未注入');
    this.apply(event);
  }
}
