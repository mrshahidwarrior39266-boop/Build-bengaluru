import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';

export class LedgerDB {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
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
  }

  // Normalize name for matching (handles Hindi/English variations)
  _normalizeName(name) {
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s\u0900-\u097F]/g, ''); // Keep Devanagari + alphanumeric
  }

  // Find or create customer by name (fuzzy matching)
  findOrCreateCustomer(name) {
    const normalized = this._normalizeName(name);
    
    // Try exact match first
    let customer = this.db.prepare(
      'SELECT * FROM customers WHERE normalized_name = ?'
    ).get(normalized);

    if (customer) return customer;

    // Try partial match (for name variations)
    customer = this.db.prepare(
      'SELECT * FROM customers WHERE normalized_name LIKE ? OR ? LIKE normalized_name || \'%\''
    ).get(`%${normalized}%`, normalized);

    if (customer) return customer;

    // Create new customer
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO customers (id, name, normalized_name) VALUES (?, ?, ?)'
    ).run(id, name.trim(), normalized);

    return { id, name: name.trim(), normalized_name: normalized };
  }

  // Find similar customer names (for clarification)
  findSimilarCustomers(name) {
    const normalized = this._normalizeName(name);
    return this.db.prepare(
      'SELECT * FROM customers WHERE normalized_name LIKE ?'
    ).all(`%${normalized}%`);
  }

  // Add a ledger entry
  addEntry({ customerName, amount, type, date, note }) {
    const customer = this.findOrCreateCustomer(customerName);
    const id = randomUUID();
    
    this.db.prepare(`
      INSERT INTO ledger_entries (id, customer_id, type, amount, date, note, original_transcript)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, customer.id, type, amount, date, note, note);

    // Update customer timestamp
    this.db.prepare(
      'UPDATE customers SET updated_at = datetime(\'now\') WHERE id = ?'
    ).run(customer.id);

    return {
      id,
      customerName: customer.name,
      customerId: customer.id,
      type,
      amount,
      date,
      note
    };
  }

  // Correct the last entry for a customer
  correctLastEntry(customerName, newAmount) {
    const customer = this.findOrCreateCustomer(customerName);
    const lastEntry = this.db.prepare(`
      SELECT rowid, * FROM ledger_entries 
      WHERE customer_id = ? 
      ORDER BY rowid DESC 
      LIMIT 1
    `).get(customer.id);

    if (!lastEntry) return null;

    const oldAmount = lastEntry.amount;
    this.db.prepare(`
      UPDATE ledger_entries 
      SET amount = ?, is_corrected = 1, corrected_from = ?
      WHERE id = ?
    `).run(newAmount, oldAmount, lastEntry.id);

    return {
      ...lastEntry,
      amount: newAmount,
      corrected_from: oldAmount,
      customerName: customer.name
    };
  }

  // Get all ledger entries
  getAllEntries() {
    return this.db.prepare(`
      SELECT e.*, c.name as customer_name
      FROM ledger_entries e
      JOIN customers c ON e.customer_id = c.id
      ORDER BY e.date DESC, e.rowid DESC
    `).all();
  }

  // Get all entries for a customer
  getCustomerEntries(customerName) {
    const normalized = this._normalizeName(customerName);
    return this.db.prepare(`
      SELECT e.*, c.name as customer_name 
      FROM ledger_entries e
      JOIN customers c ON e.customer_id = c.id
      WHERE c.normalized_name LIKE ?
      ORDER BY e.date DESC, e.rowid DESC
    `).all(`%${normalized}%`);
  }

  // Get customer balance (credit - payments)
  getCustomerBalance(customerName) {
    const normalized = this._normalizeName(customerName);
    const result = this.db.prepare(`
      SELECT 
        c.name as customer_name,
        COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN e.type = 'payment' THEN e.amount ELSE 0 END), 0) as total_payment
      FROM customers c
      LEFT JOIN ledger_entries e ON c.id = e.customer_id
      WHERE c.normalized_name LIKE ?
      GROUP BY c.id
    `).get(`%${normalized}%`);

    if (!result) return { customerName, totalCredit: 0, totalPayment: 0, balance: 0 };

    return {
      customerName: result.customer_name,
      totalCredit: result.total_credit,
      totalPayment: result.total_payment,
      balance: result.total_credit - result.total_payment
    };
  }

  // Get all customer summaries
  getCustomerSummary() {
    return this.db.prepare(`
      SELECT 
        c.name as customer_name,
        c.normalized_name,
        COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN e.type = 'payment' THEN e.amount ELSE 0 END), 0) as total_payment,
        COALESCE(SUM(CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END), 0) - 
        COALESCE(SUM(CASE WHEN e.type = 'payment' THEN e.amount ELSE 0 END), 0) as balance,
        MAX(e.date) as last_transaction_date,
        COUNT(e.id) as total_transactions
      FROM customers c
      LEFT JOIN ledger_entries e ON c.id = e.customer_id
      GROUP BY c.id
      ORDER BY balance DESC
    `).all();
  }

  // Get recent entries
  getRecentEntries(limit = 10) {
    return this.db.prepare(`
      SELECT e.*, c.name as customer_name
      FROM ledger_entries e
      JOIN customers c ON e.customer_id = c.id
      ORDER BY e.rowid DESC
      LIMIT ?
    `).all(limit);
  }

  // Get today's summary
  getTodaySummary() {
    const today = new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) as total_payment
      FROM ledger_entries
      WHERE date = ?
    `).get(today);
  }

  // Delete an entry
  deleteEntry(entryId) {
    return this.db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId);
  }

  close() {
    this.db.close();
  }
}
