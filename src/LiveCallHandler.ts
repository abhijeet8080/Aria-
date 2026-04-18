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
import { executeTool, hangUpCall, sendConfirmationSms } from "./tools";
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
  private geminiAudioChunks: Buffer[] = [];
  private pendingHangup = false;

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

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    this.geminiWs = new WebSocket(url);

    this.geminiWs.on("open", () => {
      console.log("[Gemini Live] Connected");
      this.sendSetup();
    });

    this.geminiWs.on("message", async (data) => {
      if (this.isClosed) return;
      const raw = data.toString();
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        console.error("[Gemini Live] Non-JSON message:", raw.slice(0, 300));
        return;
      }
      // Log any server-side error before it closes the socket
      if (msg.error) {
        console.error("[Gemini Live] Server error:", JSON.stringify(msg.error));
      }
      try {
        await this.handleGeminiMessage(msg);
      } catch (err) {
        console.error("[Gemini Live] Handler error:", err);
      }
    });

    this.geminiWs.on("close", (code, reason) => {
      console.log(`[Gemini Live] Disconnected — code: ${code}, reason: ${reason?.toString() || "(none)"}`);
    });

    this.geminiWs.on("error", (e) => {
      console.error("[Gemini Live] Error", e);
    });
  }

  private getDynamicStateInstruction(): string {
    const missing = missingFields(this.session.appointment);
    const collected = JSON.stringify(this.session.appointment);
    const langNote = this.session.language && !this.session.language.startsWith("en")
      ? ` Respond in language: ${this.session.language}.`
      : "";

    let statePrompt = `Current State: ${this.session.state}.${langNote}`;
    if (this.session.state === "COLLECTING_INFO") {
      if (missing.length === 0) {
        statePrompt += `\nAll details collected: ${collected}. Read back a brief appointment summary and ask the caller to confirm.`;
      } else {
        statePrompt += `\nCollected so far: ${collected}.\nStill need: ${missing.join(", ")}.\nAsk for the next missing field only.`;
      }
    } else if (this.session.state === "CONFIRMING") {
      statePrompt += `\nRead back the full booking: ${formatAppointmentSummary(this.session.appointment)}.\nAsk the caller to confirm. If they confirm, you MUST call book_appointment.`;
    } else if (this.session.state === "BOOKED") {
      statePrompt += `\nThe appointment is confirmed. Say a warm, brief one-sentence goodbye only.`;
    }
    return statePrompt;
  }

  private sendSetup() {
    const fullSystemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${this.getDynamicStateInstruction()}`;

    const setupMsg = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
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
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: fullSystemPrompt }]
        },
        tools: tools
      }
    };
    const setupJson = JSON.stringify(setupMsg);
    console.log("[Gemini Live] Sending setup:", setupJson.slice(0, 500));
    this.geminiWs?.send(setupJson);
    // Initial greeting is sent only after Gemini acknowledges the setup
    // via a "setupComplete" event — see handleGeminiMessage.
  }

  public receiveAudio(pcm8kBuffer: Buffer) {
    if (this.isClosed || !this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (this.session.state === "BOOKED" || this.session.state === "FAILED") return;

    if (this.session.isSpeaking) return;

    // Upsample 8kHz → 16kHz (nearest-neighbour duplication)
    const pcm16kBuffer = Buffer.alloc(pcm8kBuffer.length * 2);
    for (let i = 0; i < pcm8kBuffer.length / 2; i++) {
      const sample = pcm8kBuffer.readInt16LE(i * 2);
      pcm16kBuffer.writeInt16LE(sample, i * 4);
      pcm16kBuffer.writeInt16LE(sample, i * 4 + 2);
    }

    const payload = {
      realtimeInput: {
        audio: {
          data: pcm16kBuffer.toString("base64"),
          mimeType: "audio/pcm;rate=16000"
        }
      }
    };
    this.geminiWs.send(JSON.stringify(payload));
  }

  public handleBargeIn() {
    if (this.isClosed || !this.session.isSpeaking) return;
    this.session.interruptRequested = true;
    this.session.isSpeaking = false;
    this.geminiAudioChunks = [];
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
    // Gemini confirms the setup is complete — now it's safe to send the greeting
    if (msg.setupComplete) {
      console.log("[Gemini Live] Setup complete — sending greeting");
      const initMsg = {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM: Call just connected. Greet the caller warmly in one sentence.]" }] }],
          turnComplete: true
        }
      };
      this.geminiWs?.send(JSON.stringify(initMsg));
    }

    if (msg.serverContent) {
      // Live transcripts — log and persist to call log
      if (msg.serverContent.inputTranscription?.text) {
        const text: string = msg.serverContent.inputTranscription.text;
        console.log(`[Caller] ${text}`);
        this.callLog.addCallerLine(text);
      }
      if (msg.serverContent.outputTranscription?.text) {
        const text: string = msg.serverContent.outputTranscription.text;
        console.log(`[Agent]  ${text}`);
        this.callLog.addAgentLine(text);
      }

      if (msg.serverContent.modelTurn) {
        this.session.isSpeaking = true;
        this.session.interruptRequested = false;

        const parts = msg.serverContent.modelTurn.parts;
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            const mulawBuffer = pcm24kToMulaw8k(part.inlineData.data);
            this.geminiAudioChunks.push(mulawBuffer);
          }
        }
      }

      if (msg.serverContent.turnComplete) {
        let playedAudio = false;
        if (this.geminiAudioChunks.length > 0) {
          const combined = Buffer.concat(this.geminiAudioChunks);
          this.geminiAudioChunks = [];
          console.log(`[Audio] Playing buffered Gemini audio — ${combined.length} bytes mulaw`);
          await this.doPlayBuffer(combined);
          playedAudio = true;
        }
        this.session.isSpeaking = false;
        console.log("[Audio] Gemini turn complete — caller audio unblocked");

        // Only hang up after a turn that actually had audio (i.e. the goodbye message).
        // Skips the silent interrupt-acknowledgement turn that arrives right after tool calls.
        if (this.pendingHangup && playedAudio) {
          this.pendingHangup = false;
          console.log("[State] Goodbye played — hanging up");
          void hangUpCall(this.callSid).catch(console.error);
        }
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
        
        // toolResponse must be sent first — it closes the pending tool call turn
        const toolResponseMsg = {
          toolResponse: {
            functionResponses: responses
          }
        };
        this.geminiWs?.send(JSON.stringify(toolResponseMsg));

        // Follow up with a state update so Gemini knows the current context
        const updateMsg = {
          clientContent: {
            turns: [{
              role: "user",
              parts: [{ text: `[SYSTEM STATE UPDATE]\n${this.getDynamicStateInstruction()}` }]
            }],
            turnComplete: true
          }
        };
        this.geminiWs?.send(JSON.stringify(updateMsg));
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
      console.log("[State] → BOOKED — waiting for goodbye before hang-up");
      this.pendingHangup = true;

      // Send confirmation SMS
      if (this.session.callerPhone && this.session.callerPhone !== "unknown") {
        const appt = this.session.appointment;
        const smsMsg = `Your appointment is confirmed! ${appt.name} on ${appt.date} at ${appt.time}${appt.reason ? ` for ${appt.reason}` : ""}.`;
        void sendConfirmationSms({ phone_number: this.session.callerPhone, message: smsMsg }).catch(console.error);
      }

      // Safety fallback: if Gemini never delivers the goodbye, hang up after 15 s
      setTimeout(() => {
        if (this.pendingHangup) {
          console.log("[State] Safety timer fired — hanging up");
          this.pendingHangup = false;
          void hangUpCall(this.callSid).catch(console.error);
        }
      }, 15_000);
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
