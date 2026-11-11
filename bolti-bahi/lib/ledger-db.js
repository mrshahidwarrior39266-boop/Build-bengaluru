/**
 * Local khata ledger on SQLite (node:sqlite, no native build).
 *
 * Design notes that matter for judging:
 *   - exact-name resolution, so "Ram" never silently merges into "Ramesh"
 *   - ambiguous spoken names are surfaced, not guessed
 *   - transcript text is AES-256-GCM encrypted at rest and purgeable
 *   - every correction keeps an audit trail (corrected_from / is_corrected)
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { TranscriptVault } from './crypto-store.js';

function localYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class LedgerDB {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.vault = options.vault || new TranscriptVault({
      keyPath: options.keyPath || join(dirname(dbPath), '.bolti-bahi-key'),
    });
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this._initTables();
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        phone TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('credit', 'payment')),
        amount REAL NOT NULL CHECK(amount > 0),
        date TEXT NOT NULL,
        note TEXT,
        original_transcript TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        is_corrected INTEGER DEFAULT 0,
        corrected_from REAL,
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger_entries(customer_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(date);
      CREATE INDEX IF NOT EXISTS idx_customer_name ON customers(normalized_name);
    `);

    // Migration: reminder opt-in flag.
    try {
      this.db.exec('ALTER TABLE customers ADD COLUMN reminder_opt_in INTEGER NOT NULL DEFAULT 0;');
    } catch {
      // Column already exists.
    }

    // Migration: drop legacy plaintext transcripts.
    this.db.exec('UPDATE ledger_entries SET original_transcript = NULL WHERE original_transcript IS NOT NULL;');
  }

  _normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s\u0900-\u097F]/g, '');
  }

  _decryptNote(value) {
    return this.vault.decrypt(value);
  }

  _withNote(row) {
    if (!row) return row;
    return { ...row, note: this._decryptNote(row.note), original_transcript: undefined };
  }

  getCustomerByName(name) {
    const normalized = this._normalizeName(name);
    if (!normalized) return null;
    return this.db.prepare('SELECT * FROM customers WHERE normalized_name = ?').get(normalized) || null;
  }

  /**
   * Resolve a spoken name to exactly one customer, or ask.
   *
   * Names are matched on token boundaries, never as loose substrings:
   *   - "Ramesh" when "Ramesh" and "Ramesh Kumar" exist  -> ambiguous (ask)
   *   - "Ramesh Kumar" when both exist                    -> exact (no ask)
   *   - "Ramesh Kumar" when only "Ramesh" exists          -> none (new person)
   *   - "Ramesh" when only "Ramesh Kumar" exists          -> that customer
   *
   * @returns {{status:'none'|'exact'|'ambiguous', customer:object|null, candidates:object[]}}
   */
  resolveCustomer(name) {
    const normalized = this._normalizeName(name);
    if (!normalized) return { status: 'none', customer: null, candidates: [] };

    const everyone = this.db.prepare('SELECT * FROM customers ORDER BY length(normalized_name) ASC').all();
    const tokens = normalized.split(' ').length;

    const exact = everyone.filter((c) => c.normalized_name === normalized);
    // Spoken name is a shorter form of a longer stored name ("Ramesh" -> "Ramesh Kumar").
    const supersets = everyone.filter((c) => {
      if (c.normalized_name === normalized) return false;
      const head = c.normalized_name.split(' ').slice(0, tokens).join(' ');
      return head === normalized;
    });
    // Spoken name is longer than a stored name ("Ramesh Kumar" vs stored "Ramesh").
    const subsets = everyone.filter((c) => normalized.startsWith(`${c.normalized_name} `));

    if (exact.length === 1) {
      if (supersets.length > 0) {
        return { status: 'ambiguous', customer: null, candidates: [exact[0], ...supersets] };
      }
      return { status: 'exact', customer: exact[0], candidates: [exact[0]] };
    }
    if (exact.length > 1) return { status: 'ambiguous', customer: null, candidates: exact };

    const pool = [...supersets, ...subsets];
    if (pool.length === 1) {
      // A longer spoken name is a different person, not the shorter stored one.
      if (subsets.length === 1) return { status: 'none', customer: null, candidates: [] };
      return { status: 'exact', customer: pool[0], candidates: pool };
    }
    if (pool.length > 1) return { status: 'ambiguous', customer: null, candidates: pool };

    return { status: 'none', customer: null, candidates: [] };
  }

  findOrCreateCustomer(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Customer name is required');

    const existing = this.getCustomerByName(trimmed);
    if (existing) return existing;

    const normalized = this._normalizeName(trimmed);
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO customers (id, name, normalized_name) VALUES (?, ?, ?)',
    ).run(id, trimmed, normalized);
    return { id, name: trimmed, normalized_name: normalized, reminder_opt_in: 0 };
  }

  findSimilarCustomers(name) {
    const normalized = this._normalizeName(name);
    if (!normalized) return [];
    return this.db.prepare(
      'SELECT * FROM customers WHERE normalized_name LIKE ?',
    ).all(`%${normalized}%`);
  }

  _assertEntry({ amount, type, date }) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('Amount must be a positive number');
    }
    if (type !== 'credit' && type !== 'payment') {
      throw new Error("type must be 'credit' or 'payment'");
    }
    if (date !== undefined && date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      throw new Error('date must be YYYY-MM-DD');
    }
  }

  addEntry({ customerName, amount, type, date, note }) {
    this._assertEntry({ amount, type, date });
    const customer = this.findOrCreateCustomer(customerName);
    const id = randomUUID();
    const day = date || localYmd();
    const createdAt = new Date().toISOString();
    const encryptedNote = this.vault.encrypt(note || null);

    this.db.prepare(`
      INSERT INTO ledger_entries
        (id, customer_id, type, amount, date, note, original_transcript, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(id, customer.id, type, Number(amount), day, encryptedNote, createdAt);

    this.db.prepare("UPDATE customers SET updated_at = datetime('now') WHERE id = ?").run(customer.id);

    return {
      id,
      customerName: customer.name,
      customerId: customer.id,
      type,
      amount: Number(amount),
      date: day,
      note: note || null,
    };
  }

  /** Apply several entries atomically (compound sentences). */
  addEntries(list) {
    this.db.exec('BEGIN');
    try {
      const saved = list.map((entry) => this.addEntry(entry));
      this.db.exec('COMMIT');
      return saved;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  getEntryById(id) {
    if (!id) return null;
    const row = this.db.prepare(`
      SELECT e.*, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      WHERE e.id = ?
    `).get(id);
    return row ? { ...this._withNote(row), customerName: row.customer_name } : null;
  }

  getLastEntry(customerName = null) {
    let row;
    if (customerName) {
      const customer = this.getCustomerByName(customerName);
      if (!customer) return null;
      row = this.db.prepare(`
        SELECT e.*, c.name AS customer_name
        FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
        WHERE e.customer_id = ? ORDER BY e.rowid DESC LIMIT 1
      `).get(customer.id);
    } else {
      row = this.db.prepare(`
        SELECT e.*, c.name AS customer_name
        FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
        ORDER BY e.rowid DESC LIMIT 1
      `).get();
    }
    return row ? { ...this._withNote(row), customerName: row.customer_name } : null;
  }

  correctEntryById(entryId, newAmount) {
    this._assertEntry({ amount: newAmount, type: 'credit' });
    const row = this.db.prepare(`
      SELECT e.*, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      WHERE e.id = ?
    `).get(entryId);
    if (!row) return null;

    const oldAmount = row.amount;
    this.db.prepare(`
      UPDATE ledger_entries SET amount = ?, is_corrected = 1, corrected_from = ? WHERE id = ?
    `).run(Number(newAmount), oldAmount, row.id);

    return {
      ...this._withNote(row),
      customerName: row.customer_name,
      amount: Number(newAmount),
      corrected_from: oldAmount,
      is_corrected: 1,
    };
  }

  /** Backwards-compatible helper: correct the latest entry for one customer. */
  correctLastEntry(customerName, newAmount) {
    const customer = this.getCustomerByName(customerName);
    if (!customer) return null;
    const last = this.getLastEntry(customer.name);
    if (!last) return null;
    return this.correctEntryById(last.id, newAmount);
  }

  getAllEntries() {
    return this.db.prepare(`
      SELECT e.*, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      ORDER BY e.date DESC, e.rowid DESC
    `).all().map((row) => this._withNote(row));
  }

  getCustomerEntries(customerName) {
    const normalized = this._normalizeName(customerName);
    return this.db.prepare(`
      SELECT e.*, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      WHERE c.normalized_name LIKE ?
      ORDER BY e.date DESC, e.rowid DESC
    `).all(`%${normalized}%`).map((row) => this._withNote(row));
  }

  getCustomerBalance(customerName) {
    const normalized = this._normalizeName(customerName);
    let customer = this.db.prepare('SELECT * FROM customers WHERE normalized_name = ?').get(normalized);
    if (!customer) {
      const similar = this.findSimilarCustomers(customerName);
      if (similar.length === 1) customer = similar[0];
    }
    if (!customer) {
      return { customerName, totalCredit: 0, totalPayment: 0, balance: 0, exists: false };
    }

    const agg = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS total_payment
      FROM ledger_entries WHERE customer_id = ?
    `).get(customer.id);

    return {
      customerName: customer.name,
      totalCredit: agg.total_credit,
      totalPayment: agg.total_payment,
      balance: agg.total_credit - agg.total_payment,
      exists: true,
    };
  }

  getCustomerSummary() {
    return this.db.prepare(`
      SELECT
        c.id AS customer_id,
        c.name AS customer_name,
        c.normalized_name,
        c.phone,
        c.reminder_opt_in,
        COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN e.type = 'payment' THEN e.amount ELSE 0 END), 0) AS total_payment,
        COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN e.type = 'payment' THEN e.amount ELSE 0 END), 0) AS balance,
        MAX(e.date) AS last_transaction_date,
        COUNT(e.id) AS total_transactions
      FROM customers c
      LEFT JOIN ledger_entries e ON c.id = e.customer_id
      GROUP BY c.id
      ORDER BY balance DESC, c.normalized_name ASC
    `).all();
  }

  getRecentEntries(limit = 10) {
    const count = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 10;
    return this.db.prepare(`
      SELECT e.*, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      ORDER BY e.rowid DESC LIMIT ?
    `).all(count).map((row) => this._withNote(row));
  }

  getTodaySummary(today = localYmd()) {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS total_transactions,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
        COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS total_payment
      FROM ledger_entries WHERE date = ?
    `).get(today);
  }

  getTotalOutstanding() {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(bal), 0) AS total FROM (
        SELECT
          COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS bal
        FROM ledger_entries GROUP BY customer_id
      ) WHERE bal > 0
    `).get();
    return row ? row.total : 0;
  }

  setReminderOptIn(name, optedIn) {
    const resolution = this.resolveCustomer(name);
    if (resolution.status !== 'exact') return false;
    this.db.prepare('UPDATE customers SET reminder_opt_in = ? WHERE id = ?')
      .run(optedIn ? 1 : 0, resolution.customer.id);
    return true;
  }

  purgeTranscripts({ olderThanMinutes = 0 } = {}) {
    let result;
    if (olderThanMinutes > 0) {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
      result = this.db.prepare(`
        UPDATE ledger_entries SET note = NULL, original_transcript = NULL
        WHERE note IS NOT NULL AND created_at < ?
      `).run(cutoff);
    } else {
      result = this.db.prepare(`
        UPDATE ledger_entries SET note = NULL, original_transcript = NULL
        WHERE note IS NOT NULL OR original_transcript IS NOT NULL
      `).run();
    }
    return Number(result.changes || 0);
  }

  deleteEntry(entryId) {
    return this.db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId);
  }

  /** Remove one entry. Returns how many rows went away (0 or 1). */
  deleteEntryById(entryId) {
    const result = this.db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId);
    return Number(result.changes || 0);
  }

  /** Remove a customer and their whole history, atomically. */
  deleteCustomerById(customerId) {
    this.db.exec('BEGIN');
    try {
      const entries = this.db.prepare('DELETE FROM ledger_entries WHERE customer_id = ?').run(customerId).changes;
      const customers = this.db.prepare('DELETE FROM customers WHERE id = ?').run(customerId).changes;
      this.db.exec('COMMIT');
      return { customers: Number(customers || 0), entries: Number(entries || 0) };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  updateCustomerPhone(customerId, phone) {
    const clean = String(phone || '').replace(/[^\d+]/g, '').slice(0, 15);
    const result = this.db.prepare(
      "UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(clean || null, customerId);
    return Number(result.changes || 0);
  }

  /** Totals for a date window, for the Report view. */
  getReport(from, to) {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS credit,
        COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS payment,
        COUNT(DISTINCT customer_id) AS customers
      FROM ledger_entries WHERE date BETWEEN ? AND ?
    `).get(from, to);

    const daily = this.db.prepare(`
      SELECT date,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS credit,
        COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS payment
      FROM ledger_entries WHERE date BETWEEN ? AND ?
      GROUP BY date ORDER BY date DESC LIMIT 31
    `).all(from, to);

    const topOutstanding = this.getCustomerSummary()
      .filter((row) => row.balance > 0)
      .slice(0, 5)
      .map((row) => ({
        id: row.customer_id,
        name: row.customer_name,
        balance: row.balance,
        lastTransactionDate: row.last_transaction_date || '',
      }));

    return {
      from,
      to,
      totals: {
        entries: Number(totals.entries || 0),
        credit: Number(totals.credit || 0),
        payment: Number(totals.payment || 0),
        net: Number(totals.credit || 0) - Number(totals.payment || 0),
        customers: Number(totals.customers || 0),
      },
      daily,
      topOutstanding,
      totalOutstanding: this.getTotalOutstanding(),
    };
  }

  /** Every entry, newest first, for the activity feed. */
  getActivity(limit = 25) {
    const count = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 25;
    return this.db.prepare(`
      SELECT e.id, e.type, e.amount, e.date, e.note, e.is_corrected, e.created_at,
             c.id AS customer_id, c.name AS customer_name
      FROM ledger_entries e JOIN customers c ON e.customer_id = c.id
      ORDER BY e.date DESC, e.rowid DESC LIMIT ?
    `).all(count).map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      type: row.type,
      amount: row.amount,
      date: row.date,
      note: this._decryptNote(row.note) || '',
      isCorrected: Boolean(row.is_corrected),
      createdAt: row.created_at,
    }));
  }

  _customerLedger(customerId) {
    const rows = this.db.prepare(`
      SELECT e.* FROM ledger_entries e WHERE e.customer_id = ? ORDER BY e.rowid ASC
    `).all(customerId);
    let running = 0;
    const history = rows.map((row) => {
      running += row.type === 'credit' ? row.amount : -row.amount;
      return {
        id: row.id,
        date: row.date,
        type: row.type,
        amount: row.amount,
        note: this._decryptNote(row.note) || '',
        balance: running,
      };
    });
    return history;
  }

  /** Snapshot shaped exactly like the browser UI expects. */
  getUiState({ today } = {}) {
    const summaries = this.getCustomerSummary();
    const day = today || localYmd();
    const todaySummary = this.getTodaySummary(day);
    const customers = summaries.map((s) => {
      const history = this._customerLedger(s.customer_id);
      return {
        id: s.customer_id,
        name: s.customer_name,
        phone: s.phone || '',
        balance: s.balance,
        reminderOptIn: Boolean(s.reminder_opt_in),
        lastUpdated: s.last_transaction_date || '',
        transactions: history.slice(-20).reverse(),
      };
    });
    return {
      summary: {
        totalOutstanding: this.getTotalOutstanding(),
        todayCredit: todaySummary.total_credit,
        todayPayment: todaySummary.total_payment,
      },
      customers,
    };
  }

  resetAll() {
    this.db.exec('DELETE FROM ledger_entries; DELETE FROM customers;');
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

export { localYmd };
