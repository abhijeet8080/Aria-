# Voice Agent — Project Documentation

This repository implements a **phone-based AI receptionist** for a medical clinic. Incoming calls are handled by **Twilio**; audio is streamed over **WebSockets** to a **Node.js** server. The server acts as a central bridge to process the caller's audio, reason about it, and speak back naturally.

The project supports two distinct architectures for processing conversations, which can be toggled in the server configuration:
1. **Gemini Live Handler (`LiveCallHandler.ts`)**: A native audio-in/audio-out streaming architecture using the Gemini Live API.
2. **Sequential Handler (`SequentialCallHandler.ts`)**: A legacy conversational pipeline chaining **Deepgram** (STT), **Google Gemini** (Text LLM), and **Deepgram Aura** (TTS).

Data is persisted to **Supabase**, session keys are actively managed via **Upstash Redis**, and low-latency **Local Voice Activity Detection (VAD)** powers instant barge-in capabilities.

---

## What the system does

- Answers inbound calls and warmly greets the caller.
- Collects required appointment details (name, date, time, reason) via natural dialogue.
- Checks slot availability and books appointments in a PostgreSQL database.
- Confirms bookings verbally and sends an **SMS** confirmation via Twilio tools.
- Maintains and logs a complete state machine of the interaction (`GREETING`, `COLLECTING_INFO`, `CONFIRMING`, `BOOKED`, `FAILED`).
- Supports **barge-in** capability: the caller can interrupt the agent speaking. A local VAD instantly detects caller speech and clears the Twilio outbound playback buffer.
- Robustly maps real-time data to dynamic instructions so the LLM is context-aware of missing fields before booking.

---

## Technology stack

| Technology | Role in this project |
|------------|----------------------|
| **TypeScript** | Typed application code; compiled/run with `tsx`. |
| **Node.js** | Runtime for the HTTP/WebSocket server. |
| **Hono** | Lightweight web framework for routing handles WebSockets. |
| **Twilio (Voice + Media Streams + SMS)** | Telephony routing, bidirectional WebSocket media streaming, outbound SMS. |
| **Google Gemini Live API (`gemini-2.0-flash-exp`)** | **New Architecture:** Native Audio-in/Audio-out multimodal reasoning and real-time function calling. |
| **Google Gemini API (`gemini-2.5-flash`)** | **Legacy Architecture:** Text-based LLM used in the sequential pipeline. |
| **Deepgram (streaming STT + Aura TTS)** | **Legacy Architecture:** Low-latency transcription (`nova-2`) and text-to-speech output. |
| **@ericedouard/vad-node-realtime** | Local Silero-based Voice Activity Detection to capture caller speech instantly for barge-in logic. |
| **Supabase (PostgreSQL + client)** | Managed Database storing `appointments` and `call_logs`. |
| **Upstash Redis (REST)** | Session storage helpers (1-hour TTL) cleaned up upon caller hang-up. |
| **alawmulaw** | Decodes Twilio’s µ-law base64 payloads to raw linear PCM buffers. |

---

## Project layout

```
voice_agent/
├── package.json
├── tsconfig.json
├── .env                        # Local secrets / API keys
└── src/
    ├── server.ts               # HTTP server, handling /twiml, /media-stream endpoints and tying VAD to Handlers
    ├── LiveCallHandler.ts      # Native audio-to-audio Gemini Live architecture orchestrator
    ├── SequentialCallHandler.ts# Legacy STT → LLM → TTS architecture orchestrator
    ├── conversation.ts         # Base Gemini tool definitions, dynamic state instructions, and text abstractions
    ├── stateMachine.ts         # Call states, session modeling, and formatting logic
    ├── tools.ts                # Tool implementations mapped directly to Supabase + Twilio SDKs
    ├── audio.ts                # Audio decoding algorithms
    ├── tts.ts                  # Deepgram Aura TTS chunking algorithms for 20ms Twilio frames
    ├── deepgram.ts             # Legacy deepgram STT socket manager
    └── db/
        ├── supabase.ts         # Supabase client instantiation
        ├── redis.ts            # Upstash Redis session lifecycle commands
        └── callLog.ts          # State and transcript logging manager
```

---

## Call Handlers in Detail

To provide flexibility, the codebase retains both legacy and modern approaches to voice AI. You can toggle between them by modifying the imports in `server.ts`. 

### 1. Sequential Call Handler (`src/SequentialCallHandler.ts`)

The **Sequential Call Handler** utilizes a classic decoupled pipeline approach: **Speech-to-Text (STT) → Text LLM → Text-to-Speech (TTS)**.
- **Audio Ingress**: Twilio's incoming µ-law audio is decoded to PCM and sent to Deepgram's streaming STT WebSocket.
- **Transcripts**: Deepgram streams back interim (partial) and final text transcripts.
- **Reasoning Loop**: Final text transcripts are routed to `CallConversation` using `gemini-2.5-flash`. The prompt stream processes sentences dynamically, matching tools and dispatching completely formed phrases.
- **Audio Egress**: Each complete phrase triggers a Deepgram Aura TTS API call. The resulting audio is transformed into 8kHz µ-law chunks, matching Twilio's precise 20-millisecond window frame, ensuring smooth delivery.
- **Silence Reprompting**: Operates a 4-second programmatic silence timer. If no audio or event triggers occur, it prompts the LLM to generate a nudge to keep the caller engaged.
- **Safety**: Employs an extra confirmation safeguard checking the LLM outputs to prevent premature textual booking confirmations if the specific `book_appointment` tool payload hasn't run.

