import "dotenv/config";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { createDeepgramConnection } from "./deepgram";
import { decodeTwilioAudio } from "./audio";
// import { CallHandler } from "./SequentialCallHandler";
import { prewarmTTS } from "./tts";
import { RealTimeVAD } from "@ericedouard/vad-node-realtime";

// Uncomment the line below to switch to the native Audio-to-Audio Live API handler
import { CallHandler } from "./LiveCallHandler";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get("/twiml", (c) => {
  const ngrokUrl = process.env.NGROK_URL!;
  const wsUrl = ngrokUrl.replace("https://", "wss://") + "/media-stream";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="{{From}}" />
    </Stream>
  </Connect>
</Response>`;
  return c.text(twiml, 200, { "Content-Type": "text/xml" });
});

app.get(
  "/media-stream",
  upgradeWebSocket((c) => {
    let handler: CallHandler | null = null;
    let deepgramConn: ReturnType<typeof createDeepgramConnection> | null = null;
    let vadInstance: any = null;

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
            RealTimeVAD.new({
              onSpeechStart: () => {
                handler?.handleBargeIn();
              }
            })
              .then((v: any) => {
                vadInstance = v;
                vadInstance.start();
              })
              .catch(console.error);

            if (!(handler as any).isNativeLive) {
              try {
                deepgramConn = createDeepgramConnection(
                  (text, isFinal, detectedLanguage) => {
                    if (!handler) return;
                    if (detectedLanguage) {
                      (handler as any).updateLanguage?.(detectedLanguage);
                    }
                    if (!isFinal) {
                      process.stdout.write(`\r[interim] ${text}   `);
                      void (handler as any).onInterimTranscript?.(text);
                    } else {
                      console.log(`\n[FINAL]   ${text}`);
                      void (handler as any).onFinalTranscript?.(text);
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
            } else {
              void handler.onCallStart();
            }
            break;
          }

          case "media":
            if (!msg.media?.payload) return;
            const pcmBuffer = decodeTwilioAudio(msg.media.payload);

            if (deepgramConn) {
              const canAccept = typeof (handler as any)?.isAcceptingAudio === "function"
                ? (handler as any).isAcceptingAudio()
                : true;
              if (canAccept) deepgramConn.safeSend(pcmBuffer);
            }
            if (handler && (handler as any).isNativeLive) {
              (handler as any).receiveAudio(pcmBuffer);
            }

            if (vadInstance) {
              const float32Array = new Float32Array(pcmBuffer.length);
              for (let i = 0; i < pcmBuffer.length / 2; i++) {
                const sample = pcmBuffer.readInt16LE(i * 2) / 32768.0;
                float32Array[i * 2] = sample;
                float32Array[i * 2 + 1] = sample;
              }
              try {
                vadInstance.processAudio(float32Array);
              } catch (e) {
                console.error("[VAD Error]", e);
              }
            }
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
            if (vadInstance) {
              vadInstance.destroy();
            }
            vadInstance = null;
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
