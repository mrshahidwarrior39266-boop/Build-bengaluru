# Bolti Bahi — voice ledger for kirana stores

> "Apni dukaan ka hisaab, bolkar rakhein."

A push-to-talk khata (credit ledger) that works mid-sale, across a noisy counter,
without touching the screen. The shopkeeper speaks Hinglish or an Indic language;
the ledger records the right customer, the right amount, the right direction
(credit vs payment) and the right day.

## What is actually built

| Requirement | How it is met |
|---|---|
| Numbers under noise | Deterministic on-device parser: digits (`340`), Hindi words (`teen sau chaalis`), fractional prefixes (`dedh sau`, `dhai sau`, `sawa do sau`, `paune do sau`, `saadhe teen sau`), English shorthand (`three-forty`, `three hundred forty`), Indian grouping (`1,20,000`), `5k`, and 8 Indic digit sets including Devanagari `३४०`. |
| Ledger logic | Customer, amount, credit/payment and relative date (`aaj`, `kal`, `parso`) per clause, so one sentence can hold two transactions with different dates. |
| Corrections | `"nahi, 430"` rewrites the last spoken entry, keeps `corrected_from` for the audit trail, and never touches another customer's entry. |
| Shared names | If two customers match a spoken name, the agent asks a short spoken question (`2 grahak milte hain… kaunsa?`) and applies the answer to the chosen customer. |
| Spoken answers | `"Ramesh ka total?"`, `"Aaj kitna udhaar gaya?"`, `"kiski sabse zyada baaki hai"` are answered from the local ledger, with measured worst-case latency far below 2 seconds. |
| Channel | Browser PTT / tap-to-toggle on a low-end phone, WebSocket streaming, optional Gnani Prisma v3.0 STT + Timbre v3.0 TTS. The server re-frames browser audio into the required 1024-byte / 32 ms PCM frames and sends `commit` on release, so the transcript does not wait for a silence timeout. Without a Gnani key the browser Web Speech API is used, and `/api/health` reports `stt:false` instead of pretending. |

## App sections

Bolti Bahi is laid out like a shop app, not a chat window with a ledger hidden
behind a button. Four bottom tabs, all reading the same server snapshot:

| Tab | What it does |
|---|---|
| **Hisaab** | Total outstanding, today's credit and collection, and the last few entries. Two CTAs: speak an entry, or type one. |
| **Grahak** | Every customer with balance, entry count and last activity, plus search by name or mobile. Tap for history. |
| **Report** | Today / week / month / all totals, net change, top outstanding, and a CSV export of the ledger. |
| **Baat** | The voice surface: push-to-talk or tap-to-toggle, live transcript, spoken replies. |

**Manual entry** (home → *Khud likhein*, or `+` on a customer) exists because a
phone microphone can fail mid-sale. It writes the same rows through the same
validated endpoint, with a name/amount/date/type form and autocomplete from
existing customers.

**Nothing is seeded.** A new install shows honest empty states; the customer
list only ever contains rows the shopkeeper created. Every entry and customer can
be deleted from the UI, and *Settings → Data saaf karein* wipes the ledger after
an explicit confirmation, so a mistyped test entry never becomes permanent junk.

## Why local parsing

A cloud LLM round trip cannot be trusted for money, and it fails when a demo
hallway has bad Wi-Fi. Amounts, direction and dates are therefore parsed by
`lib/intent-parser.js` + `lib/hindi-numbers.js` — no key, no network, same answer
every time. Gnani is used for the speech layer (STT/TTS), not for arithmetic.

## Architecture

```
Browser (PTT / Web Speech API fallback)
   │  JSON control frames + 16 kHz PCM
   ▼
server.js ──► KhataAgent (lib/agent.js)
   │              │
   │              ├─ intent-parser ── hindi-numbers
   │              ├─ speech-guard   (no pressure/medical/lending language)
   │              └─ reminders      (opt-in only)
   ▼
LedgerDB (lib/ledger-db.js) — local SQLite via node:sqlite
   └─ transcripts AES-256-GCM encrypted (lib/crypto-store.js), purgeable
```

