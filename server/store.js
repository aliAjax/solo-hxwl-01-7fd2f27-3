// 存储层：内存态 + 原子落盘 + 串行事务队列。
// 所有写操作必须经 transact()，保证两人同时操作时串行执行、不会互相覆盖；
// 每次事务完成后同步写盘（tmp + rename），刷新/重启/跨日均不丢状态。
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file, seedFn) {
    this.file = file;
    this._queue = Promise.resolve();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.copyFileSync(file, backup);
        this.state = seedFn();
        this._persist();
      }
    } else {
      this.state = seedFn();
      this._persist();
    }
  }

  _persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file); // 同分区 rename 是原子操作
  }

  // 串行化所有变更：fn 必须是同步函数，在其中直接修改 state 并返回结果。
  transact(fn) {
    const p = this._queue.then(() => {
      const result = fn(this.state);
      this._persist();
      return result;
    });
    this._queue = p.catch(() => {});
    return p;
  }

  read(fn) {
    return fn(this.state);
  }
}
