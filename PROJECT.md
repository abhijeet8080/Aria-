# Voice Agent — Project Documentation

This repository implements a **phone-based AI receptionist** for a medical clinic. Incoming calls are handled by **Twilio**; audio is streamed over **WebSockets** to a **Node.js** server that transcribes speech with **Deepgram**, reasons with **Google Gemini**, speaks back via **Deepgram TTS**, and persists data with **Supabase**. **Upstash Redis** is configured for session keys (cleanup on hang-up is implemented; full session read/write is available for future use).

---

## What the system does

- Answers inbound calls and greets the caller.
- Collects appointment details (name, date, time, reason) through a guided conversation.
- Checks slot availability and books appointments in a database.
- Confirms verbally, can send an **SMS** confirmation via Twilio.
- Logs call transcripts to the database.
- Supports **barge-in** (caller can interrupt TTS by speaking) and **silence reprompts** after idle periods.

---

## Technology stack

| Technology | Role in this project |
|------------|----------------------|
| **TypeScript** | Typed application code; compiled/run with `tsx`. |
| **Node.js** | Runtime for the HTTP/WebSocket server. |
| **Hono** | Lightweight web framework for routes and middleware. |
| **@hono/node-server** + **@hono/node-ws** | Serves the app and upgrades HTTP to WebSocket for Twilio Media Streams and local testing. |
| **Twilio (Voice + Media Streams + SMS)** | Telephony: routes calls, streams bidirectional audio over WebSocket, sends SMS from tools. |
| **Deepgram (streaming STT + Aura TTS)** | Real-time transcription (`nova-2`) and text-to-speech (`aura-2-*`, µ-law 8 kHz for Twilio). |
| **Google Gemini (`gemini-2.5-flash`)** | LLM with function calling for tools and state-aware dialogue. |
| **Supabase (PostgreSQL + client)** | Stores `appointments`, `call_logs`; anon key used from the server. |
| **Upstash Redis (REST)** | Session storage helpers (`session:{callSid}` with 1-hour TTL); `deleteSession` runs when the call ends. |
| **alawmulaw** | Decodes Twilio’s µ-law payloads to linear PCM for Deepgram. |
| **dotenv** | Loads environment variables from `.env`. |
| **ws** | WebSocket client used by the local `test-client` script. |

---

## Why these choices (at a glance)

- **Twilio Media Streams** gives a single WebSocket for inbound/outbound audio compatible with programmable voice, which fits a custom pipeline (STT → LLM → TTS) without hosting traditional telephony hardware.
- **Deepgram** provides low-latency streaming STT and a TTS API that can output **raw µ-law at 8 kHz**, matching **Twilio’s expected frame size** (160-byte frames ≈ 20 ms).
- **Gemini with tools** keeps the dialogue flexible while still grounding **booking**, **availability**, and **SMS** in explicit server-side functions.
- **Supabase** offers a managed Postgres API for appointments and transcripts without a separate custom backend database layer.
- **Hono** keeps the server small and integrates cleanly with Node WebSockets for media streaming.

---

## Project layout

```
voice_agent/
├── package.json
├── tsconfig.json
├── .env                    # Local secrets (not committed — see .gitignore)
└── src/
    ├── server.ts           # HTTP server, /twiml, /media-stream, /audio
    ├── callHandler.ts      # Per-call orchestration: Twilio ↔ Deepgram ↔ Gemini ↔ TTS
    ├── conversation.ts     # Gemini chat, tools, state instructions
    ├── stateMachine.ts     # Call states and appointment model
    ├── tools.ts            # Tool implementations (Supabase + Twilio SMS)
    ├── deepgram.ts         # Streaming STT connection
    ├── tts.ts              # Deepgram Aura TTS → µ-law chunks
    ├── audio.ts            # Twilio µ-law → PCM for Deepgram
    ├── test-client.ts      # Local WAV → /audio WebSocket test
    └── db/
        ├── supabase.ts     # Supabase client
        ├── redis.ts        # Upstash Redis session helpers
        └── callLog.ts      # Transcript persistence
```

---

## Configuration

