import crypto from 'node:crypto';

/**
 * 稳定规范化 JSON：按 key 排序，确保任意时间、任意机器重放时哈希一致。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function hashEvent(event) {
  const { hash, ...body } = event;
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * 事件是不可变事实。除业务载荷外还携带：
 *  - eventId / time / timeKey：全局确定次序；
 *  - actor：谁产生了这条事实（监管审计需要）；
 *  - idempotencyKey：机构回执重投时去重；
 *  - prevHash/hash：前向哈希链，任何篡改都会让后续校验失败。
 */
export function makeEvent({ type, payload, actor, clock, prevHash, idempotencyKey = null }) {
  const time = clock.now();
  const event = {
    eventId: crypto.randomUUID(),
    type,
    time: time.t,
    seq: time.seq,
    timeKey: `${time.t.toString().padStart(16, '0')}-${time.seq.toString().padStart(10, '0')}`,
    actor: actor ? { role: actor.role, id: actor.id } : null,
    idempotencyKey,
    payload,
    prevHash,
  };
  event.hash = hashEvent(event);
  return event;
}
