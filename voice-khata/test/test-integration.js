/**
 * Voice Khata - End-to-End Integration Test
 * Simulates shopkeeper utterances and validates ledger behavior
 * Run: node test/test-integration.js
 */

import 'dotenv/config';
import { LedgerDB } from '../lib/ledger-db.js';
import { LLMProcessor } from '../lib/llm-processor.js';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, 'integration-test.db');

if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

const ledger = new LedgerDB(TEST_DB);
const llm = new LLMProcessor();

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

// Test utterances that a shopkeeper would say
const testCases = [
  {
    name: 'Simple Hindi credit',
    utterance: 'Ramesh ka 340 udhaar',
    expectedAction: 'add_credit',
    expectedCustomer: 'Ramesh',
    expectedAmount: 340
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
    name: 'Correction',
    utterance: 'nahi 430',
    expectedAction: 'correct_entry'
  },
  {
    name: 'Balance query',
    utterance: 'Ramesh ka total kitna hai?',
    expectedAction: 'query',
    expectedCustomer: 'Ramesh'
  },
  {
    name: 'Today summary query',
    utterance: 'Aaj kitna udhaar gaya?',
    expectedAction: 'query'
  },
  {
    name: 'English credit',
    utterance: 'Mahesh credit 750 rupees',
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
  if (!process.env.LLM_API_KEY) {
    console.log('\n⚠️  LLM_API_KEY not set in .env — skipping LLM integration tests');
    console.log('   Set LLM_API_KEY to run full integration tests\n');
    
    // Run offline tests only
    console.log('📒 Running offline ledger tests...\n');
    
    // Test compound transaction handling
    const e1 = ledger.addEntry({ customerName: 'Ramesh', amount: 340, type: 'credit', date: '2024-01-15', note: 'test' });
    assert(e1.amount === 340, 'Credit entry: ₹340');
    
    const e2 = ledger.addEntry({ customerName: 'Ramesh', amount: 200, type: 'payment', date: '2024-01-14', note: 'test' });
    assert(e2.amount === 200, 'Payment entry: ₹200');
    
    const bal = ledger.getCustomerBalance('Ramesh');
    assert(bal.balance === 140, `Balance correct: ₹${bal.balance} (expected ₹140)`);
    
    // Test multiple customer isolation
    ledger.addEntry({ customerName: 'Suresh', amount: 1000, type: 'credit', date: '2024-01-15', note: 'test' });
    const sureshBal = ledger.getCustomerBalance('Suresh');
    assert(sureshBal.balance === 1000, `Suresh balance isolated: ₹${sureshBal.balance}`);
    
    const rameshBal = ledger.getCustomerBalance('Ramesh');
    assert(rameshBal.balance === 140, `Ramesh balance unchanged: ₹${rameshBal.balance}`);
    
    // Correction test
    const corrected = ledger.correctLastEntry('Suresh', 1200);
    assert(corrected.amount === 1200, `Corrected to ₹${corrected.amount}`);
    assert(corrected.corrected_from === 1000, `Corrected from ₹${corrected.corrected_from}`);
    
    cleanup();
    return;
  }

  console.log('\n🧪 RUNNING FULL LLM INTEGRATION TESTS\n');
  console.log(`   Provider: ${llm.provider}`);
  console.log(`   Model: ${llm.model}\n`);

  const conversationHistory = [];
  let lastProcessedCustomer = null;

  for (const tc of testCases) {
    console.log(`\n--- Test: ${tc.name} ---`);
    console.log(`   Input: "${tc.utterance}"`);

    try {
      const customerSummary = ledger.getCustomerSummary();
      const recentEntries = ledger.getRecentEntries(10);

      const result = await llm.process({
        transcript: tc.utterance,
        customerSummary,
        recentEntries,
        conversationHistory: conversationHistory.slice(-6),
        pendingCorrection: null
      });

      console.log(`   LLM Output: ${JSON.stringify(result).substring(0, 200)}`);

      // Validate action
      assert(
        result.action === tc.expectedAction,
        `Action: ${result.action} (expected: ${tc.expectedAction})`
      );

      // Validate customer name if expected
      if (tc.expectedCustomer) {
        const nameMatch = result.customerName &&
          result.customerName.toLowerCase().includes(tc.expectedCustomer.toLowerCase());
        assert(nameMatch, `Customer: ${result.customerName} (expected: ${tc.expectedCustomer})`);
      }

      // Validate amount if expected
      if (tc.expectedAmount) {
        assert(
          result.amount === tc.expectedAmount,
          `Amount: ${result.amount} (expected: ${tc.expectedAmount})`
        );
      }

      // Validate spoken response exists
      assert(
        result.spokenResponse && result.spokenResponse.length > 0,
        `Has spoken response: "${result.spokenResponse?.substring(0, 50)}"`
      );

      // Apply to ledger if actionable
      if (result.action === 'add_credit' || result.action === 'add_payment') {
        ledger.addEntry({
          customerName: result.customerName,
          amount: result.amount,
          type: result.action === 'add_credit' ? 'credit' : 'payment',
          date: result.date || new Date().toISOString().split('T')[0],
          note: tc.utterance
        });
        lastProcessedCustomer = result.customerName;
      } else if (result.action === 'correct_entry' && result.newAmount) {
        const customer = lastProcessedCustomer || result.customerName;
        ledger.correctLastEntry(customer, result.newAmount);
      }

      conversationHistory.push(
        { role: 'user', content: tc.utterance },
        { role: 'assistant', content: result.spokenResponse || '' }
      );

      // Rate limiting - small delay between API calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      failed++;
      total++;
      console.log(`  ❌ Error: ${err.message}`);
    }
  }

  // Final ledger state validation
  console.log('\n--- Final Ledger State ---');
  const summary = ledger.getCustomerSummary();
  for (const c of summary) {
    console.log(`  ${c.customer_name}: Credit ₹${c.total_credit}, Paid ₹${c.total_payment}, Balance ₹${c.balance}`);
  }

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
