/**
 * Voice Khata Test Suite
 * Tests ledger logic, disambiguation, corrections, fast queries, number parsing, and compliance
 * Run: node test/test-ledger.js
 */

import { LedgerDB } from '../lib/ledger-db.js';
import { LLMProcessor } from '../lib/llm-processor.js';
import { parseHindiNumbers } from '../lib/hindi-numbers.js';
import { handleFastQuery } from '../lib/fast-query.js';
import { runComplianceAudit, validateReminderCompliance, generatePoliteReminder } from '../lib/compliance.js';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, 'test-khata.db');

// Clean up previous test DB
if (existsSync(TEST_DB)) {
  unlinkSync(TEST_DB);
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
assertEq(customer1Again.id, customer1.id, 'Find existing customer by name');

// Test 3: Case-insensitive search
const customerLower = ledger.findOrCreateCustomer('ramesh');
assertEq(customerLower.id, customer1.id, 'Case-insensitive name matching');

// Test 4: Create second customer
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
  note: 'Ramesh 200 payment'
});
assert(entry2.id, 'Add payment entry');
assertEq(entry2.amount, 200, 'Payment amount correct');

// Test 7: Balance calculation
console.log('\n--- Balance Calculations ---');
const balance1 = ledger.getCustomerBalance('Ramesh');
assertEq(balance1.totalCredit, 340, 'Total credit = 340');
assertEq(balance1.totalPayment, 200, 'Total payment = 200');
assertEq(balance1.balance, 140, 'Balance = 140 (340 - 200)');

// Test 8: Another credit entry
ledger.addEntry({
  customerName: 'Ramesh',
  amount: 500,
  type: 'credit',
  date: today,
  note: 'Ramesh 500 aur'
});
const balance2 = ledger.getCustomerBalance('Ramesh');
assertEq(balance2.balance, 640, 'Updated balance = 640 (840 - 200)');

// Test 9: Correction on last entry with customer name
console.log('\n--- Entry Corrections ---');
const corrected = ledger.correctLastEntry('Ramesh', 430);
assert(corrected !== null, 'Correct last entry');
assertEq(corrected.amount, 430, 'Corrected amount = 430');
assertEq(corrected.corrected_from, 500, 'Corrected from 500');

const balanceAfterCorrection = ledger.getCustomerBalance('Ramesh');
assertEq(balanceAfterCorrection.balance, 570, 'Balance after correction = 570 (770 - 200)');

// Test 9b: Correction without customer name (e.g. "nahi, 430")
const anonymousCorrection = ledger.correctLastEntry(null, 450);
assert(anonymousCorrection !== null, 'Correct last entry anonymously');
assertEq(anonymousCorrection.amount, 450, 'Anonymous corrected amount = 450');

// Test 10: Multiple customers
console.log('\n--- Multiple Customers ---');
ledger.addEntry({
  customerName: 'Suresh',
  amount: 1000,
  type: 'credit',
  date: today,
  note: 'Suresh 1000'
});
ledger.addEntry({
  customerName: 'Suresh',
  amount: 300,
  type: 'payment',
  date: today,
  note: 'Suresh 300 wapas'
});
ledger.addEntry({
  customerName: 'Mahesh',
  amount: 750,
  type: 'credit',
  date: today,
  note: 'Mahesh 750'
});

const summary = ledger.getCustomerSummary();
assert(summary.length >= 3, `Found ${summary.length} customers`);

const sureshBalance = ledger.getCustomerBalance('Suresh');
assertEq(sureshBalance.balance, 700, 'Suresh balance = 700');

// Test 11: Daily summary
console.log('\n--- Daily Summary ---');
const todaySummary = ledger.getTodaySummary();
assert(todaySummary.total_transactions >= 6, `Today has ${todaySummary.total_transactions} transactions`);
assert(todaySummary.total_credit > 0, `Today total credit = ₹${todaySummary.total_credit}`);

// Test 12: Customer name disambiguation (Requirement 4)
console.log('\n--- Disambiguation (Shared Names) ---');
ledger.findOrCreateCustomer('Ramesh Sharma');
ledger.findOrCreateCustomer('Ramesh Chaiwala');
const disambig = ledger.getDisambiguationOptions('Ramesh');
assert(disambig.length >= 2, `Disambiguation options found: ${disambig.join(', ')}`);
assert(disambig.includes('Ramesh Sharma') && disambig.includes('Ramesh Chaiwala'), 'Contains both distinct Ramesh customers');

// ===== INDIC & CODE-MIX NUMBER PARSER TESTS =====
console.log('\n🔢 INDIC & CODE-MIX NUMBER PARSER TESTS\n');

