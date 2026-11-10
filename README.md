# 🎙️ Voice Khata — Build Bengaluru (Gnani API Platform Challenge)

[![Gnani Prisma v3.0](https://img.shields.io/badge/STT-Prisma_v3.0-00C49F?style=for-the-badge)](https://gnani.ai)
[![Gnani Timbre v3.0](https://img.shields.io/badge/TTS-Timbre_v3.0-0088FE?style=for-the-badge)](https://gnani.ai)
[![Responsible AI](https://img.shields.io/badge/Compliance-100%25_Responsible_AI-FFBB28?style=for-the-badge)](./voice-khata/README.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](./LICENSE)

> **"Apni dukaan ka hisaab, bolkar rakhein"** — Keep your kirana shop's credit ledger (khata) completely by voice, across the counter, mid-sale, without touching the screen.

---

## 🏆 Project Overview

**Voice Khata** is an enterprise-grade voice-first ledger built specifically for Indian kirana (grocery) store owners. It solves the critical counter-rush problem: shopkeepers handing over goods with dirty/busy hands cannot navigate complex touchscreens or write paper slips. Voice Khata enables seamless, hands-free conversational ledger updates in real-time under loud store noise.

Built exclusively on the **Gnani API Platform** using **Prisma v3.0 WebSocket Streaming STT** and **Timbre v3.0 WebSocket Streaming TTS**, orchestrated with a low-latency LLM processing engine.

---

## 🚀 Key Highlights & Hackathon Rubric Alignment

| Rubric Dimension | Weight | Voice Khata Implementation |
|---|---|---|
| **Live Judge Test** | 30 pts | • Handles complex code-mixed inputs: *"Ramesh ka 340 udhaar, kal 200 diya tha"*<br>• Spoken corrections: *"nahi, 430"*<br>• Real-time queries: *"Aaj kitna udhaar gaya?"*, *"Ramesh ka total?"*<br>• Instant sub-2s spoken confirmations in natural Hindi/Hinglish |
| **Speech-Layer Depth** | 20 pts | • **Prisma v3.0** STT via bidirectional WebSocket streaming with `indic-auto` language detection, `codemix` formatting, and store-specific keyword boosting (`udhaar`, `jama`, `baaki`, `hisaab`).<br>• **Timbre v3.0** TTS via WebSocket streaming with expressive voices (`Avinash`, `Shivani`) and natural prosody.<br>• Client-side AudioWorklet 16kHz 16-bit PCM streaming for low-end mobile devices. |
| **Fit for Target User** | 20 pts | • **Hands-free / Push-to-Talk / Tap-to-Toggle** dual modes designed for dusty, greasy shop counters.<br>• **Numbers Under Noise**: Pre-processor handles colloquial Hindi words (*"teen sau chaalis"*, *"dedh sau"*, *"dhai sau"*, *"sawa sau"*).<br>• **Compound Transactions**: Automatically records both credit and payment from a single spoken sentence. |
| **Innovation** | 10 pts | • **Zero-Native-Build SQLite Engine**: Employs built-in `node:sqlite` DatabaseSync with WAL journal mode for blistering local performance without C++ compilation hurdles.<br>• **Reverse-Chronological Audit Trail**: Full transaction history with corrections and fuzzy Indic customer name matching. |
| **Responsible AI & Compliance** | 10 pts | • **AI First-Turn Disclosure**: Identifies as an AI assistant in the user's language immediately.<br>• **Zero Harassment**: Strictly polite balance reminders without pressure language.<br>• **Data Privacy**: Ledger data stored strictly on-device in local SQLite.<br>• **Security**: Keys isolated in `.env` and `.gitignore`. |
| **Demo & Docs** | 10 pts | • Fully self-contained, mobile-first responsive UI.<br>• Comprehensive test suite (35/35 passing unit tests + integration test). |

---

## 📁 Repository Structure

```
├── .gitignore
├── .npmrc
├── README.md
└── voice-khata/
    ├── .env.example
    ├── .gitignore
    ├── .npmrc
    ├── README.md
    ├── package.json
    ├── server.js                  # Express + WebSocket orchestration server
    ├── lib/
    │   ├── compound-handler.js    # Multi-transaction utterance parser
    │   ├── gnani-stt.js           # Gnani Prisma v3.0 WebSocket client
    │   ├── gnani-tts.js           # Gnani Timbre v3.0 WebSocket client
    │   ├── hindi-numbers.js       # Spoken Hindi number words to digits parser
    │   ├── ledger-db.js           # SQLite local ledger engine with audit trail
    │   └── llm-processor.js       # Kirana intent extractor (Gemini / OpenAI)
    ├── public/
    │   ├── index.html             # Self-contained mobile PTT web interface
    │   └── pcm-recorder-processor.js # AudioWorklet for glitch-free 16kHz PCM
    └── test/
        ├── test-ledger.js         # 35-test unit suite (Database & LLM parser)
        └── test-integration.js    # E2E simulated shopkeeper speech tests
```

---

## ⚡ Quick Start

```bash
# 1. Navigate to the project directory
cd voice-khata

# 2. Install dependencies (Node 22+ recommended)
pnpm install

# 3. Configure your API keys
cp .env.example .env
# Edit .env with your GNANI_API_KEY and LLM_API_KEY

# 4. Run the test suite
pnpm test

# 5. Start the Voice Khata server
pnpm start

# 6. Open in mobile browser
# Navigate to http://localhost:3000
```

---

## 🧪 Running Tests

```bash
cd voice-khata
node test/test-ledger.js
# Output: 📊 TEST RESULTS: 35/35 passed, 0 failed 🎉
```

---

Built for **Build Bengaluru Hackathon** using the **Gnani API Platform**.
