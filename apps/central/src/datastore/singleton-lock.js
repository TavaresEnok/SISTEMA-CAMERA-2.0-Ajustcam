'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

class JsonInstanceLock {
  constructor(lockFile) {
    this.lockFile = path.resolve(lockFile);
    this.handle = null;
  }

  async acquire() {
    if (this.handle) return;
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    let handle;
    try {
      handle = await fs.open(this.lockFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const lockError = new Error(
          `Outra instância da DRAC Central já possui ${this.lockFile}. ` +
          'Se o processo anterior terminou de forma não limpa, confirme que ele está parado antes de remover somente esse lock.',
        );
        lockError.code = 'CENTRAL_INSTANCE_LOCKED';
        throw lockError;
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      }), { encoding: 'utf8' });
      await handle.sync();
      this.handle = handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(this.lockFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async release() {
    if (!this.handle) return;
    const handle = this.handle;
    this.handle = null;
    await handle.close().catch(() => undefined);
    await fs.rm(this.lockFile, { force: true });
  }
}

module.exports = { JsonInstanceLock };
