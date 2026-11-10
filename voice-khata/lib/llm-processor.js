export class LLMProcessor {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'gemini';
    this.apiKey = process.env.LLM_API_KEY;
    this.model = process.env.LLM_MODEL || 'gemini-2.0-flash';
  }

  async process({ transcript, customerSummary, recentEntries, conversationHistory, pendingCorrection }) {
    const systemPrompt = this._buildSystemPrompt(customerSummary, recentEntries, pendingCorrection);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-6),
      { role: 'user', content: transcript }
    ];

    let response;
    if (this.provider === 'gemini') {
      response = await this._callGemini(messages);
    } else {
      response = await this._callOpenAI(messages);
    }

    return this._parseResponse(response);
  }

  _buildSystemPrompt(customerSummary, recentEntries, pendingCorrection) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const dayBeforeYesterday = new Date(today);
    dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
    const dayBeforeYesterdayStr = dayBeforeYesterday.toISOString().split('T')[0];

    let prompt = `You are a Voice Khata (ledger) AI assistant for an Indian kirana (grocery) store. You help shopkeepers maintain their credit (udhaar) ledger by voice.

IMPORTANT RULES:
1. Extract customer name, amount, transaction type (credit/udhaar OR payment), and date from the shopkeeper's speech.
2. Respond ONLY in valid JSON format. No markdown, no explanation outside JSON.
3. Understand Hindi, English, and code-mixed (Hinglish) speech.
4. Handle number words: "teen sau chaalis" = 340, "paanch sau" = 500, "ek hazaar" = 1000, "dedh sau" = 150, "dhai sau" = 250, "sawa sau" = 125
5. Handle relative dates: "aaj" = ${todayStr}, "kal" = ${yesterdayStr} (or tomorrow based on context), "parso" = ${dayBeforeYesterdayStr}
6. "udhaar" / "udhar" / "credit" / "khata mein" / "likh do" = credit transaction
7. "diya" / "payment" / "bhugtan" / "de diya" / "jama" = payment transaction
8. Handle corrections: "nahi 430" means correct last amount to 430
9. Never use pressure/threat language in any response.
10. Keep spoken responses SHORT (under 15 words in Hindi/Hinglish).

CURRENT DATE: ${todayStr}

CURRENT LEDGER SUMMARY:
${customerSummary && customerSummary.length > 0 ? customerSummary.map(c => `- ${c.customer_name}: Credit ₹${c.total_credit}, Paid ₹${c.total_payment}, Balance ₹${c.balance}`).join('\n') : 'No entries yet.'}

RECENT TRANSACTIONS:
${recentEntries && recentEntries.length > 0 ? recentEntries.map(e => `- ${e.customer_name}: ${e.type} ₹${e.amount} on ${e.date}`).join('\n') : 'None.'}

${pendingCorrection ? `PENDING CLARIFICATION: ${JSON.stringify(pendingCorrection)}` : ''}

RESPOND WITH JSON IN THIS EXACT FORMAT:
{
  "action": "add_credit" | "add_payment" | "correct_entry" | "query" | "clarify",
  "customerName": "string (original name as spoken)",
  "amount": number,
  "date": "YYYY-MM-DD",
  "note": "original transcript",
  "spokenResponse": "short Hindi/Hinglish confirmation or answer (max 15 words)",
  "queryResult": { ... } // only for action=query
  "question": "string" // only for action=clarify
}

EXAMPLES:
Input: "Ramesh ka 340 udhaar"
Output: {"action":"add_credit","customerName":"Ramesh","amount":340,"date":"${todayStr}","note":"Ramesh ka 340 udhaar","spokenResponse":"Ramesh ka 340 rupay udhaar likh diya"}

Input: "Ramesh ka 340 udhaar, kal 200 diya tha"
Output: {"action":"add_credit","customerName":"Ramesh","amount":340,"date":"${todayStr}","note":"Ramesh ka 340 udhaar, kal 200 diya tha","spokenResponse":"Ramesh ka 340 udhaar aur kal ka 200 payment likh diya"}
Note: This contains TWO transactions. Process the credit first, then mention payment.

Input: "nahi, 430"
Output: {"action":"correct_entry","customerName":"(last customer)","newAmount":430,"spokenResponse":"Theek hai, 430 kar diya"}

Input: "Aaj kitna udhaar gaya?"
Output: {"action":"query","queryResult":{"type":"today_summary"},"spokenResponse":"Aaj ka kul udhaar 1240 rupay hai"}

Input: "Ramesh ka total?"
Output: {"action":"query","customerName":"Ramesh","queryResult":{"type":"customer_balance"},"spokenResponse":"Ramesh ka baaki 540 rupay hai"}

For compound sentences with BOTH credit AND payment (like "340 udhaar, kal 200 diya"), process the CREDIT first and mention the payment in spokenResponse. The server will handle multiple transactions.
`;
    return prompt;
  }

  async _callGemini(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMsgs = messages.filter(m => m.role !== 'system');

    const contents = otherMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemMsg?.content || '' }] },
        contents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  }

  async _callOpenAI(messages) {
    const url = 'https://api.openai.com/v1/chat/completions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model || 'gpt-4o-mini',
        messages,
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '{}';
  }

  _parseResponse(responseText) {
    try {
      // Clean up any markdown formatting
      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const result = JSON.parse(cleaned);
      
      // Validate required fields
      if (!result.action) {
        throw new Error('Missing action field');
      }
      
      // Ensure amount is a number
      if (result.amount) {
        result.amount = Number(result.amount);
      }
      if (result.newAmount) {
        result.newAmount = Number(result.newAmount);
      }
      
      return result;
    } catch (err) {
      console.error('[LLM] Parse error:', err.message, 'Raw:', responseText);
      return {
        action: 'error',
        spokenResponse: 'Maaf kijiye, samajh nahi aaya. Kripya dobara bolein.'
      };
    }
  }
}
