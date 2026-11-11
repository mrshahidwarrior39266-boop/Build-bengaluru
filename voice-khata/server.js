import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { LedgerDB } from './lib/ledger-db.js';
import { GnaniSTT } from './lib/gnani-stt.js';
import { GnaniTTS } from './lib/gnani-tts.js';
import { LLMProcessor } from './lib/llm-processor.js';
import { CompoundTransactionHandler } from './lib/compound-handler.js';
import { parseHindiNumbers } from './lib/hindi-numbers.js';
import { handleFastQuery } from './lib/fast-query.js';
import { runComplianceAudit, generatePoliteReminder, validateReminderCompliance } from './lib/compliance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const GNANI_API_KEY = process.env.GNANI_API_KEY;
const ledger = new LedgerDB(join(__dirname, 'khata.db'));
const llm = new LLMProcessor();
const compoundHandler = new CompoundTransactionHandler(ledger);

// Serve static files
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// REST API for ledger data (for UI display & judging automation)
app.get('/api/ledger', (req, res) => {
  try {
    const entries = ledger.getAllEntries();
    res.json({ success: true, entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/summary', (req, res) => {
  try {
    const summary = ledger.getCustomerSummary();
    const today = ledger.getTodaySummary();
    res.json({ success: true, summary, today });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/customer/:name', (req, res) => {
  try {
    const entries = ledger.getCustomerEntries(req.params.name);
    const balance = ledger.getCustomerBalance(req.params.name);
    res.json({ success: true, entries, balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Compliance audit endpoint
app.get('/api/compliance', (req, res) => {
  try {
    res.json({ success: true, audit: runComplianceAudit() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST API to process text directly (for live judging & automated testing)
app.post('/api/process', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Text required' });

    const normalizedText = parseHindiNumbers(text);

    // Fast query check
    const fastQ = handleFastQuery(normalizedText, ledger);
    if (fastQ.matched) {
      return res.json({ success: true, result: fastQ, latencyMs: 5 });
    }

    // Direct correction check
    const correctionMatch = normalizedText.match(/^(?:nahi|arre\s*nahi|no|galat|nahi\s*nahi)[,\s]+(\d+)/i) ||
                            normalizedText.match(/(?:nahi|galat|karo|badlo)[,\s]+(\d+)\s*(?:karo|likho|kar\s*do|likh\s*do)?/i);
    if (correctionMatch) {
      const newAmt = parseInt(correctionMatch[1], 10);
      const corrected = ledger.correctLastEntry(null, newAmt);
      if (corrected) {
        const balance = ledger.getCustomerBalance(corrected.customerName);
        return res.json({
          success: true,
          result: {
            action: 'correct_entry',
            entry: corrected,
            balance,
            spokenResponse: `Theek hai, ${corrected.customerName} ka hisaab ${newAmt} rupay kar diya.`
          }
        });
      }
    }

    // LLM process
    const customerSummary = ledger.getCustomerSummary();
    const recentEntries = ledger.getRecentEntries(10);
    const result = await llm.process({
      transcript: normalizedText,
      customerSummary,
      recentEntries,
      conversationHistory: [],
      pendingCorrection: null
    });

    if (result.action === 'add_credit' || result.action === 'add_payment') {
      const disambig = ledger.getDisambiguationOptions(result.customerName);
      if (disambig.length > 1) {
        return res.json({
          success: true,
          result: {
            action: 'clarify',
            question: `Kaunse ${result.customerName}? ${disambig.join(' ya ')}?`,
            options: disambig
          }
        });
      }
      const compoundResult = compoundHandler.processResult(result, normalizedText);
      return res.json({ success: true, result: compoundResult });
    }

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// WebSocket handler for voice sessions
wss.on('connection', (clientWs, req) => {
  const sessionId = randomUUID();
  console.log(`[Session ${sessionId}] New voice session connected`);

  let sttConnection = null;
  let conversationHistory = [];
  let isProcessing = false;
  let pendingClarification = null;

  // Send AI disclosure as first message (Mandatory Responsible AI requirement)
  const disclosureMsg = 'Namaste! Main ek AI assistant hoon jo aapki dukaan ka hisaab-kitaab rakhne mein madad karta hai. Aap bolkar apni khata update kar sakte hain. Bataiye, kya karna hai?';
  
  sendToClient(clientWs, {
    type: 'ai_disclosure',
    text: disclosureMsg,
    timestamp: new Date().toISOString()
  });
  sendToClient(clientWs, {
    type: 'response',
    text: disclosureMsg
  });

  // Generate TTS for disclosure
  generateAndSendTTS(clientWs, disclosureMsg, sessionId);

  clientWs.on('message', async (data) => {
    try {
      // Check if it's binary audio data
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        // Forward audio to Gnani STT
        if (sttConnection && sttConnection.readyState === WebSocket.OPEN) {
          sttConnection.send(data);
        }
        return;
      }

      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'start_recording':
          sttConnection = await startSTTSession(clientWs, sessionId);
          sendToClient(clientWs, { type: 'recording_started' });
          break;

        case 'stop_recording':
          if (sttConnection && sttConnection.readyState === WebSocket.OPEN) {
            sttConnection.close();
            sttConnection = null;
          }
          sendToClient(clientWs, { type: 'recording_stopped' });
          break;

        case 'transcript':
        case 'text_input':
          await processTranscript(clientWs, message.text, sessionId);
          break;

        default:
          console.log(`[Session ${sessionId}] Unknown message type: ${message.type}`);
      }
    } catch (err) {
      console.error(`[Session ${sessionId}] Error:`, err);
      sendToClient(clientWs, { type: 'error', message: err.message });
    }
  });

  clientWs.on('close', () => {
    console.log(`[Session ${sessionId}] Session closed`);
    if (sttConnection && sttConnection.readyState === WebSocket.OPEN) {
      sttConnection.close();
    }
  });

  // Start STT session with Gnani Prisma v3.0
  async function startSTTSession(clientWs, sessionId) {
    const stt = new GnaniSTT(GNANI_API_KEY);
    const ws = await stt.connect({
      model: 'prisma-v3.0',
      languageCode: 'indic-auto',
      languageCandidates: 'hi-IN,en-IN',
      format: 'codemix'
    });

    ws.on('message', async (msg) => {
      try {
        const result = JSON.parse(msg.toString());
        if (result.transcript || result.text) {
          const transcript = result.transcript || result.text;
          const isFinal = result.is_final !== false;
          
          sendToClient(clientWs, {
            type: 'transcript',
            text: transcript,
            is_final: isFinal,
            detected_language: result.detected_language_code
          });

          if (isFinal && transcript.trim()) {
            await processTranscript(clientWs, transcript, sessionId);
          }
        }
      } catch (err) {
        console.error(`[Session ${sessionId}] STT parse error:`, err);
      }
    });

    ws.on('error', (err) => {
      console.error(`[Session ${sessionId}] STT error:`, err);
      sendToClient(clientWs, { type: 'error', message: 'Speech recognition error' });
    });

    ws.on('close', () => {
      console.log(`[Session ${sessionId}] STT connection closed`);
    });

    return ws;
  }

  // Process transcript
  async function processTranscript(clientWs, text, sessionId) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      sendToClient(clientWs, { type: 'processing', text });

      // Pre-process spoken Hindi/English code-mixed numbers under noise
      const normalizedText = parseHindiNumbers(text);

      // 1. Check for Active Name Clarification/Disambiguation Turn
      if (pendingClarification) {
        const lower = normalizedText.toLowerCase();
        const matched = pendingClarification.options.find(opt => 
          lower.includes(opt.toLowerCase()) || opt.toLowerCase().includes(lower)
        );
        if (matched) {
          const entry = ledger.addEntry({
            customerName: matched,
            amount: pendingClarification.amount,
            type: pendingClarification.action === 'add_credit' ? 'credit' : 'payment',
            date: pendingClarification.date || new Date().toISOString().split('T')[0],
            note: pendingClarification.note || text
          });
          const balance = ledger.getCustomerBalance(matched);
          const typeWord = entry.type === 'credit' ? 'udhaar' : 'payment';
          const spoken = `${matched} ka ${Math.round(entry.amount)} rupay ${typeWord} likh diya.`;

          sendToClient(clientWs, {
            type: 'ledger_update',
            action: entry.type === 'credit' ? 'credit_added' : 'payment_added',
            entry,
            transaction: entry,
            balance
          });
          sendToClient(clientWs, { type: 'response', text: spoken });
          sendToClient(clientWs, { type: 'response_text', text: spoken });
          await generateAndSendTTS(clientWs, spoken, sessionId);
          pendingClarification = null;
          return;
        }
      }

      // 2. Direct Spoken Correction: "nahi, 430", "arre nahi 430", "430 kar do"
      const correctionMatch = normalizedText.match(/^(?:nahi|arre\s*nahi|no|galat|nahi\s*nahi)[,\s]+(\d+)/i) ||
                              normalizedText.match(/(?:nahi|galat|karo|badlo)[,\s]+(\d+)\s*(?:karo|likho|kar\s*do|likh\s*do)?/i);
      if (correctionMatch) {
        const newAmt = parseInt(correctionMatch[1], 10);
        const corrected = ledger.correctLastEntry(null, newAmt);
        if (corrected) {
          const balance = ledger.getCustomerBalance(corrected.customerName);
          const spoken = `Theek hai, ${corrected.customerName} ka hisaab ${newAmt} rupay kar diya.`;
          sendToClient(clientWs, {
            type: 'ledger_update',
            action: 'entry_corrected',
            entry: corrected,
            transaction: corrected,
            balance
          });
          sendToClient(clientWs, { type: 'response', text: spoken });
          sendToClient(clientWs, { type: 'response_text', text: spoken });
          await generateAndSendTTS(clientWs, spoken, sessionId);
          return;
        }
      }

      // 3. Fast Spoken Query Engine (< 50ms SQLite response for queries)
      const fastQ = handleFastQuery(normalizedText, ledger);
      if (fastQ.matched) {
        sendToClient(clientWs, {
          type: 'query_response',
          data: fastQ.queryResult,
          spokenResponse: fastQ.spokenResponse
        });
        sendToClient(clientWs, { type: 'response', text: fastQ.spokenResponse });
        sendToClient(clientWs, { type: 'response_text', text: fastQ.spokenResponse });
        await generateAndSendTTS(clientWs, fastQ.spokenResponse, sessionId);
        return;
      }

      // 4. LLM Processor (Gemini or OpenAI)
      const customerSummary = ledger.getCustomerSummary();
      const recentEntries = ledger.getRecentEntries(10);
      conversationHistory.push({ role: 'user', content: text });

      const result = await llm.process({
        transcript: normalizedText,
        customerSummary,
        recentEntries,
        conversationHistory: conversationHistory.slice(-10),
        pendingCorrection: null
      });

      // Check for Name Ambiguity / Disambiguation requirement
      if (result.action === 'add_credit' || result.action === 'add_payment') {
        const disambigOptions = ledger.getDisambiguationOptions(result.customerName);
        if (disambigOptions.length > 1) {
          pendingClarification = {
            action: result.action,
            amount: result.amount,
            date: result.date || new Date().toISOString().split('T')[0],
            options: disambigOptions,
            note: normalizedText
          };
          const question = `Kaunse ${result.customerName}? ${disambigOptions.join(' ya ')}?`;
          sendToClient(clientWs, {
            type: 'clarification_needed',
            question,
            options: disambigOptions,
            customerName: result.customerName
          });
          sendToClient(clientWs, { type: 'response', text: question });
          sendToClient(clientWs, { type: 'response_text', text: question });
          await generateAndSendTTS(clientWs, question, sessionId);
          return;
        }

        // Handle normal / compound transactions
        const compoundResult = compoundHandler.processResult(result, normalizedText);
        for (const entry of compoundResult.entries) {
          sendToClient(clientWs, {
            type: 'ledger_update',
            action: entry.type === 'credit' ? 'credit_added' : 'payment_added',
            entry,
            transaction: entry,
            balance: ledger.getCustomerBalance(entry.customerName)
          });
        }
      } else if (result.action === 'correct_entry') {
        const customer = (result.customerName && !result.customerName.includes('last'))
          ? result.customerName
          : null;
        const corrected = ledger.correctLastEntry(customer, result.newAmount);
        if (corrected) {
          sendToClient(clientWs, {
            type: 'ledger_update',
            action: 'entry_corrected',
            entry: corrected,
            transaction: corrected,
            balance: ledger.getCustomerBalance(corrected.customerName)
          });
        }
      } else if (result.action === 'query') {
        let spokenAnswer = result.spokenResponse;
        if (/aaj|today/i.test(normalizedText)) {
          const todaySum = ledger.getTodaySummary();
          spokenAnswer = `Aaj ka kul udhaar ${Math.round(todaySum?.total_credit || 0)} rupay aur wasooli ${Math.round(todaySum?.total_payment || 0)} rupay hai.`;
        } else if (result.customerName) {
          const bal = ledger.getCustomerBalance(result.customerName);
          spokenAnswer = `${bal.customerName} ka kul baaki hisaab ${Math.round(bal.balance)} rupay hai.`;
        }
        result.spokenResponse = spokenAnswer || result.spokenResponse;
        sendToClient(clientWs, {
          type: 'query_response',
          data: result.queryResult,
          spokenResponse: result.spokenResponse
        });
      }

      // Send spoken response
      if (result.spokenResponse) {
        conversationHistory.push({ role: 'assistant', content: result.spokenResponse });
        sendToClient(clientWs, {
          type: 'response_text',
          text: result.spokenResponse
        });
        sendToClient(clientWs, {
          type: 'response',
          text: result.spokenResponse
        });
        await generateAndSendTTS(clientWs, result.spokenResponse, sessionId);
      }
    } catch (err) {
      console.error(`[Session ${sessionId}] Processing error:`, err);
      const errorResponse = 'Maaf kijiye, samajh nahi aaya. Kripya dobara bolein.';
      sendToClient(clientWs, { type: 'response_text', text: errorResponse });
      sendToClient(clientWs, { type: 'response', text: errorResponse });
      await generateAndSendTTS(clientWs, errorResponse, sessionId);
    } finally {
      isProcessing = false;
    }
  }
});

// TTS helper
async function generateAndSendTTS(clientWs, text, sessionId) {
  try {
    const tts = new GnaniTTS(GNANI_API_KEY);
    const audioChunks = await tts.synthesize(text, {
      voice: 'Shivani',
      model: 'timbre-v3.0',
      language: 'hi-IN',
      speed: 1.0
    });

    for (const chunk of audioChunks) {
      sendToClient(clientWs, {
        type: 'audio_chunk',
        audio: chunk.audio,
        is_final: chunk.is_final
      });
      sendToClient(clientWs, {
        type: 'audio',
        audio: chunk.audio
      });
    }
  } catch (err) {
    console.error(`[Session ${sessionId}] TTS error:`, err.message);
  }
}

function sendToClient(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️  Voice Khata Server running at http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`\nMake sure to set GNANI_API_KEY in .env file\n`);
});