All configuration is via **environment variables** (typically loaded from `.env` in development). **Do not commit real keys.** Use placeholders in docs and rotate any keys that were ever exposed.

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP server port (default `3000` if unset). The test client expects the server on the same port it uses in `SERVER_URL`. |
| `NGROK_URL` | Public HTTPS URL of your tunnel (e.g. `https://xxxx.ngrok-free.app`). Used to build the **TwiML** `Stream` URL (`https` → `wss` for WebSocket). |
| `DEEPGRAM_API_KEY` | Authenticates Deepgram streaming STT and Aura TTS. |
| `DEEPGRAM_TTS_MODEL` | Optional. Defaults to `aura-2-thalia-en` in code if unset. |
| `GEMINI_API_KEY` | Google AI Studio / Gemini API key for `gemini-2.5-flash`. |
| `TWILIO_ACCOUNT_SID` | Twilio account identifier. |
| `TWILIO_AUTH_TOKEN` | Twilio auth token for REST (e.g. SMS). |
| `TWILIO_PHONE_NUMBER` | Sender number for outbound SMS (`send_confirmation_sms`). |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Supabase anonymous key (server-side; protect the server). |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token. |

### TypeScript

- `tsconfig.json`: `target` ES2022, `module` / `moduleResolution` NodeNext, `strict` mode, output `dist/`.

### Deepgram (code defaults)

- **STT** (`deepgram.ts`): model `nova-2`, `en-US`, `linear16`, configurable `sample_rate` (8000 for Twilio, 16000 for local test).
- **TTS** (`tts.ts`): Aura model (env or `aura-2-thalia-en`), `encoding=mulaw`, `sample_rate=8000`, `container=none`.

### Twilio voice webhook

- Configure the phone number’s **Voice webhook** to HTTP GET your public URL: `{NGROK_URL}/twiml` (or your production URL).
- TwiML returned connects a **Media Stream** to `wss://{host}/media-stream`.

---

## External data model (expected Supabase tables)

The code assumes at least:

**`appointments`**

- Used for availability and booking: columns include `appointment_date`, `appointment_time`, `status`, `confirmation_id`, `caller_phone`, `patient_name`, `reason`, etc., as used in `tools.ts`.

**`call_logs`**

- Upserted/updated by `CallLog`: `call_sid`, `caller_phone`, `started_at`, `ended_at`, `final_state`, `transcript` (JSON array of `{ role, text, timestamp }`), optional `appointment_id`.

---

## HTTP and WebSocket surface

| Route | Purpose |
|-------|---------|
| `GET /` | Health text: `Voice agent running`. |
| `GET /twiml` | Returns TwiML XML: `<Connect><Stream url="wss://…/media-stream" /></Connect>`. |
| `GET /media-stream` | **WebSocket** — Twilio Media Streams protocol (JSON events: `connected`, `start`, `media`, `mark`, `stop`). |
| `GET /audio` | **WebSocket** — Local test only: raw **16 kHz** PCM chunks → Deepgram → JSON `{ transcript, isFinal }` (no Gemini/state machine). |

---

## End-to-end flow when a call is made

The following is the **runtime path** from dial to hang-up.

### 1. Call arrives at Twilio

Twilio requests `GET /twiml` from your public URL. The server responds with TwiML that **opens a WebSocket** to `/media-stream` for bidirectional audio.

### 2. WebSocket opens and stream starts

- Event **`connected`**: protocol handshake logged.
- Event **`start`**: contains `callSid`, `streamSid`, and optional `customParameters` (e.g. `caller` phone). The server constructs a **`CallHandler`**, opens a **Deepgram live transcription** connection at **8 kHz** (to match Twilio), and after a short delay runs **`onCallStart()`**.

### 3. Greeting (`onCallStart`)

- **`CallLog.save()`** writes/updates the initial row in **`call_logs`**.
- **`askGemini`** sends a system-style line asking for a one-sentence warm greeting; the reply is converted to speech and sent to the caller (see step 6).

### 4. Inbound audio loop (`media`)

- Twilio sends **base64 µ-law** payloads.
- **`decodeTwilioAudio`** converts µ-law → **linear16 PCM** and **`safeSend`** forwards it to Deepgram.
- Deepgram emits **interim** and **final** transcripts.

### 5. Interim transcripts (`onInterimTranscript`)

