import "dotenv/config";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { createDeepgramConnection } from "./deepgram";
import { decodeTwilioAudio } from "./audio";
import { CallHandler } from "./callHandler";
import { prewarmTTS } from "./tts";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get("/twiml", (c) => {
  const ngrokUrl = process.env.NGROK_URL!;
  const wsUrl = ngrokUrl.replace("https://", "wss://") + "/media-stream";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  return c.text(twiml, 200, { "Content-Type": "text/xml" });
});

app.get(
  "/media-stream",
  upgradeWebSocket((c) => {
    let handler: CallHandler | null = null;
    let deepgramConn: ReturnType<typeof createDeepgramConnection> | null = null;

    return {
      onOpen() {
        console.log("[Server] Twilio WebSocket opened");
        void prewarmTTS();
      },

      async onMessage(event, ws) {
        let msg: {
          event?: string;
          streamSid?: string;
          start?: {
            callSid?: string;
            streamSid?: string;
            customParameters?: Record<string, string>;
          };
          media?: { payload?: string };
          mark?: { name?: string };
        };

        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        switch (msg.event) {
          case "connected":
            console.log("[Twilio] Protocol connected");
            break;

          case "start": {
            const streamSid =
              msg.streamSid ?? msg.start?.streamSid ?? "";
            const callSid = msg.start?.callSid ?? streamSid;
            const callerPhone =
              msg.start?.customParameters?.caller ?? "unknown";
            console.log(
              `[Server] Stream started — callSid: ${callSid}, caller: ${callerPhone}`
            );

            handler = new CallHandler(callerPhone, streamSid, callSid, ws);

            try {
              deepgramConn = createDeepgramConnection(
                (text, isFinal) => {
                  if (!handler) return;
                  if (!isFinal) {
                    process.stdout.write(`\r[interim] ${text}   `);
                    void handler.onInterimTranscript(text);
                  } else {
                    console.log(`\n[FINAL]   ${text}`);
                    void handler.onFinalTranscript(text);
                  }
                },
                { sampleRate: 8000 }
              );
              setTimeout(() => {
                void handler?.onCallStart();
              }, 500);
            } catch (e) {
              console.error("[Server] Failed to start Deepgram:", e);
            }
            break;
          }

          case "media":
            if (!deepgramConn || !msg.media?.payload) return;
            deepgramConn.safeSend(decodeTwilioAudio(msg.media.payload));
            break;

          case "mark":
            console.log("[Server] Mark:", msg.mark?.name);
            if (msg.mark?.name) {
              handler?.onMark(msg.mark.name);
            }
            break;

          case "stop":
            console.log("[Server] Stream stopped");
            handler?.onCallEnd();
            deepgramConn?.safeFinish();
            handler = null;
            deepgramConn = null;
            break;

          default:
            console.log("[Twilio] Unknown event:", msg.event);
        }
      },

      onClose() {
        handler?.onCallEnd();
        deepgramConn?.safeFinish();
        handler = null;
        deepgramConn = null;
      },

      onError(event) {
        console.error("[Twilio] WebSocket error:", event);
      },
    };
  })
);

// Local test — 16 kHz PCM, no Gemini / state machine
app.get(
  "/audio",
  upgradeWebSocket((c) => {
    let deepgramConn: ReturnType<typeof createDeepgramConnection> | null = null;

    return {
      onOpen(_event, ws) {
        console.log("[Server] WebSocket client connected");
        deepgramConn = createDeepgramConnection((text, isFinal) => {
          const prefix = isFinal ? "[FINAL]  " : "[interim]";
          console.log(`${prefix} ${text}`);
          ws.send(JSON.stringify({ transcript: text, isFinal }));
        });
      },

      onMessage(event) {
        if (!deepgramConn) return;
        if (event.data instanceof Buffer) {
          deepgramConn.safeSend(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          deepgramConn.safeSend(Buffer.from(event.data));
        }
      },

      onClose() {
        console.log("[Server] Client disconnected");
        deepgramConn?.safeFinish();
        deepgramConn = null;
      },

      onError(event) {
        console.error("[Server] WebSocket error:", event);
      },
    };
  })
);

app.get("/", (c) => c.text("Voice agent running"));

const port = Number(process.env.PORT) || 3000;
const ngrokUrl = process.env.NGROK_URL ?? "";
const hostFromNgrok = ngrokUrl.replace(/^https?:\/\//, "");
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Server: http://localhost:${port}`);
  if (ngrokUrl) {
    console.log(`TwiML webhook: ${ngrokUrl}/twiml`);
    console.log(`Media stream WS: wss://${hostFromNgrok}/media-stream`);
  }
});

injectWebSocket(server);