## Setup

Requires **Node.js 22.5+** for the built-in `node:sqlite` module.

```bash
cd bolti-bahi
pnpm install          # or: npm install
cp .env.example .env  # optional for a text-only demo
pnpm start
```

Open http://localhost:3000 on the phone or laptop.

### Environment variables

| Variable | Purpose |
|---|---|
| `GNANI_API_KEY` | Gnani Prisma v3.0 STT + Timbre v3.0 TTS. Optional; without it `/api/health` reports `stt:false` and the browser speech fallback is used. Add it as a secret, never in a tracked file, then run `npm run verify:gnani`. |
| `LLM_API_KEY` | Optional Grok (xAI) fallback for sentences the local parser cannot read. Also read as `GROK_API_KEY` / `XAI_API_KEY`. Without it, unreadable speech simply stays unreadable — nothing is invented. |
| `LLM_MODEL` | Model for that fallback (default `grok-4-fast`). |
| `PORT` | HTTP/WebSocket port (default 3000). |
| `KHATA_DB` | Ledger file path (default `./bolti-bahi.db`). |
| `TRANSCRIPT_KEY` | 32-byte key (64 hex chars or base64) for transcript encryption. If empty, a local `.bolti-bahi-key` with mode 0600 is generated. Never commit it. |
| `TRANSCRIPT_RETENTION_MINUTES` | Spoken transcripts are purged after this window (default 120). |
| `ENABLE_RESET` | `1` enables `POST /api/reset` for demo resets. Keep `0` in public demos. |

The key stays in `.env`, which is gitignored. `.env.example` contains placeholders only.

### Adding the key from the app

Open the ⚙ button in the header, paste the key and press **Save**. The server
stores it beside the ledger in `.gnani-key` with mode `0600`; the browser never
keeps it, and `GET /api/settings` only ever reports whether a key exists. Writes
are accepted from the same origin only. If `GNANI_API_KEY` is set in the
environment it wins, so a deployed instance stays secret-managed.

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` | `{configured, source, stt, tts}` — never the key |
| `POST /api/settings/gnani-key` | save a key from the app |
| `DELETE /api/settings/gnani-key` | remove the app-saved key |

### Optional Grok fallback

Every amount is still parsed by `lib/intent-parser.js`, offline. The model is a
*second* reader for phrasing the local grammar rejects ("wo pichhle hafte wala
adjust kar do"), never the first one:

- it is only called when the deterministic parser returns `unknown`;
- it must answer with strict JSON (`customerName`, `amount`, `type`, `confidence`);
- the answer is rejected unless the name contains letters, the amount is a
  positive number ≤ 1 crore, the direction is `credit`/`payment`, and confidence
  is at least 0.55;
- the accepted hint is re-parsed by the deterministic parser and written through
  the normal ledger path, so ambiguity questions and validation still apply;
- a slow or failing model (2.5 s budget) is ignored and the honest "samajh nahi
  aaya" answer is used instead.

`test/test-llm-brain.js` proves all of that against a local stub, including that
no request is made without a key and that the model is never consulted for a
sentence the local parser already understands.

It speaks the OpenAI chat-completions shape, so any compatible provider works:
set `LLM_PROVIDER` to `xai` (default), `groq`, `openrouter` or `gemini` and put
that provider’s own key in `LLM_API_KEY`. `LLM_MODEL` / `LLM_BASE_URL` override
the preset. Free tiers exist at several of them, but the key must be yours —
the app never ships or borrows credentials.

## Mobile app (installable PWA)

Bolti Bahi is the app — there is no store download and no WebView wrapper:

- **Android / Chrome:** tap **Install** in the header (or ⋮ → *Install app*). It opens full-screen from the home screen.
- **iPhone / Safari:** Share → *Add to Home Screen*; the app shows this hint automatically.
- **Low-end by design:** one HTML file, no framework or bundler; capture asks the browser for a 16 kHz `AudioContext` (native resampling when available); decorative animation is disabled when `deviceMemory <= 2`, `hardwareConcurrency <= 4`, Data Saver is on, or reduced motion is requested; chat DOM is capped at 80 nodes; the browser no longer builds or uploads a duplicate WAV.
- **Offline is honest:** `public/sw.js` caches the shell and answers API calls with an explicit `503 {offline:true}`. It never queues or invents an entry.
- **Play Store later:** `public/` can be wrapped as a Trusted Web Activity (Bubblewrap) or Capacitor without code changes.
- **Icons** are reproducible: `node scripts/make-icons.mjs` (no dependencies).

Run the server on the shop's Wi-Fi, open it on the phone, and add it to the home screen once.

## Android APK

`android/bolti-bahi-1.4.0-debug.apk` is a signed debug WebView app (package
`ai.boltibahi.app`, minSdk 23) that runs the same UI full-screen.

1. Start the server with HTTPS — browsers and WebViews only allow the microphone
   on a secure origin, and a LAN IP over plain HTTP is not one:

   ```bash
   npm run cert            # self-signed cert for this machine's LAN IP
   HTTPS=1 PORT=3443 npm start
   ```

2. Install the APK (`adb install android/bolti-bahi-1.4.0-debug.apk`, or copy it to the phone).
3. On first launch enter the server URL, e.g. `https://192.168.1.5:3443`.
4. Open **⚙ Settings**, paste the Gnani key, press **Save**. It goes to the
   server (`.gnani-key`, `0600`), not into the APK, browser storage or git.