const numberTests = [
  { input: 'Ramesh ka teen sau chaalis udhaar', expected: '340' },
  { input: 'Ramesh ka three-forty udhaar', expected: '340' },
  { input: 'Suresh three forty payment', expected: '340' },
  { input: 'Four-thirty kar do', expected: '430' },
  { input: 'Mahesh dedh sau rupay', expected: '150' },
  { input: 'Dhai sau jama', expected: '250' },
  { input: 'Sawa sau udhar', expected: '125' },
  { input: 'Paune do sau likho', expected: '175' },
  { input: 'Ramesh ka 340 udhaar', expected: '340' },
  { input: 'Do hazaar paanch sau', expected: '2500' }
];

for (const nt of numberTests) {
  const result = parseHindiNumbers(nt.input);
  assert(result.includes(nt.expected), `Parsed "${nt.input}" -> contains "${nt.expected}" (got: "${result}")`);
}

// ===== FAST QUERY ENGINE TESTS (< 50ms) =====
console.log('\n⚡ FAST QUERY ENGINE TESTS\n');

const q1 = handleFastQuery('Aaj kitna udhaar gaya?', ledger);
assert(q1.matched === true, 'Matches today credit query');
assert(q1.spokenResponse.includes('rupay'), `Spoken response generated: "${q1.spokenResponse}"`);

const q2 = handleFastQuery('Aaj kitna jama hua?', ledger);
assert(q2.matched === true, 'Matches today payment query');

const q3 = handleFastQuery('Suresh ka total?', ledger);
assert(q3.matched === true, 'Matches customer balance query');
assert(q3.spokenResponse.includes('Suresh') && q3.spokenResponse.includes('700'), `Customer total response: "${q3.spokenResponse}"`);

const q4 = handleFastQuery('Dukaan ka kul baaki kitna hai?', ledger);
assert(q4.matched === true, 'Matches total shop balance query');

// ===== RESPONSIBLE AI & COMPLIANCE TESTS =====
console.log('\n🛡️ RESPONSIBLE AI & COMPLIANCE TESTS\n');

const audit = runComplianceAudit();
assert(audit.aiDisclosureImplemented === true, 'AI first-turn disclosure implemented');
assert(audit.reminderPoliteAndCompliant === true, 'Default reminder is polite & non-coercive');

// Threat detection test
const politeMsg = generatePoliteReminder('Ramesh', 340);
assert(validateReminderCompliance(politeMsg).valid === true, 'Polite reminder passes compliance');

const threateningMsg = 'Ramesh turant paisa do varna police case kar dunga';
const threatCheck = validateReminderCompliance(threateningMsg);
assert(threatCheck.valid === false, 'Threatening language correctly flagged');
assert(threatCheck.violations.includes('police'), 'Identified "police" violation');

// ===== LLM PROCESSOR TESTS (parse logic only) =====
console.log('\n🧠 LLM RESPONSE PARSER TESTS\n');

const llm = new LLMProcessor();

// Test parse valid JSON
const validResult = llm._parseResponse(JSON.stringify({
  action: 'add_credit',
  customerName: 'Ramesh',
  amount: 340,
  date: today,
  spokenResponse: 'Ramesh ka 340 likh diya'
}));
assertEq(validResult.action, 'add_credit', 'Parse valid credit action');
assertEq(validResult.amount, 340, 'Parse amount as number');

// Test parse JSON with markdown wrapping
const markdownResult = llm._parseResponse('```json\n{"action":"add_payment","customerName":"Suresh","amount":"500","spokenResponse":"ok"}\n```');
assertEq(markdownResult.action, 'add_payment', 'Parse markdown-wrapped JSON');
assertEq(markdownResult.amount, 500, 'String amount converted to number');

// Test parse correction
const correctionResult = llm._parseResponse(JSON.stringify({
  action: 'correct_entry',
  customerName: 'Ramesh',
  newAmount: 430,
  spokenResponse: '430 kar diya'
}));
assertEq(correctionResult.action, 'correct_entry', 'Parse correction action');
assertEq(correctionResult.newAmount, 430, 'newAmount parsed correctly');

// Test parse query
const queryResult = llm._parseResponse(JSON.stringify({
  action: 'query',
  queryResult: { type: 'customer_balance' },
  spokenResponse: 'Ramesh ka 570 baaki hai'
}));
assertEq(queryResult.action, 'query', 'Parse query action');
assert(queryResult.queryResult.type === 'customer_balance', 'Query type parsed');

// Test parse invalid JSON
const invalidResult = llm._parseResponse('this is not json at all');
assertEq(invalidResult.action, 'error', 'Invalid JSON returns error action');

// Test parse empty
const emptyResult = llm._parseResponse('{}');
assertEq(emptyResult.action, 'error', 'Empty object returns error (no action)');

// ===== CLEANUP =====
ledger.close();
if (existsSync(TEST_DB)) {
  unlinkSync(TEST_DB);
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