- If the user is speaking (non-empty text), **silence timer** is cleared and **`lastActivityAt`** updates.
- If the agent was **speaking** (`isSpeaking`), this is treated as **barge-in**: `interruptRequested` is set and **`clear`** is sent to Twilio to stop playback.

### 6. Final transcripts (`onFinalTranscript`)

- Empty transcripts are ignored.
- Caller line is appended to **`CallLog`**.
- **`processTranscript`** runs:
  - **`CallConversation.sendMessage`** sends user text + **state-specific instructions** to Gemini.
  - If Gemini returns a **tool call**, **`executeTool`** runs (`update_appointment_info`, `check_availability`, `book_appointment`, `send_confirmation_sms`).
  - **`update_appointment_info`** merges fields into **`session.appointment`**; when all required fields exist, state can move to **CONFIRMING** with a read-back.
  - **`book_appointment`** inserts into Supabase and may transition to **BOOKED**; **`send_confirmation_sms`** uses Twilio Messages API.
  - If there is **no tool** and **no text**, `noMatchCount` increases; after **3** failures, transition to **FAILED**.
  - Otherwise the model’s **text** is spoken via TTS.

### 7. Outbound speech (`speak` / `doSpeak`)

- **`textToMulaw`** calls Deepgram Aura TTS; audio is **chunked** into **160-byte** frames (20 ms at 8 kHz).
- Each chunk is sent as Twilio **`media`** JSON with **base64** payload.
- After chunks, a **`mark`** event is sent (`tts-done-N`). When Twilio echoes the **mark**, **`onMark`** fires: playback is considered finished, **`isSpeaking`** clears, and if the session is not busy, a **4-second silence timer** starts.

### 8. Silence handling

- If the caller says nothing for **4 seconds** after the agent finishes speaking (and nothing is busy), **`onSilenceTimeout`** asks Gemini for a short reprompt and speaks it.

### 9. Call end (`stop` or WebSocket close)

- **`onCallEnd`**: **`CallLog.close(finalState)`** updates **`call_logs`**; **`deleteSession(callSid)`** removes **`session:{callSid}`** from Redis; Deepgram connection is **finished**.

---

## State machine (high level)

States are defined in `stateMachine.ts`:

| State | Meaning |
|-------|---------|
| `GREETING` | Initial; moves to `COLLECTING_INFO` once dialogue progresses. |
| `COLLECTING_INFO` | Gathering name, date, time (and reason); tools update `appointment`. |
| `CONFIRMING` | Read-back and explicit confirmation before booking. |
| `BOOKED` | Appointment saved; SMS tool may run; goodbye. |
| `FAILED` | Too many non-understandings; polite closure. |

Gemini receives a **state instruction** block on each turn so replies stay aligned with the current phase.

---

## Local development and testing

- **Run server**: `npm run dev` (uses `tsx watch src/server.ts`).
- **Tunnel**: Expose the server with ngrok (or similar); set **`NGROK_URL`** to the `https://` tunnel URL.
- **Twilio**: Point the voice webhook at `{NGROK_URL}/twiml` and ensure the tunnel port matches **`PORT`**.
- **Audio STT-only test**: `npm run test-client -- path/to/file.wav` streams PCM from a WAV (skips 44-byte header) to **`ws://localhost:{PORT}/audio`** — note the default `SERVER_URL` in `test-client.ts` is port **8080**; align **`PORT`** or edit the constant.

---

## Dependencies (from `package.json`)

Runtime: `@deepgram/sdk`, `@google/generative-ai`, `@hono/node-server`, `@hono/node-ws`, `@supabase/supabase-js`, `@upstash/redis`, `alawmulaw`, `dotenv`, `hono`, `twilio`, `ws`.  
Dev: `tsx`, `typescript`, `@types/node`, `@types/ws`.

---

## Security notes

- Treat **`.env`** as secret; use **Row Level Security** and minimal privileges on Supabase if the anon key is ever exposed.
- Rotate **Twilio**, **Deepgram**, **Gemini**, and **Supabase** keys if they appear in logs or public repos.
- Production should use **HTTPS/WSS** on a stable domain, not only ngrok, and lock down Twilio webhook URLs.

This document reflects the codebase structure and behavior as of the last update; if you add features (e.g. wiring **`saveSession`** / **`getSession`** into the call flow), update the “flow” and “Redis” sections accordingly.
