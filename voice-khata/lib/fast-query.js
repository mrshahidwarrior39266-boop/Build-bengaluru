/**
 * Fast Spoken Query Resolver for Voice Khata
 * Delivers deterministic, sub-200ms spoken responses for shopkeeper queries.
 * Queries SQLite directly without waiting for external cloud LLM roundtrips.
 */

export function handleFastQuery(text, ledger) {
  if (!text) return { matched: false };
  const normalized = text.toLowerCase().trim();

  // 1. Today's credit query: "Aaj kitna udhaar gaya?", "Aaj ka udhaar kitna hai?"
  if (
    /(?:aaj|today).*(?:udhaar|udhar|credit|baaki)/i.test(normalized) ||
    /(?:kitna|total).*(?:udhaar|udhar).*(?:aaj|gaya)/i.test(normalized)
  ) {
    const summary = ledger.getTodaySummary();
    const credit = Math.round(summary?.total_credit || 0);
    return {
      matched: true,
      action: 'query',
      queryType: 'today_credit',
      queryResult: { type: 'today_summary', credit, summary },
      spokenResponse: `Aaj ka kul udhaar ${credit} rupay hai.`
    };
  }

  // 2. Today's payment / collection query: "Aaj kitna jama hua?", "Aaj ki wasooli?", "Aaj kitna payment aaya?"
  if (
    /(?:aaj|today).*(?:jama|wasooli|wasuli|payment|aaya|mila)/i.test(normalized) ||
    /(?:kitni|kitna).*(?:wasooli|wasuli|jama).*(?:aaj|hui)/i.test(normalized)
  ) {
    const summary = ledger.getTodaySummary();
    const payment = Math.round(summary?.total_payment || 0);
    return {
      matched: true,
      action: 'query',
      queryType: 'today_payment',
      queryResult: { type: 'today_payment_summary', payment, summary },
      spokenResponse: `Aaj ki kul wasooli ${payment} rupay hai.`
    };
  }

  // 3. Specific customer balance query: "Ramesh ka total?", "Ramesh ka hisaab?", "Ramesh ka kitna baaki hai?"
  const custQueryMatch = normalized.match(
    /(?:^|\s)([a-zA-Z\u0900-\u097F]+)\s*(?:ka|ki|ke|ne)?\s*(?:total|hisaab|hisab|baaki|baki|kitna\s*baaki|balance)/i
  );
  if (custQueryMatch) {
    const candidateName = custQueryMatch[1].trim();
    const stopwords = ['aaj', 'kal', 'parso', 'kul', 'total', 'dukaan', 'kitna', 'kiska', 'sabka', 'mera', 'apna'];
    if (!stopwords.includes(candidateName.toLowerCase())) {
      const balance = ledger.getCustomerBalance(candidateName);
      if (balance && (balance.totalCredit > 0 || balance.totalPayment > 0)) {
        const balAmt = Math.round(balance.balance);
        return {
          matched: true,
          action: 'query',
          queryType: 'customer_balance',
          customerName: balance.customerName,
          queryResult: { type: 'customer_balance', balance },
          spokenResponse: `${balance.customerName} ka kul baaki hisaab ${balAmt} rupay hai.`
        };
      }
    }
  }

  // 4. Shop overall balance query: "Kul kitna baaki hai?", "Dukaan ka total udhaar?"
  if (
    /(?:kul|total|dukaan|sabka).*(?:baaki|baki|udhaar|udhar|hisaab)/i.test(normalized) ||
    /(?:kitna|total).*baaki.*(?:hai|dukaan)/i.test(normalized)
  ) {
    const customers = ledger.getCustomerSummary();
    const totalBalance = Math.round(customers.reduce((sum, c) => sum + (c.balance || 0), 0));
    return {
      matched: true,
      action: 'query',
      queryType: 'shop_total',
      queryResult: { type: 'shop_total', totalBalance, customerCount: customers.length },
      spokenResponse: `Dukaan ka kul baaki hisaab ${totalBalance} rupay hai.`
    };
  }

  return { matched: false };
}