### 2. Live Call Handler (`src/LiveCallHandler.ts`)

The **Live Call Handler** represents the next generation in Conversational AI, tightly wrapped around the native **Google Gemini Multimodal Live API**. It strips away the latency jumps of STT/TTS chaining.
- **Audio Translation Interfaces**:
  - *Ingress*: Twilio supplies 8kHz µ-law. The handler decodes it and upsamples it to **16kHz PCM** to fulfill Gemini Live API’s expected ingestion rates.
  - *Egress*: Gemini Live outputs high-fidelity **24kHz PCM** audio. The handler must carefully downsample this back to 8kHz, convert it to µ-law arrays, chunk it into 160-byte buffers, and stream to Twilio's `media` events.
- **Direct Bi-Directional Streaming**: Establishes a raw WebSocket pointing to `generativelanguage.googleapis.com`. Caller audio buffers are safely streamed immediately as they arrive.
- **Dynamic System Prompts**: Due to the Live API's persistent context session, dynamic modifications are tricky. The Live Handler brilliantly combats this via `[SYSTEM STATE UPDATE]` user messages injected immediately following tool execution. Whether the user advances from `COLLECTING_INFO` into `CONFIRMING`, the handler seamlessly signals a system turn describing the newly confirmed details.
- **Barge-in Native Hook**: In conjunction with the `RealTimeVAD` library in `server.ts`, when a user interruption is caught, `LiveCallHandler` performs two synchronized tasks: it fires a `clear` command to Twilio, skipping queued outbound chunks, and sends `"turnComplete": true` backwards into the Gemini WebSocket, immediately preempting the model's monologue.

---

## End-to-end flow

### 1. Call Connection
Twilio triggers the `GET /twiml` webhook. The server responds with TwiML XML to establish a `wss://` Media Stream to `/media-stream`.

### 2. Stream Initialization
- Twilio sends a `start` event embedding `callSid` and custom parameters.
- `server.ts` spins up a new `CallHandler` (either Live or Sequential) and initializes a `RealTimeVAD` instance linked to the socket context.
- The handler spins up connections to respective upstream services (`onCallStart()`) and logs the session in the DB.

### 3. Real-Time Conversation Stream
- **Media Arrives**: Continuous audio packets flow from Twilio.
- **VAD Processing**: Packets are fed immediately into Silence/Speech Detection math. If caller interrupts, a barge-in event is fired to the attached handler.
- **Processing (Live Mode)**:
  - Audio routes to Gemini WebSocket.
  - If Gemini provides `serverContent.modelTurn.parts` containing Audio, it is downsampled and queued iteratively off `doPlayBuffer()`.
  - Tool calls emit inside the `toolCall` struct frame, execute synchronously, insert updates, and route completion traces back.
- **Markers & Tracking**: To ensure no overlap, `mark` tokens (`tts-done-N`) are inserted at the end of audio queues to verify Twilio playback has finished before the agent attempts reprompting or relinquishes its `isSpeaking` states.

### 4. Session Termination
On hangup (`stop` event or WS disconnect), the `onCallEnd` sequence:
- Invokes `deleteSession()` dropping the Upstash Redis lock.
- Appends final JSON transcripts + final `CallState` enum directly to Supabase via `CallLog.close()`.
- Drops WebSockets gracefully.

---

## Configuration

All configuration is controlled via **environment variables** (typically loaded from `.env` in development). Make sure to secure these keys properly.

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP server port (default `3000`). |
| `NGROK_URL` | Public HTTPS URL (e.g., ngrok) to build the TwiML Stream mapping to your local dev. |
| `GEMINI_API_KEY` | Google AI Studio Key. Used for both `LiveCallHandler` and `SequentialCallHandler` LLM reasoning. |
| `DEEPGRAM_API_KEY` | Authenticates Deepgram models, exclusively required for `SequentialCallHandler`. |
| `TWILIO_ACCOUNT_SID` | Twilio account identifier. |
| `TWILIO_AUTH_TOKEN` | Twilio auth token used dynamically for outbound SMS integrations. |
| `TWILIO_PHONE_NUMBER` | Sender caller ID necessary for the `send_confirmation_sms` tool. |
| `SUPABASE_URL` | Database Connection Target. |
| `SUPABASE_ANON_KEY` | Database Access keys (must be kept secret in `.env`). |
| `UPSTASH_REDIS_REST_URL` | Fast session lookup REST mappings. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash API Access keys. |

---

## Dependencies (from `package.json`)

**Runtime**: `@deepgram/sdk`, `@google/generative-ai`, `@hono/node-server`, `@hono/node-ws`, `@supabase/supabase-js`, `@upstash/redis`, `@ericedouard/vad-node-realtime`, `alawmulaw`, `dotenv`, `hono`, `twilio`, `ws`.  
**Dev**: `tsx`, `typescript`, `@types/node`, `@types/ws`.

---

## Security notes

- **NEVER** commit `.env` containing your valid production vendor keys.
- **Database Safety**: Ensure Row-Level Security (RLS) policies are active on Supabase `appointments` and `call_logs` if you choose to deploy client keys out-of-band. For server-side executions, minimize connection exposure.
- **Key Rotation**: Treat Twilio, Deepgram, Gemini, and Supabase credentials as highly volatile. Rotate if leaked into repository history.
- **Production Enhancements**: Shift from `ngrok` towards robust load balancers directly proxying `WSS` sockets against cluster deployments to ensure stability inside Twilio’s infrastructure configurations.