5. Hold the mic and say `Ramesh ka teen sau chaalis udhaar`.

Rebuild without Gradle:

```bash
ANDROID_SDK_ROOT=/path/to/sdk JAVA_HOME=/path/to/jdk17 ./android/build-apk.sh
```

Needs SDK platform 34 and build-tools 34.0.0. This is a debug build: it accepts
its own self-signed LAN certificate, so replace the keystore before any release.
The APK is a client — the ledger and the key live on the Bolti Bahi server.

## Demo script

1. First turn: the agent introduces itself as an AI in Hinglish, on screen and by voice.
2. Say `"Ramesh ka 340 udhaar, kal 200 diya tha"` → two entries, ₹140 net, the payment dated yesterday.
3. Say `"nahi, 430"` → the last entry is corrected to ₹430 (audit trail keeps 340).
4. Say `"Ramesh Kumar ka 50 udhaar"` then `"Ramesh ka 10 udhaar"` → it asks which Ramesh; answer `"pehla"`.
5. Ask `"Aaj kitna udhaar gaya?"` or `"Ramesh ka total?"` → spoken answer from the ledger.
6. Open **Hisaab → Sab dekhein** (or the **Grahak** tab): the numbers come from the server snapshot, never from demo constants.
7. Add an entry by hand (**Khud likhein**), check the **Report** totals, then delete it again — nothing is seeded, so an empty ledger stays empty.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | capability report (`stt`, `tts`, `ledger`, `transcripts`, retention) |
| `GET /api/ledger` | all entries (notes decrypted in-process) |
| `GET /api/ledger/summary` | per-customer totals |
| `GET /api/state` | full UI snapshot |
| `POST /api/text` | one text turn without a socket: `{ "text": "Ramesh ka 340 udhaar" }` |
| `POST /api/reminders/opt-in` | `{ "name": "Ramesh", "optIn": true }` |
| `GET /api/reminders/preview/:name` | policy-checked reminder wording |
| `POST /api/entries` | manual entry from the app: `{customerName, amount, type, date?, note?}` |
| `DELETE /api/entries/:id` | delete one entry |
| `DELETE /api/customers/:id` | delete a customer and their history |
| `PATCH /api/customers/:id` | save a customer's mobile number |
| `GET /api/reports?range=today\|week\|month\|all` | totals, daily series and top outstanding |
| `GET /api/activity?limit=30` | activity feed with entry ids |
| `DELETE /api/data` | clear the whole ledger (`{confirm:"DELETE"}`) |
| `POST /api/transcripts/purge` | delete all stored transcripts |
| `POST /api/reset` | wipe demo ledger (needs `ENABLE_RESET=1`) |

