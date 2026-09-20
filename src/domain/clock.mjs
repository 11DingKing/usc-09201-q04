/**
 * 单调混合时钟：先按时间排序，同一时刻用计数器打破平局，保证命令串行执行时
 * 事件序号与事件时间顺序一致，乱序送达的机构回执也能被放到确定位置上重放。
 */
export function createClock() {
  let counter = 0;
  return {
    now() {
      counter += 1;
      return { t: Date.now(), seq: counter };
    },
  };
}

export function compareTime(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  return a.seq - b.seq;
}

export function timeKey(time) {
  return `${time.t.toString().padStart(16, '0')}-${time.seq.toString().padStart(10, '0')}`;
}
