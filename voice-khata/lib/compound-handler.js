/**
 * Compound Transaction Handler
 * Handles multi-transaction utterances like:
 * "Ramesh ka 340 udhaar, kal 200 diya tha"
 * This creates TWO separate ledger entries from one spoken phrase.
 */

export class CompoundTransactionHandler {
  constructor(ledger) {
    this.ledger = ledger;
  }

  /**
   * Process an LLM result that may contain compound transactions
   * Returns array of applied entries and a combined spoken response
   */
  processResult(result, originalText) {
    const entries = [];
    let combinedResponse = result.spokenResponse || '';

    // Handle main action
    if (result.action === 'add_credit' || result.action === 'add_payment') {
      const entry = this.ledger.addEntry({
        customerName: result.customerName,
        amount: result.amount,
        type: result.action === 'add_credit' ? 'credit' : 'payment',
        date: result.date || new Date().toISOString().split('T')[0],
        note: result.note || originalText
      });
      entries.push(entry);
    }

    // Check for secondary transaction in the same utterance
    if (result.secondaryAction) {
      const sec = result.secondaryAction;
      if (sec.action === 'add_credit' || sec.action === 'add_payment') {
        const entry = this.ledger.addEntry({
          customerName: sec.customerName || result.customerName,
          amount: sec.amount,
          type: sec.action === 'add_credit' ? 'credit' : 'payment',
          date: sec.date || new Date().toISOString().split('T')[0],
          note: originalText
        });
        entries.push(entry);
      }
    }

    // Handle compound detection from text patterns
    if (entries.length === 1 && this._hasCompoundPattern(originalText)) {
      const secondary = this._extractSecondaryTransaction(originalText, result);
      if (secondary) {
        const entry = this.ledger.addEntry({
          customerName: secondary.customerName,
          amount: secondary.amount,
          type: secondary.type,
          date: secondary.date,
          note: originalText
        });
        entries.push(entry);
      }
    }

    return {
      entries,
      spokenResponse: combinedResponse,
      balance: entries.length > 0
        ? this.ledger.getCustomerBalance(entries[0].customerName)
        : null
    };
  }

  _hasCompoundPattern(text) {
    const compoundPatterns = [
      /udhaar.*diya|diya.*udhaar/i,
      /credit.*payment|payment.*credit/i,
      /khata.*jama|jama.*khata/i,
      /likh.*diya|udhaar.*bhugtan/i,
      /,\s*(kal|parso|aaj)\s/i,
      /aur\s+(kal|parso|aaj)\s/i
    ];
    return compoundPatterns.some(p => p.test(text));
  }

  _extractSecondaryTransaction(text, primaryResult) {
    // Pattern: "X ka Y udhaar, kal Z diya tha"
    const paymentAfterCredit = /(?:kal|parso|aaj)\s+(\d+)\s*(?:diya|de diya|payment|bhugtan|jama)/i;
    const creditAfterPayment = /(?:kal|parso|aaj)\s+(\d+)\s*(?:udhaar|udhar|credit|khata)/i;

    const today = new Date();
    
    if (primaryResult.action === 'add_credit') {
      const match = text.match(paymentAfterCredit);
      if (match) {
        const amount = parseInt(match[1], 10);
        // Determine date from context
        let date = today.toISOString().split('T')[0];
        if (/kal/i.test(text)) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          date = yesterday.toISOString().split('T')[0];
        } else if (/parso/i.test(text)) {
          const dayBefore = new Date(today);
          dayBefore.setDate(dayBefore.getDate() - 2);
          date = dayBefore.toISOString().split('T')[0];
        }
        return {
          customerName: primaryResult.customerName,
          amount,
          type: 'payment',
          date
        };
      }
    } else if (primaryResult.action === 'add_payment') {
      const match = text.match(creditAfterPayment);
      if (match) {
        const amount = parseInt(match[1], 10);
        let date = today.toISOString().split('T')[0];
        if (/kal/i.test(text)) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          date = yesterday.toISOString().split('T')[0];
        }
        return {
          customerName: primaryResult.customerName,
          amount,
          type: 'credit',
          date
        };
      }
    }

    return null;
  }
}
