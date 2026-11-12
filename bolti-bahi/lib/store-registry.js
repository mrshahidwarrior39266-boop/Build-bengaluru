/**
 * Store accounts and their ledgers.
 *
 * Each signed-in shop gets its own SQLite file, so one shop's customers can
 * never appear in another's ledger — isolation is by file, not by a WHERE clause
 * somebody can forget. The pre-existing single-user ledger keeps its path as the
 * "default" store, which is what runs when Google sign-in is not configured.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerDB } from './ledger-db.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class StoreRegistry {
  constructor({ metaPath, dataDir, defaultDbPath, defaultStoreName = '' }) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(metaPath), { recursive: true });

    this.meta = new DatabaseSync(metaPath);
    this.meta.exec('PRAGMA journal_mode = WAL;');
    this.meta.exec(`
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        google_sub TEXT UNIQUE,
        email TEXT,
        owner_name TEXT,
        store_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (store_id) REFERENCES stores(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_store ON sessions(store_id);
    `);

    this.dataDir = dataDir;
    this.defaultDbPath = defaultDbPath;
    this.defaultStoreName = defaultStoreName;
    this.ledgers = new Map();

    this.meta.prepare(`
      INSERT INTO stores (id, google_sub, email, owner_name, store_name)
      VALUES ('default', NULL, NULL, NULL, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(defaultStoreName);
  }

  getStore(id) {
    if (!id) return null;
    return this.meta.prepare('SELECT * FROM stores WHERE id = ?').get(id) || null;
  }

  /** Create or refresh the shop that belongs to one Google account. */
  upsertGoogleStore({ sub, email, name }) {
    const existing = this.meta.prepare('SELECT * FROM stores WHERE google_sub = ?').get(sub);
    if (existing) {
      this.meta.prepare(
        "UPDATE stores SET email = ?, owner_name = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(email || existing.email, name || existing.owner_name, existing.id);
      return this.getStore(existing.id);
    }

    const id = randomUUID();
    this.meta.prepare(`
      INSERT INTO stores (id, google_sub, email, owner_name, store_name)
      VALUES (?, ?, ?, ?, '')
    `).run(id, sub, email || null, name || null);
    return this.getStore(id);
  }

  /** Create or retrieve the shop by email ID so each email has its own isolated ledger. */
  upsertEmailStore({ email, name = '' }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Valid email address daalein.');
    }
    const existing = this.meta.prepare('SELECT * FROM stores WHERE lower(email) = ?').get(cleanEmail);
    if (existing) {
      return this.getStore(existing.id);
    }
    const id = randomUUID();
    const ownerName = name || cleanEmail.split('@')[0];
    this.meta.prepare(`
      INSERT INTO stores (id, google_sub, email, owner_name, store_name)
      VALUES (?, NULL, ?, ?, '')
    `).run(id, cleanEmail, ownerName);
    return this.getStore(id);
  }

  setStoreName(id, storeName) {
    const clean = String(storeName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (clean.length < 2) throw new Error('Dukaan ka naam likhein.');
    this.meta.prepare(
      "UPDATE stores SET store_name = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(clean, id);
    return this.getStore(id);
  }

  createSession(storeId, { ttlMs = SESSION_TTL_MS } = {}) {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + ttlMs).toISOString();
    this.meta.prepare('INSERT INTO sessions (token, store_id, expires_at) VALUES (?, ?, ?)')
      .run(token, storeId, expires);
    return { token, expiresAt: expires };
  }

  getSession(token) {
    if (!token || typeof token !== 'string') return null;
    const row = this.meta.prepare(`
      SELECT s.token, s.expires_at, st.*
      FROM sessions s JOIN stores st ON st.id = s.store_id
      WHERE s.token = ?
    `).get(token);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.destroySession(token);
      return null;
    }
    return row;
  }

  destroySession(token) {
    if (!token) return;
    this.meta.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** One ledger per shop; cached because each open handle is a file watcher. */
  ledgerFor(storeId) {
    const id = storeId || 'default';
    if (this.ledgers.has(id)) return this.ledgers.get(id);
    const path = id === 'default' ? this.defaultDbPath : join(this.dataDir, `${id}.db`);
    const ledger = new LedgerDB(path);
    this.ledgers.set(id, ledger);
    return ledger;
  }

  /** Ledgers currently open, for retention sweeps. */
  allLedgers() {
    return [...this.ledgers.values()];
  }

  close() {
    for (const ledger of this.ledgers.values()) {
      try { ledger.close(); } catch { /* already closed */ }
    }
    this.ledgers.clear();
    try { this.meta.close(); } catch { /* already closed */ }
  }
}
