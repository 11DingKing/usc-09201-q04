import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

/**
 * 仅追加事件存储。事件按 timeKey 命名落盘，保证：
 *  - 追加后不可变（事件文件不覆盖写）；
 *  - 文件名排序即全序，监管侧可脱离本服务按同一顺序重放；
 *  - expectedVersion 提供乐观并发控制：折叠期间读到的版本与提交时不一致则拒绝。
 *
 * 生产部署可将 append/readEvents 替换为同一语义的事务日志（如带唯一版本号约束的表）。
 */
export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.appendQueue = Promise.resolve();
  }

  async #readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
  }

  async readAll() {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((name) => name.endsWith('.json')).sort();
    const events = [];
    for (const name of files) {
      events.push(await this.#readJson(`${this.dir}/${name}`));
    }
    return events;
  }

  /**
   * 串行化追加，避免并发命令写出同名文件；配合 expectedVersion 形成乐观锁。
   */
  append(event, expectedVersion) {
    const result = this.appendQueue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const current = (await readdir(this.dir)).filter((name) => name.endsWith('.json')).length;
      if (expectedVersion !== undefined && expectedVersion !== current) {
        return {
          ok: false,
          code: 'concurrent_modification',
          currentVersion: current,
        };
      }
      const file = `${this.dir}/${event.timeKey}.json`;
      await writeFile(file, JSON.stringify(event, null, 2), { flag: 'wx' });
      return { ok: true, version: current + 1 };
    });
    this.appendQueue = result.catch(() => {});
    return result;
  }
}

/** 内存实现，供测试使用。 */
export class MemoryEventStore {
  constructor() {
    this.events = [];
    this.appendQueue = Promise.resolve();
  }

  async readAll() {
    return [...this.events].sort((a, b) => (a.timeKey < b.timeKey ? -1 : 1));
  }

  append(event, expectedVersion) {
    const result = this.appendQueue.then(async () => {
      if (expectedVersion !== undefined && expectedVersion !== this.events.length) {
        return {
          ok: false,
          code: 'concurrent_modification',
          currentVersion: this.events.length,
        };
      }
      if (this.events.some((e) => e.timeKey === event.timeKey)) {
        return { ok: false, code: 'duplicate_time_key' };
      }
      this.events.push(event);
      return { ok: true, version: this.events.length };
    });
    this.appendQueue = result.catch(() => {});
    return result;
  }
}
