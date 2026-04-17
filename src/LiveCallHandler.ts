import type { WSContext } from "hono/ws";
import WebSocket from "ws";
import { mulaw } from "alawmulaw";
import { chunkMulawForTwilio } from "./tts";
import {
  type AppointmentInfo,
  type CallSession,
  type CallState,
  createSession,
  isBookingComplete,
  formatAppointmentSummary,
  missingFields,
} from "./stateMachine";
import { CallLog } from "./db/callLog";
import { deleteSession } from "./db/redis";
import { executeTool } from "./tools";
import { tools, BASE_SYSTEM_PROMPT } from "./conversation";

function mergeAppointmentArgs(
  args: Record<string, unknown>
): Partial<AppointmentInfo> {
  const out: Partial<AppointmentInfo> = {};
  for (const key of ["name", "date", "time", "reason"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

function pcm24kToMulaw8k(pcm24kBase64: string): Buffer {
  const pcm24k = Buffer.from(pcm24kBase64, "base64");
  const numSamples = Math.floor(pcm24k.length / 2 / 3);
  const pcm8k = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcm24k.readInt16LE(i * 2 * 3);
    pcm8k.writeInt16LE(sample, i * 2);
  }
  const pcmSamples = new Int16Array(pcm8k.buffer, pcm8k.byteOffset, pcm8k.length / 2);
  const mulawBytes = mulaw.encode(pcmSamples);
  return Buffer.from(mulawBytes.buffer, mulawBytes.byteOffset, mulawBytes.byteLength);
}

export class CallHandler {
  public isNativeLive = true;
  public session: CallSession;
  private readonly ws: WSContext;
  private readonly callLog: CallLog;
  private readonly callSid: string;
  private isClosed = false;

  private geminiWs: WebSocket | null = null;
  private markResolvers = new Map<string, () => void>();
  private pendingMarkCount = 0;

  constructor(
    callerPhone: string,
    streamSid: string,
    callSid: string,
    ws: WSContext
  ) {
    this.session = createSession(callerPhone, streamSid);
    this.ws = ws;
    this.callSid = callSid;
    this.callLog = new CallLog(callSid, callerPhone);
  }

  async onCallStart(): Promise<void> {
    await this.callLog.save();
    this.connectGemini();
  }

  private connectGemini() {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiWrite?key=${GEMINI_API_KEY}`;
    this.geminiWs = new WebSocket(url);

    this.geminiWs.on("open", () => {
      console.log("[Gemini Live] Connected");
      this.sendSetup();
    });

    this.geminiWs.on("message", async (data) => {
      if (this.isClosed) return;
      try {
        const msg = JSON.parse(data.toString());
        await this.handleGeminiMessage(msg);
      } catch (err) {
        console.error("[Gemini Live] Message parse error", err);
      }
    });

    this.geminiWs.on("close", () => {
      console.log("[Gemini Live] Disconnected");
    });

    this.geminiWs.on("error", (e) => {
      console.error("[Gemini Live] Error", e);
    });
  }

  private getDynamicStateInstruction(): string {
    const missing = missingFields(this.session.appointment);
    const collected = JSON.stringify(this.session.appointment);
    
    let statePrompt = `Current State: ${this.session.state}.`;
    if (this.session.state === "COLLECTING_INFO") {
      statePrompt += `\nCollected so far: ${collected}.\nStill need: ${missing.join(", ") || "(none — use tools to finalize)"}.\nAsk for the next missing field only.`;
    } else if (this.session.state === "CONFIRMING") {
      statePrompt += `\nRead back the full booking: ${formatAppointmentSummary(this.session.appointment)}.\nAsk the caller to confirm. If they confirm, you MUST call book_appointment.`;
    }
    return statePrompt;
  }

  private sendSetup() {
    const fullSystemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${this.getDynamicStateInstruction()}`;

    const setupMsg = {
      setup: {
        model: "models/gemini-2.0-flash-exp",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
             voiceConfig: {
                prebuiltVoiceConfig: {
                   voiceName: "Aoede"
                }
             }
          }
        },
        systemInstruction: {
          parts: [{ text: fullSystemPrompt }]
        },
        tools: tools
      }
    };
    this.geminiWs?.send(JSON.stringify(setupMsg));

    const initMsg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Hello! I just connected." }] }],
        turnComplete: true
      }
    };
    this.geminiWs?.send(JSON.stringify(initMsg));
  }

  public receiveAudio(pcm8kBuffer: Buffer) {
    if (this.isClosed || !this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;

    if (!this.session.isSpeaking) {
      // Upsample 8kHz to 16kHz
      const pcm16kBuffer = Buffer.alloc(pcm8kBuffer.length * 2);
      for (let i = 0; i < pcm8kBuffer.length / 2; i++) {
        const sample = pcm8kBuffer.readInt16LE(i * 2);
        pcm16kBuffer.writeInt16LE(sample, i * 4);
        pcm16kBuffer.writeInt16LE(sample, i * 4 + 2);
      }

      const payload = {
        realtimeInput: {
          mediaChunks: [{
            mimeType: "audio/pcm;rate=16000",
            data: pcm16kBuffer.toString("base64")
          }]
        }
      };
      this.geminiWs.send(JSON.stringify(payload));
    }
  }

  public handleBargeIn() {
    if (this.isClosed || !this.session.isSpeaking) return;
    this.session.interruptRequested = true;
    this.session.isSpeaking = false;
    this.sendClearAudio();

    if (this.geminiWs && this.geminiWs.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({ clientContent: { turnComplete: true } }));
    }
  }

  private sendClearAudio(): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        event: "clear",
        streamSid: this.session.streamSid,
      })
    );
  }

  private async handleGeminiMessage(msg: any) {
    if (msg.serverContent) {
      if (msg.serverContent.modelTurn) {
        this.session.isSpeaking = true;
        this.session.interruptRequested = false;
        
        const parts = msg.serverContent.modelTurn.parts;
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
             const mulawBuffer = pcm24kToMulaw8k(part.inlineData.data);
             await this.doPlayBuffer(mulawBuffer);
          }
        }
      }
      if (msg.serverContent.turnComplete) {
        this.session.isSpeaking = false;
      }
    }
    
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const responses: any[] = [];
        for (const call of functionCalls) {
          const result = await this.handleToolCall(call.name, call.args);
          responses.push({
            id: call.id,
            name: call.name,
            response: { result }
          });
        }
        
        const updateMsg = {
           clientContent: {
              turnComplete: true,
              turns: [{
                 role: "user",
                 parts: [{ text: `[SYSTEM STATE UPDATE]\n${this.getDynamicStateInstruction()}` }]
              }]
           }
        };
        this.geminiWs?.send(JSON.stringify(updateMsg));

        const toolResponseMsg = {
          toolResponse: {
            functionResponses: responses
          }
        };
        this.geminiWs?.send(JSON.stringify(toolResponseMsg));
      }
    }
  }

  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
    const toolArgs = name === "book_appointment" 
      ? { ...args, caller_phone: this.session.callerPhone } 
      : args;
    
    const result = await executeTool(name, toolArgs);

    if (name === "update_appointment_info") {
      const mergedArgs = mergeAppointmentArgs(args);
      if (mergedArgs.reason && this.session.appointment.reason && mergedArgs.reason !== this.session.appointment.reason) {
        mergedArgs.reason = `${this.session.appointment.reason} ${mergedArgs.reason}`;
      }
      this.session.appointment = {
        ...this.session.appointment,
        ...mergedArgs,
      };
      
      if (this.session.state === "GREETING") {
        this.session.state = "COLLECTING_INFO";
      } else if (isBookingComplete(this.session.appointment)) {
        this.session.state = "CONFIRMING";
      }
    } else if (name === "book_appointment") {
      this.session.state = "BOOKED";
    }

    return result;
  }

  public onMark(markName: string): void {
    const resolver = this.markResolvers.get(markName);
    if (resolver) {
      this.markResolvers.delete(markName);
      resolver();
    }
  }

  private waitForMark(markName: string): Promise<void> {
    return new Promise((resolve) => {
      this.markResolvers.set(markName, resolve);
      setTimeout(() => {
        if (this.markResolvers.has(markName)) {
          this.markResolvers.delete(markName);
          resolve();
        }
      }, 10_000);
    });
  }

  private async doPlayBuffer(mulawBuffer: Buffer): Promise<void> {
    if (this.session.interruptRequested) return;
    try {
      const chunks = chunkMulawForTwilio(mulawBuffer);
      for (const chunk of chunks) {
        if (this.session.interruptRequested || this.isClosed || this.ws.readyState !== 1) {
          this.session.isSpeaking = false;
          return;
        }
        this.ws.send(
          JSON.stringify({
            event: "media",
            streamSid: this.session.streamSid,
            media: { payload: chunk.toString("base64") },
          })
        );
        await new Promise((r) => setTimeout(r, 20));
      }

      this.pendingMarkCount++;
      const myMark = `tts-done-${this.pendingMarkCount}`;
      this.ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: this.session.streamSid,
          mark: { name: myMark },
        })
      );
      await this.waitForMark(myMark);
    } catch (err) {
      console.error("[TTS Playback Error]", err);
      this.session.isSpeaking = false;
    }
  }

  onCallEnd(): void {
    this.isClosed = true;
    if (this.geminiWs && this.geminiWs.readyState === WebSocket.OPEN) {
      this.geminiWs.close();
    }
    void deleteSession(this.callSid).catch(console.error);
    void this.callLog.close(this.session.state).catch(console.error);
    console.log(`[CallHandler] Call ended in state: ${this.session.state}`);
  }
}
