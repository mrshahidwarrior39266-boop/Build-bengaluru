# 🎙️ Voice Khata — Voice-Powered Ledger for Kirana Stores

> "Apni dukaan ka hisaab, bolkar rakhein" — Keep your shop's accounts by voice

## Overview

Voice Khata is an AI-powered voice ledger system built for Indian kirana (grocery) stores. It lets shopkeepers manage their credit (udhaar) and payment records entirely by voice, without touching the screen — even across a noisy counter mid-sale.

## Key Features

### 🗣️ Natural Voice Input
- **Code-mixed speech**: Understands Hindi, English, and Hinglish naturally
- **Number recognition**: "teen sau chaalis" = "340" = "three-forty"
- **Relative dates**: "aaj" (today), "kal" (yesterday/tomorrow), "parso" (day before)
- **Corrections**: "nahi, 430" corrects the last entry

### 📒 Smart Ledger Management
- Automatic customer name recognition and matching
- Credit (udhaar) and payment tracking
- Balance calculations per customer
- Daily summaries and totals
- Correction history with audit trail

### 🎯 Voice Queries
- "Ramesh ka total?" → Gets Ramesh's balance
- "Aaj kitna udhaar gaya?" → Today's credit summary
- "Kiski sabse zyada baaki hai?" → Who owes the most

### 🔊 Spoken Responses
- Instant voice confirmation of entries (< 2 seconds)
- Short, natural Hindi/Hinglish responses
- AI disclosure on first interaction (Responsible AI)

## Architecture

```
┌──────────────────────────────────────────────┐
│              Browser (Mobile)                 │
│  ┌──────────┐  ┌─────────┐  ┌─────────────┐ │
│  │ Push-to- │  │ Audio   │  │ Ledger      │ │
│  │ Talk Btn │  │ Playback│  │ Display     │ │
│  └────┬─────┘  └────▲────┘  └──────▲──────┘ │
│       │              │              │         │
│       ▼              │              │         │
│  ┌─────────── WebSocket ────────────┘         │
│  │  Binary: Audio    │  JSON: Control         │
└──┼───────────────────┼────────────────────────┘
   │                   │
   ▼                   │
┌──────────────────────┼────────────────────────┐
│          Node.js Server                        │
│  ┌──────────┐  ┌─────┴─────┐  ┌────────────┐ │
│  │ Gnani    │  │ Gnani     │  │ LLM        │ │
│  │ STT      │  │ TTS       │  │ Processor  │ │
│  │ Prisma   │  │ Timbre    │  │ (Gemini/   │ │
│  │ v3.0     │  │ v3.0      │  │  OpenAI)   │ │
│  └──────────┘  └───────────┘  └──────┬─────┘ │
│                                      │        │
│                              ┌───────▼──────┐ │
│                              │ SQLite       │ │
│                              │ Ledger DB    │ │
│                              │ (Encrypted)  │ │
│                              └──────────────┘ │
└────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **STT** | Gnani Prisma v3.0 (WebSocket streaming) |
| **TTS** | Gnani Timbre v3.0 (WebSocket streaming) |
| **LLM** | Google Gemini 2.0 Flash / OpenAI GPT-4o-mini |
| **Backend** | Node.js + Express + WebSocket |
| **Database** | SQLite (better-sqlite3, encrypted at rest) |
| **Frontend** | Vanilla HTML/CSS/JS (zero dependencies) |
| **Audio** | Web Audio API + AudioWorklet |

## Setup & Installation

### Prerequisites
- Node.js 18+ 
- Gnani API Key (from [studio.gnani.ai](https://studio.gnani.ai))
- Gemini API Key or OpenAI API Key

### Quick Start

```bash
# 1. Clone/navigate to the project
cd voice-khata

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start the server
pnpm start

# 5. Open in browser
# Navigate to http://localhost:3000
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GNANI_API_KEY` | Gnani API Platform key | ✅ |
| `LLM_API_KEY` | Gemini or OpenAI API key | ✅ |
| `LLM_PROVIDER` | `gemini` or `openai` | ✅ |
| `LLM_MODEL` | Model name (e.g., `gemini-2.0-flash`) | Optional |
| `PORT` | Server port (default: 3000) | Optional |

## Usage

### Voice Commands

| Say this... | What happens |
|-------------|-------------|
| "Ramesh ka 340 udhaar" | Records ₹340 credit for Ramesh |
| "Ramesh ne 200 diya" | Records ₹200 payment from Ramesh |
| "Kal Suresh ka 500 udhaar tha" | Records yesterday's ₹500 credit for Suresh |
| "Nahi, 430" | Corrects last entry to ₹430 |
| "Ramesh ka total?" | Speaks Ramesh's balance |
| "Aaj kitna udhaar gaya?" | Speaks today's total credit |
| "Sabse zyada kiski baaki hai?" | Speaks who owes the most |

### Push-to-Talk
1. **Tap** the microphone button to start recording
2. **Speak** your command naturally
3. **Tap again** to stop (or hold and release)
4. The AI will confirm and update the ledger

## Responsible AI & Compliance

- ✅ **AI Disclosure**: Agent identifies as AI in the first turn
- ✅ **Synthetic Data**: Only synthetic/consented data used
- ✅ **Data Privacy**: Ledger data stored locally in encrypted SQLite
- ✅ **No Pressure Language**: Reminders are polite, no threats
- ✅ **API Key Security**: Keys in `.env`, listed in `.gitignore`
- ✅ **No Real Data**: No real customer recordings or PII
- ✅ **No Voice Cloning**: Uses standard Gnani TTS voices only

## API Endpoints

### REST API
- `GET /api/ledger` — All ledger entries
- `GET /api/ledger/summary` — Customer balance summary
- `GET /api/ledger/customer/:name` — Customer-specific entries

### WebSocket (`/ws`)
- **Binary frames**: Raw PCM audio (16kHz, 16-bit, mono)
- **JSON frames**: Control messages (`start_recording`, `stop_recording`, `text_input`)

## Development

```bash
# Run in development mode
pnpm dev

# Run tests
pnpm test
```

## License

MIT

---

Built with ❤️ for Indian shopkeepers using [Gnani API Platform](https://gnani.ai)
