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

// REST API for ledger data (for UI display)
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
    res.json({ success: true, summary });
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

// WebSocket handler for voice sessions
wss.on('connection', (clientWs, req) => {
  const sessionId = randomUUID();
  console.log(`[Session ${sessionId}] New voice session connected`);

  let sttConnection = null;
  let conversationHistory = [];
  let isProcessing = false;
  let pendingCorrection = null;

  // Send AI disclosure as first message (Responsible AI requirement)
  const disclosureMsg = 'Namaste! Main ek AI assistant hoon jo aapki dukaan ka hisaab-kitaab rakhne mein madad karta hai. Aap bolkar apni khata update kar sakte hain. Bataiye, kya karna hai?';
  
  sendToClient(clientWs, {
    type: 'ai_disclosure',
    text: disclosureMsg,
    timestamp: new Date().toISOString()
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
          // Process transcript from client-side STT (fallback)
          await processTranscript(clientWs, message.text, sessionId);
          break;

        case 'text_input':
          // Direct text input (for testing)
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

  // Process transcript through LLM
  async function processTranscript(clientWs, text, sessionId) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      sendToClient(clientWs, { type: 'processing', text });

      // Pre-process spoken Hindi numbers under noise (e.g. "teen sau chaalis" -> "340")
      const normalizedText = parseHindiNumbers(text);

      // Get current ledger context
      const customerSummary = ledger.getCustomerSummary();
      const recentEntries = ledger.getRecentEntries(10);

      // Add to conversation history
      conversationHistory.push({ role: 'user', content: text });

      // Process with LLM
      const result = await llm.process({
        transcript: normalizedText,
        customerSummary,
        recentEntries,
        conversationHistory: conversationHistory.slice(-10),
        pendingCorrection
      });

      // Handle Compound Transactions (e.g., "340 udhaar, kal 200 diya tha")
      if (result.action === 'add_credit' || result.action === 'add_payment') {
        const compoundResult = compoundHandler.processResult(result, normalizedText);
        for (const entry of compoundResult.entries) {
          sendToClient(clientWs, {
            type: 'ledger_update',
            action: entry.type === 'credit' ? 'credit_added' : 'payment_added',
            entry,
            balance: ledger.getCustomerBalance(entry.customerName)
          });
        }
      } else if (result.action === 'correct_entry') {
        const customer = result.customerName || (recentEntries[0] ? recentEntries[0].customer_name : null);
        const corrected = ledger.correctLastEntry(customer, result.newAmount);
        if (corrected) {
          sendToClient(clientWs, {
            type: 'ledger_update',
            action: 'entry_corrected',
            entry: corrected,
            balance: ledger.getCustomerBalance(customer)
          });
        }
      } else if (result.action === 'query') {
        // Dynamic query fulfillment from ledger
        let spokenAnswer = result.spokenResponse;
        if (/aaj|today/i.test(normalizedText)) {
          const todaySum = ledger.getTodaySummary();
          spokenAnswer = `Aaj ka kul udhaar ${Math.round(todaySum.total_credit || 0)} rupay aur wasooli ${Math.round(todaySum.total_payment || 0)} rupay hai.`;
        } else if (result.customerName) {
          const bal = ledger.getCustomerBalance(result.customerName);
          spokenAnswer = `${bal.customerName} ka kul baaki hisaab ${Math.round(bal.balance)} rupay hai.`;
        }
        result.spokenResponse = spokenAnswer || result.spokenResponse;
        sendToClient(clientWs, {
          type: 'query_response',
          data: result.queryResult
        });
      } else if (result.action === 'clarify') {
        pendingCorrection = result;
        sendToClient(clientWs, {
          type: 'clarification_needed',
          question: result.question
        });
      }

      // Send spoken response
      if (result.spokenResponse) {
        conversationHistory.push({ role: 'assistant', content: result.spokenResponse });
        sendToClient(clientWs, {
          type: 'response_text',
          text: result.spokenResponse
        });
        await generateAndSendTTS(clientWs, result.spokenResponse, sessionId);
      }

      if (result.action !== 'clarify') {
        pendingCorrection = null;
      }
    } catch (err) {
      console.error(`[Session ${sessionId}] Processing error:`, err);
      const errorResponse = 'Maaf kijiye, samajh nahi aaya. Kripya dobara bolein.';
      sendToClient(clientWs, { type: 'response_text', text: errorResponse });
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
    }
  } catch (err) {
    console.error(`[Session ${sessionId}] TTS error:`, err);
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