WebSocket `/ws` accepts `text_input`, `audio_start`, `audio_end`, binary PCM
frames and `get_ledger`; it sends `ai_disclosure`, `transcript`,
`ledger_update`, `clarification_needed`, `query_response`, `response_text`,
`ledger_summary`, `stt_unavailable` and `error`.

### Measuring recognition accuracy

`npm run bench:stt` synthesizes six shop utterances — word numbers, digits,
English shorthand, `dedh sau`, `1,200`, and a compound credit + payment —
streams each through Prisma, parses the transcript, and reports per-case amount,
direction, customer and second-clause correctness plus ASR latency. It exits
non-zero on any wrong amount or direction, so it is a real regression gate once
a key exists. Without a key it prints `SKIPPED` and exits 0.

This uses synthesized speech, so it measures the ASR + parser path, not real
shop-noise microphone quality. That still needs a live demo check.

## Responsible AI and data

- **AI disclosure** in the first turn, in the user's language.
- **No pressure language**: every spoken line passes `lib/speech-guard.js`, which strips threat/deadline wording before it reaches TTS.
- **No lending or medical advice**: those requests are refused and create no ledger row.
- **Reminders** are generated only for customers who explicitly opted in, and are worded neutrally. The demo never claims a message was delivered.
- **Data stays local**: SQLite on the device/server that runs the demo; spoken transcripts are AES-256-GCM encrypted at rest and deleted after the retention window or via `POST /api/transcripts/purge`.
- **No voice cloning**: only the preset Timbre voices (`Shivani`) are configured.
- **Synthetic data only**: tests and demo scripts use invented customers.

## Tests

```bash
pnpm test             # intent, ledger, PWA shell, Gnani contract, judge, WebSocket E2E
pnpm test:judge       # 100-point behavioural judge with hard compliance gates
pnpm test:pwa         # manifest, icons, service worker, Android shell and APK
pnpm test:gnani       # offline wire-protocol contract for the STT/TTS adapters
pnpm test:llm         # Grok fallback: opt-in, validated, never writes on its own
pnpm verify:gnani     # live TTS → PCM → Prisma → ledger check (needs GNANI_API_KEY)
pnpm bench:stt        # live recognition accuracy over synthesized utterances (needs key)
```

`test/judge-evaluation.js` scores only observable behaviour, and reports the
Gnani STT/TTS and live-microphone checks as **unverified** when no key/browser is
available. It never awards points for finding a string in the source.

### Verifying the speech layer

`test/test-gnani-contract.js` starts local WebSocket servers that speak the
documented protocol and asserts the exact headers (`x-api-key-id`, `language_code`,
`model`, `format`, `x-sample-rate`, `keyterms`), the 1024-byte frame contract, the
`commit` control frame, and the `{type:"audio", data:{audio}}` / `complete`
response shape. It needs no key and no network.

`npm run verify:gnani` goes further, using your own key from the environment: it
synthesizes *"Ramesh ka teen sau chaalis udhaar"* with Timbre at 16 kHz raw PCM,
streams it through Prisma in real time, and fails unless the transcript parses to
₹340 credit. The key is read from `GNANI_API_KEY` only — it is never printed,
stored or committed. Without the key the script prints `SKIPPED` and exits 0.

## Known limitations

- The Gnani adapters are contract-tested offline, but the live service is not
  exercised in CI because no key is committed. Run `npm run verify:gnani` with your
  own key to confirm Prisma/Timbre on your account; microphone quality under shop
  noise still needs a live demo check.
- Speech recognition quality with heavy street noise depends on the STT provider;
  the number parser is what guarantees exact amounts from the transcript.
- The demo stores data on the machine running the server (encrypted transcripts),
  not on a phone-local database.
- A spoken correction targets the most recently recorded entry; after a compound
  sentence ("340 udhaar, kal 200 diya") that is the last clause. Naming the
  customer ("Ramesh nahi, 430") targets that customer's latest entry instead.
