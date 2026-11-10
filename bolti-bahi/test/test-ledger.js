/**
 * Bolti Bahi Test Suite
 * Tests ledger logic, LLM processing, and number parsing
 * Run: node test/test-ledger.js
 */

import { LedgerDB } from '../lib/ledger-db.js';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, 'test-bolti-bahi.db');

// Clean up previous test DB
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
}

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, testName) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName}`);
  }
}

function assertEq(actual, expected, testName) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName} — expected: ${expected}, got: ${actual}`);
  }
}

function assertClose(actual, expected, tolerance, testName) {
  total++;
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName} — expected ~${expected}, got: ${actual}`);
  }
}

// ===== LEDGER DB TESTS =====
console.log('\n📒 LEDGER DATABASE TESTS\n');

const ledger = new LedgerDB(TEST_DB);

// Test 1: Create customer
console.log('--- Customer Management ---');
const customer1 = ledger.findOrCreateCustomer('Ramesh');
assert(customer1.id, 'Create customer Ramesh');
assert(customer1.normalized_name === 'ramesh', 'Name normalized correctly');

// Test 2: Find existing customer
const customer1Again = ledger.findOrCreateCustomer('Ramesh');
assertEq(customer1.id, customer1Again.id, 'Find existing customer by name');

// Test 3: Case-insensitive matching
const customer1Upper = ledger.findOrCreateCustomer('RAMESH');
assertEq(customer1.id, customer1Upper.id, 'Case-insensitive name matching');

// Test 4: Create different customer
const customer2 = ledger.findOrCreateCustomer('Suresh');
assert(customer2.id !== customer1.id, 'Create different customer Suresh');

// Test 5: Add credit entry
console.log('\n--- Ledger Entries ---');
const today = new Date().toISOString().split('T')[0];
const entry1 = ledger.addEntry({
  customerName: 'Ramesh',
  amount: 340,
  type: 'credit',
  date: today,
  note: 'Ramesh ka 340 udhaar'
});
assert(entry1.id, 'Add credit entry');
assertEq(entry1.amount, 340, 'Credit amount correct');
assertEq(entry1.type, 'credit', 'Entry type is credit');

// Test 6: Add payment entry
const entry2 = ledger.addEntry({
  customerName: 'Ramesh',
  amount: 200,
  type: 'payment',
  date: today,
  note: 'Ramesh ne 200 diya'
});
assert(entry2.id, 'Add payment entry');
assertEq(entry2.amount, 200, 'Payment amount correct');

// Test 7: Check balance
console.log('\n--- Balance Calculations ---');
const balance = ledger.getCustomerBalance('Ramesh');
assertEq(balance.totalCredit, 340, 'Total credit = 340');
assertEq(balance.totalPayment, 200, 'Total payment = 200');
assertEq(balance.balance, 140, 'Balance = 140 (340 - 200)');

// Test 8: Add more entries
ledger.addEntry({
  customerName: 'Ramesh',
  amount: 500,
  type: 'credit',
  date: today,
  note: 'Ramesh ka 500 aur udhaar'
});
const balance2 = ledger.getCustomerBalance('Ramesh');
assertEq(balance2.balance, 640, 'Updated balance = 640 (840 - 200)');

// Test 9: Correct entry
console.log('\n--- Entry Corrections ---');
const corrected = ledger.correctLastEntry('Ramesh', 430);
assert(corrected, 'Correct last entry');
assertEq(corrected.amount, 430, 'Corrected amount = 430');
assertEq(corrected.corrected_from, 500, 'Corrected from 500');
const balance3 = ledger.getCustomerBalance('Ramesh');
assertEq(balance3.balance, 570, 'Balance after correction = 570 (770 - 200)');

// Test 10: Multiple customers
console.log('\n--- Multiple Customers ---');
ledger.addEntry({ customerName: 'Suresh', amount: 1000, type: 'credit', date: today, note: 'test' });
ledger.addEntry({ customerName: 'Mahesh', amount: 750, type: 'credit', date: today, note: 'test' });
ledger.addEntry({ customerName: 'Suresh', amount: 300, type: 'payment', date: today, note: 'test' });

const summary = ledger.getCustomerSummary();
assert(summary.length >= 3, `Found ${summary.length} customers`);

const sureshSummary = summary.find(s => s.customer_name === 'Suresh');
assertEq(sureshSummary.balance, 700, 'Suresh balance = 700');

// Test 11: Today's summary
console.log('\n--- Daily Summary ---');
const todaySummary = ledger.getTodaySummary();
assert(todaySummary.total_transactions > 0, `Today has ${todaySummary.total_transactions} transactions`);
assert(todaySummary.total_credit > 0, `Today total credit = ₹${todaySummary.total_credit}`);

// Test 12: Recent entries
const recent = ledger.getRecentEntries(5);
assertEq(recent.length, 5, 'Recent entries returns 5');

// Test 13: Customer entries
const rameshEntries = ledger.getCustomerEntries('Ramesh');
assert(rameshEntries.length >= 3, `Ramesh has ${rameshEntries.length} entries`);

// Test 14: Similar customer search
console.log('\n--- Name Matching ---');
const similar = ledger.findSimilarCustomers('esh');
assert(similar.length >= 2, `Found ${similar.length} customers matching "esh"`);

// ===== CLEANUP =====
ledger.close();
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
}

// ===== SUMMARY =====
console.log('\n' + '═'.repeat(50));
console.log(`📊 TEST RESULTS: ${passed}/${total} passed, ${failed} failed`);
console.log('═'.repeat(50));

if (failed > 0) {
  console.log('\n⚠️  Some tests failed!');
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!\n');
  process.exit(0);
}
