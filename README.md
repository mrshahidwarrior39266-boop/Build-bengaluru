# 🎙️ Bolti Bahi — Build Bengaluru

A voice-first khata (credit ledger) for kirana stores, built for the Build
Bengaluru challenge: record `"Ramesh ka 340 udhaar, kal 200 diya tha"` by voice,
mid-sale, in a noisy shop, without touching the screen.

> **"Apni dukaan ka hisaab, bolkar rakhein."**

## What it does

- **Exact numbers from speech** — `teen sau chaalis`, `340`, `three-forty`, `dedh sau`,
  `dhai sau`, `1,20,000`, `5k`, Devanagari `३४०`.
- **Correct direction and date** — credit vs payment per clause; `aaj`, `kal`,
  `parso` resolved per transaction, so one sentence can hold two dated entries.
- **Spoken corrections** — `"nahi, 430"` rewrites the last spoken entry and keeps
  the old amount in the audit trail.
- **Shared-name questions** — two customers named Ramesh produce a short spoken
  question instead of a silent merge.
- **Spoken answers** — `"Aaj kitna udhaar gaya?"`, `"Ramesh ka total?"`,
  `"kiski sabse zyada baaki hai"` answered from the local ledger, sub-2s.
- **Honest fallbacks** — without a Gnani key, recognition and speech move to the
  browser Web Speech API and `/api/health` says `stt:false`. Nothing is faked.

## Architecture

```
┌──────────────────────────────┐
│ Browser (PTT / tap)          │
│  • 16 kHz PCM streaming      │
│  • Web Speech fallback       │
│  • Server-owned ledger view  │
└──────────────┬───────────────┘
               │ WebSocket /ws + REST
┌──────────────▼───────────────┐
│ Node server (server.js)      │
│  KhataAgent                  │
│   ├ intent-parser (offline)  │
│   ├ hindi-numbers            │
│   ├ speech-guard             │
│   └ reminders (opt-in)       │
│  LedgerDB (node:sqlite)      │
│   └ AES-256-GCM transcripts  │
└──────────────┬───────────────┘
               │ optional speech layer
        Gnani Prisma v3.0 STT + Timbre v3.0 TTS
```

Amounts are never computed by an LLM and never need the network: the parser is
deterministic, so the same words always produce the same ledger result.

## Quick start

```bash
cd bolti-bahi
pnpm install            # npm install works too
cp .env.example .env    # fill GNANI_API_KEY for live speech (optional)
pnpm start              # http://localhost:3000
```

Node.js **22.5+** is required (built-in `node:sqlite`).

## Mobile app (PWA)

Bolti Bahi installs straight from the browser — no store build, no framework:

- **Android/Chrome:** the header **Install** button (or ⋮ → *Install app*) launches it full-screen.
- **iPhone/Safari:** Share → *Add to Home Screen*.
- **Low-end friendly:** one HTML file with no bundler; 16 kHz `AudioContext` with native resampling; animations off on `deviceMemory ≤ 2`, `hardwareConcurrency ≤ 4`, Data Saver or reduced motion; chat DOM capped at 80 nodes; no duplicate WAV encode/upload.
- **Offline honest:** the cached shell opens and says the ledger is unreachable — it never queues a fake entry.
- **Store later:** `public/` can be wrapped as a Trusted Web Activity or Capacitor app without code changes.
- Icons are reproducible with `node scripts/make-icons.mjs`.

## Testing

```bash
cd bolti-bahi
pnpm test
```

Suites:

| Suite | What it proves |
|---|---|
| `test/test-intent.js` | 100+ assertions on numbers, direction, dates, corrections, shared names, questions, guardrails |
| `test/test-ledger.js` | SQLite ledger arithmetic, audit trail, name normalisation |
| `test/test-pwa.js` | installable mobile shell: manifest, icon dimensions, service worker, offline behaviour, no fake data |
| `test/test-gnani-contract.js` | offline wire-protocol contract for Prisma STT and Timbre TTS (headers, 1024-byte framing, `commit`, response shapes) |
| `test/judge-evaluation.js` | 100-point behavioural judge with hard compliance gates; no source-grep scoring |
| `test/test-ws-e2e.js` | real server + WebSocket: disclosure first, compound entry, correction, clarification, latency, encrypted transcripts, purge |

Live speech verification is separate because it needs your own key:

```bash
npm run verify:gnani   # TTS → 16 kHz PCM → Prisma STT → ledger, asserts ₹340
npm run bench:stt      # recognition accuracy across six utterances (amount + direction)
```

It reads `GNANI_API_KEY` from the environment (or an untracked `.env`), never
prints it, and exits 0 with `SKIPPED` when the key is absent.

If a compliance gate fails (disclosure, encryption, opt-in reminders, no
pressure language, no lending/health advice, no committed keys), the judge caps
the score at zero.

## Responsible AI and compliance

- **AI disclosure** in the first turn, in the shopkeeper's language, on screen and spoken.
- **Transcripts encrypted at rest** (AES-256-GCM) and deleted after the retention window or on `POST /api/transcripts/purge`.
- **Reminders opt-in only**, neutral wording, no pressure or deadlines, never reported as delivered in the demo.
- **No lending, interest or medical advice**; those asks are refused and create no entry.
- **No voice cloning** — preset Timbre voice only.
- **Secrets** live in `.env` (gitignored); `.env.example` has placeholders only.
- **Synthetic data only** in tests and demo scripts.

Full details: [bolti-bahi/README.md](./bolti-bahi/README.md).

## Repository layout

```
bolti-bahi/
├── server.js                 # HTTP + WebSocket, REST API, compliance endpoints
├── lib/
│   ├── agent.js              # session brain: intents → ledger events + spoken reply
│   ├── intent-parser.js      # offline customer/amount/direction/date/query parser
│   ├── hindi-numbers.js      # spoken numbers, Indic digits, currency shorthand
│   ├── ledger-db.js          # local SQLite ledger, exact-name resolution, audit trail
│   ├── crypto-store.js       # AES-256-GCM transcript vault
│   ├── speech-guard.js       # outgoing-speech compliance filter
│   ├── reminders.js          # opt-in-only polite reminder policy
│   ├── gnani-stt.js          # Prisma v3.0 streaming client (headers, commit)
│   ├── gnani-tts.js          # Timbre v3.0 streaming client (audio/complete events)
│   └── pcm-framer.js         # 1024-byte, 32 ms real-time PCM framing
├── public/                   # mobile-first PTT UI + AudioWorklet
├── scripts/verify-gnani.mjs  # live TTS → STT → ledger verification
└── test/                     # intent, ledger, contract, judge, end-to-end suites
```

## Known limitations

- The Gnani adapters are contract-tested offline against the documented wire
  protocol. The live service is verified only when you run `npm run verify:gnani`
  with your own key, so the repo does not claim live results it has not seen.
- Recognition accuracy under extreme street noise depends on the STT provider;
  exact amounts are guaranteed by the post-STT number parser.
- The ledger lives on the machine running the server, not inside the phone's
  storage. Transcripts are encrypted there.

## Judge prompt

[JUDGE_PROMPT.md](./JUDGE_PROMPT.md) contains the reusable senior-judge prompt this
implementation was built and verified against: the product brief, the behavioural
rubric, the hard compliance gates, and the "loop until the score is 100 with zero
gate failures" rule. Paste it into any coding agent to re-run the same review.

Built for **Build Bengaluru** with the Gnani API Platform. MIT licensed.
