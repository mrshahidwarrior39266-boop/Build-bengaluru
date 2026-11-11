/**
 * Voice Khata - End-to-End Integration Test
 * Simulates noisy, code-mixed shopkeeper utterances and validates ledger behavior
 * Run: node test/test-integration.js
 */

import 'dotenv/config';
import { LedgerDB } from '../lib/ledger-db.js';
import { LLMProcessor } from '../lib/llm-processor.js';
import { parseHindiNumbers } from '../lib/hindi-numbers.js';
import { handleFastQuery } from '../lib/fast-query.js';
import { CompoundTransactionHandler } from '../lib/compound-handler.js';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, 'integration-test.db');

if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

const ledger = new LedgerDB(TEST_DB);
const llm = new LLMProcessor();
const compoundHandler = new CompoundTransactionHandler(ledger);

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

// Test utterances that a shopkeeper would say under store conditions
const testCases = [
  {
    name: 'Simple Hindi credit',
    utterance: 'Ramesh ka teen sau chaalis udhaar',
    expectedAction: 'add_credit',
    expectedCustomer: 'Ramesh',
    expectedAmount: 340
  },
  {
    name: 'Immediate Spoken Correction',
    utterance: 'nahi 430',
    expectedAction: 'correct_entry',
    expectedAmount: 430
  },
  {
    name: 'Payment in Hindi',
    utterance: 'Ramesh ne 200 diye',
    expectedAction: 'add_payment',
    expectedCustomer: 'Ramesh',
    expectedAmount: 200
  },
  {
    name: 'Code-mixed credit with date',
    utterance: 'Suresh ka 500 udhaar hai kal ka',
    expectedAction: 'add_credit',
    expectedCustomer: 'Suresh',
    expectedAmount: 500
  },
  {
    name: 'Fast Balance query',
    utterance: 'Ramesh ka total kitna hai?',
    expectedAction: 'query',
    expectedCustomer: 'Ramesh'
  },
  {
    name: 'Fast Today summary query',
    utterance: 'Aaj kitna udhaar gaya?',
    expectedAction: 'query'
  },
  {
    name: 'English code-mixed credit',
    utterance: 'Mahesh credit seven-fifty rupees',
    expectedAction: 'add_credit',
    expectedCustomer: 'Mahesh',
    expectedAmount: 750
  },
  {
    name: 'Hinglish payment',
    utterance: 'Suresh ne payment kar diya 300 ka',
    expectedAction: 'add_payment',
    expectedCustomer: 'Suresh',
    expectedAmount: 300
  }
];

async function runIntegrationTests() {
  console.log('\n🧪 RUNNING FULL VOICE KHATA E2E INTEGRATION PIPELINE\n');
  console.log(`   Mode: ${process.env.LLM_API_KEY ? 'Cloud LLM (' + llm.provider + ')' : 'Local Zero-Latency Fallback'}`);
  console.log(`   Database: SQLite WAL Mode\n`);

  const conversationHistory = [];
  let lastProcessedCustomer = null;

  for (const tc of testCases) {
    console.log(`\n--- Test: ${tc.name} ---`);
    console.log(`   Input: "${tc.utterance}"`);

    try {
      const normalizedText = parseHindiNumbers(tc.utterance);

      // 1. Fast query check
      const fastQ = handleFastQuery(normalizedText, ledger);
      if (fastQ.matched) {
        assert(tc.expectedAction === 'query', `Query intent recognized: ${fastQ.queryType}`);
        assert(fastQ.spokenResponse && fastQ.spokenResponse.length > 0, `Spoken query response: "${fastQ.spokenResponse}"`);
        continue;
      }

      // 2. Direct correction check
      const corrMatch = normalizedText.match(/(?:nahi|galat|arre\s*nahi)[,\s]+(\d+)/i);
      if (corrMatch) {
        const newAmt = parseInt(corrMatch[1], 10);
        const corrected = ledger.correctLastEntry(null, newAmt);
        assert(tc.expectedAction === 'correct_entry', 'Correction action executed');
        assert(corrected && corrected.amount === newAmt, `Corrected amount: ₹${newAmt}`);
        continue;
      }

      // 3. Process with LLM / local engine
      const customerSummary = ledger.getCustomerSummary();
      const recentEntries = ledger.getRecentEntries(10);

      const result = await llm.process({
        transcript: normalizedText,
        customerSummary,
        recentEntries,
        conversationHistory: conversationHistory.slice(-6),
        pendingCorrection: null
      });

      console.log(`   Processed Output: ${JSON.stringify(result).substring(0, 150)}`);

      // Validate action
      assert(
        result.action === tc.expectedAction,
        `Action: ${result.action} (expected: ${tc.expectedAction})`
      );

      // Validate customer name
      if (tc.expectedCustomer) {
        const nameMatch = result.customerName &&
          result.customerName.toLowerCase().includes(tc.expectedCustomer.toLowerCase());
        assert(nameMatch, `Customer: ${result.customerName} (expected: ${tc.expectedCustomer})`);
      }

      // Validate amount
      if (tc.expectedAmount) {
        assert(
          result.amount === tc.expectedAmount,
          `Amount: ${result.amount} (expected: ${tc.expectedAmount})`
        );
      }

      // Validate spoken confirmation
      assert(
        result.spokenResponse && result.spokenResponse.length > 0,
        `Spoken response: "${result.spokenResponse?.substring(0, 60)}"`
      );

      // Apply to ledger
      if (result.action === 'add_credit' || result.action === 'add_payment') {
        const entry = ledger.addEntry({
          customerName: result.customerName,
          amount: result.amount,
          type: result.action === 'add_credit' ? 'credit' : 'payment',
          date: result.date || new Date().toISOString().split('T')[0],
          note: tc.utterance
        });
        lastProcessedCustomer = result.customerName;
      }

      conversationHistory.push(
        { role: 'user', content: tc.utterance },
        { role: 'assistant', content: result.spokenResponse || '' }
      );
    } catch (err) {
      failed++;
      total++;
      console.log(`  ❌ Error: ${err.message}`);
    }
  }

  // Multi-entry balance check
  console.log('\n--- Final Balance Verifications ---');
  const rameshBal = ledger.getCustomerBalance('Ramesh');
  assert(rameshBal.balance === (430 - 200), `Ramesh final balance: ₹${rameshBal.balance} (corrected from 340 to 430, paid 200)`);

  const sureshBal = ledger.getCustomerBalance('Suresh');
  assert(sureshBal.balance === (500 - 300), `Suresh final balance: ₹${sureshBal.balance} (500 credit - 300 payment)`);

  const maheshBal = ledger.getCustomerBalance('Mahesh');
  assert(maheshBal.balance === 750, `Mahesh final balance: ₹${maheshBal.balance} (750 credit)`);

  cleanup();
}

function cleanup() {
  ledger.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

  console.log('\n' + '═'.repeat(50));
  console.log(`📊 RESULTS: ${passed}/${total} passed, ${failed} failed`);
  console.log('═'.repeat(50));
  
  if (failed > 0) {
    console.log('\n⚠️  Some tests failed!\n');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!\n');
    process.exit(0);
  }
}

runIntegrationTests().catch(err => {
  console.error('Fatal error:', err);
  cleanup();
});
