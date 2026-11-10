/**
 * Server-side store for a Gnani API key entered from the app.
 *
 * Security rules:
 * - the key is never sent back to the browser, logged, or written to the ledger DB;
 * - the file is created with mode 0600 next to the ledger;
 * - an environment key wins and cannot be overridden from the UI;
 * - the caller can only learn whether a key exists, and where it came from.
 */

import { readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GNANI_KEY_FILENAME = '.gnani-key';

export class KeyStore {
  constructor({ file = join(process.cwd(), GNANI_KEY_FILENAME), envKey = process.env.GNANI_API_KEY || '' } = {}) {
    this.file = file;
    this.envKey = String(envKey || '').trim();
  }

  get() {
    if (this.envKey) return this.envKey;
    return this._read();
  }

  /** 'environment' | 'app' | 'none' */
  source() {
    if (this.envKey) return 'environment';
    return this._read() ? 'app' : 'none';
  }

  _read() {
    try {
      return readFileSync(this.file, 'utf8').trim();
    } catch {
      return '';
    }
  }

  set(key) {
    const value = String(key || '').trim();
    if (!value) throw new Error('Key khali hai.');
    if (value.length < 20 || value.length > 300 || !/^[\x21-\x7e]+$/.test(value)) {
      throw new Error('Key ka format theek nahi lag raha.');
    }

    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${value}\n`, { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    return true;
  }

  clear() {
    if (!existsSync(this.file)) return false;
    try {
      unlinkSync(this.file);
      return true;
    } catch {
      return false;
    }
  }
}
