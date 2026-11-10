/**
 * Transcript vault: AES-256-GCM encryption for anything spoken into the app.
 *
 * The ledger needs amounts and names in clear to do arithmetic, but raw
 * transcripts are personal data under the DPDP Act, so they are encrypted at
 * rest (key never stored in the repo) and can be purged on demand.
 *
 * Key resolution order:
 *   1. TRANSCRIPT_KEY env var (64 hex chars / 32 bytes)
 *   2. TRANSCRIPT_KEY_FILE path
 *   3. a local key file created with mode 0600 next to the ledger
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PREFIX = 'enc:v1:';

function decodeKey(raw) {
  const value = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const b64 = Buffer.from(value, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('TRANSCRIPT_KEY must be 32 bytes (64 hex chars or base64)');
}

function loadOrCreateKey(keyPath) {
  if (existsSync(keyPath)) {
    return decodeKey(readFileSync(keyPath, 'utf8'));
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

export class TranscriptVault {
  constructor({ key, keyPath } = {}) {
    if (key) {
      this.key = decodeKey(key);
    } else {
      const envKey = process.env.TRANSCRIPT_KEY;
      const envFile = process.env.TRANSCRIPT_KEY_FILE;
      if (envKey) this.key = decodeKey(envKey);
      else if (envFile) this.key = decodeKey(readFileSync(envFile, 'utf8'));
      else this.key = loadOrCreateKey(keyPath || join(process.cwd(), '.bolti-bahi-key'));
    }
  }

  encrypt(plain) {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(value) {
    if (value === null || value === undefined || value === '') return null;
    if (!String(value).startsWith(PREFIX)) {
      // Legacy plaintext row: never echo it as trusted ciphertext.
      return String(value);
    }
    const [ivB64, tagB64, dataB64] = String(value).slice(PREFIX.length).split(':');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }
}

export const _internals = { PREFIX };
