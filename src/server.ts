import "dotenv/config";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import {
  createDeepgramConnection,
  type DeepgramLiveConnection,
} from "./deepgram";
import { decodeTwilioAudio } from "./audio";
import { CallConversation } from "./conversation";
import { executeTool } from "./tools";
import { textToMulaw } from "./tts";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get("/twiml", (c) => {
  const ngrokUrl = process.env.NGROK_URL!;
  const wsUrl = ngrokUrl.replace("https://", "wss://") + "/media-stream";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="{{From}}"/>
    </Stream>
  </Connect>
</Response>`;
  return c.text(twiml, 200, { "Content-Type": "text/xml" });
});

app.get(
  "/media-stream",
  upgradeWebSocket((c) => {
    let deepgramConn: DeepgramLiveConnection | null = null;
    let conversation: CallConversation | null = null;
    let streamSid = "";
    let isSpeaking = false;

    async function playAudioToTwilio(
      ws: WSContext,
      text: string
    ): Promise<void> {
      if (!text.trim() || isSpeaking) return;
      isSpeaking = true;
      try {
        const chunks = await textToMulaw(text);
        for (const chunk of chunks) {
          if (ws.readyState !== 1) break;
          const mediaMsg = JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: chunk.toString("base64"),
            },
          });
          ws.send(mediaMsg);
          await new Promise((r) => setTimeout(r, 20));
        }
        ws.send(
          JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "done" },
          })
        );
      } catch (err) {
        console.error("[TTS] Error:", err);
      } finally {
        isSpeaking = false;
      }
    }

    async function handleFinalTranscript(
      transcript: string,
      ws: WSContext
    ): Promise<void> {
      if (!conversation || !transcript.trim()) return;

      const { text, toolCall } = await conversation.sendMessage(transcript);

      if (toolCall) {
        const toolResult = await executeTool(toolCall.name, toolCall.args);
        const finalText = await conversation.sendToolResult(
          toolCall.name,
          toolResult
        );
        await playAudioToTwilio(ws, finalText);
      } else {
        await playAudioToTwilio(ws, text);
      }
    }

    return {
      onOpen(_event, _ws) {
        console.log("[Server] Twilio connected");
      },

      async onMessage(event, ws) {
        let msg: {
          event?: string;
          streamSid?: string;
          start?: {
            callSid?: string;
            streamSid?: string;
            customParameters?: Record<string, string>;
            tracks?: unknown;
            mediaFormat?: unknown;
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

          case "start":
            streamSid =
              msg.streamSid ??
              msg.start?.streamSid ??
              "";
            const callerPhone =
              msg.start?.customParameters?.caller ??
              msg.start?.callSid ??
              "unknown";
            console.log(`[Server] Stream started — caller: ${callerPhone}`);

            conversation = new CallConversation(callerPhone);

            void (async () => {
              deepgramConn = await createDeepgramConnection(
                async (text, isFinal) => {
                  if (!isFinal) {
                    process.stdout.write(`\r[interim] ${text}    `);
                    return;
                  }
                  console.log(`\n[FINAL]  ${text}`);
                  await handleFinalTranscript(text, ws);
                },
                { sampleRate: 8000 }
              );

              setTimeout(async () => {
                if (!conversation) return;
                try {
                  const { text, toolCall } = await conversation.sendMessage(
                    "[SYSTEM: Call just connected. Greet the caller warmly in one sentence.]"
                  );
                  if (toolCall) {
                    const toolResult = await executeTool(
                      toolCall.name,
                      toolCall.args
                    );
                    const finalText = await conversation.sendToolResult(
                      toolCall.name,
                      toolResult
                    );
                    await playAudioToTwilio(ws, finalText);
                  } else {
                    await playAudioToTwilio(ws, text);
                  }
                } catch (e) {
                  console.error("[Server] Greeting error:", e);
                }
              }, 500);
            })();
            break;

          case "media":
            if (!deepgramConn || !msg.media?.payload) return;
            deepgramConn.send(decodeTwilioAudio(msg.media.payload));
            break;

          case "mark":
            console.log("[Server] Mark received:", msg.mark?.name);
            break;

          case "stop":
            console.log("[Server] Stream stopped");
            deepgramConn?.finish();
            deepgramConn = null;
            conversation = null;
            break;

          default:
            console.log("[Twilio] Unknown event:", msg.event);
        }
      },

      onClose() {
        console.log("[Twilio] WebSocket closed");
        deepgramConn?.finish();
        deepgramConn = null;
        conversation = null;
      },

      onError(event) {
        console.error("[Twilio] WebSocket error:", event);
      },
    };
  })
);

// Local test client — raw 16 kHz PCM (no Gemini/TTS)
app.get(
  "/audio",
  upgradeWebSocket((c) => {
    let deepgramConn: DeepgramLiveConnection | null = null;

    return {
      async onOpen(_event, ws) {
        console.log("[Server] WebSocket client connected");
        deepgramConn = await createDeepgramConnection((text, isFinal) => {
          const prefix = isFinal ? "[FINAL]  " : "[interim]";
          console.log(`${prefix} ${text}`);
          ws.send(JSON.stringify({ transcript: text, isFinal }));
        });
      },

      onMessage(event) {
        if (!deepgramConn) return;
        if (event.data instanceof Buffer) {
          deepgramConn.send(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          deepgramConn.send(Buffer.from(event.data));
        }
      },

      onClose() {
        console.log("[Server] Client disconnected");
        deepgramConn?.finish();
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
