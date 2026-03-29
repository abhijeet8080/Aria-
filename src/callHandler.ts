import type { WSContext } from "hono/ws";
import {
  type AppointmentInfo,
  type CallSession,
  type CallState,
  createSession,
  isBookingComplete,
} from "./stateMachine";
import { CallConversation } from "./conversation";
import { CallLog } from "./db/callLog";
import { deleteSession } from "./db/redis";
import { executeTool } from "./tools";
import { chunkMulawForTwilio, textToMulaw } from "./tts";
import { impliesPrematureBookingClaim, isAffirmative } from "./intent";

const SILENCE_TIMEOUT_MS = 4000;
const MAX_NO_MATCH = 3;

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

export class CallHandler {
  public session: CallSession;
  private readonly conversation: CallConversation;
  private readonly ws: WSContext;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private transcriptQueue: Promise<void> = Promise.resolve();
  private isClosed = false;

  // ── Speak queue ──────────────────────────────────────────────────────────
  // Ensures only one TTS response plays at a time.
  // Any new speak() call waits for the current one to fully finish.
  private speakQueue: Promise<void> = Promise.resolve();
  private pendingMarkCount = 0; // track how many marks are in-flight

  private markResolvers = new Map<string, () => void>();
  private readonly callLog: CallLog;
  private readonly callSid: string;

  constructor(
    callerPhone: string,
    streamSid: string,
    callSid: string,
    ws: WSContext
  ) {
    this.session = createSession(callerPhone, streamSid);
    this.conversation = new CallConversation();
    this.ws = ws;
    this.callSid = callSid;
    this.callLog = new CallLog(callSid, callerPhone);
  }

  async onCallStart(): Promise<void> {
    await this.callLog.save();
    this.session.isBusy = true;
    try {
      const text = await this.askGemini(
        "[SYSTEM: Call just connected. Greet the caller warmly in one sentence.]"
      );
      await this.speak(text);
    } finally {
      this.session.isBusy = false;
    }
  }

  async onInterimTranscript(text: string): Promise<void> {
    if (text.trim().length > 0) {
      this.clearSilenceTimer(); // caller is speaking, cancel any pending reprompt
      this.session.lastActivityAt = Date.now();

      if (this.session.isSpeaking) {
        console.log("[Barge-in] Detected — stopping TTS playback");
        this.session.interruptRequested = true;
        this.sendClearAudio();
      }
    }
  }

  async onFinalTranscript(text: string): Promise<void> {
    if (this.isClosed) return;
    if (!text.trim()) return;

    this.clearSilenceTimer();
    this.session.lastActivityAt = Date.now();
    this.session.interruptRequested = false;
    this.session.isBusy = true; // covers entire Gemini+TTS pipeline
    this.callLog.addCallerLine(text);

    this.transcriptQueue = this.transcriptQueue.then(async () => {
      if (this.isClosed) return;
      try {
        console.log(`[State: ${this.session.state}] Final: "${text}"`);
        await this.processTranscript(text);
      } finally {
        this.session.isBusy = false;
        // Silence timer starts only via onMark() after the last audio chunk plays
      }
    }).catch((err) => {
      console.error("[Transcript queue error]", err);
      this.session.isBusy = false;
    });
  }

  onCallEnd(): void {
    this.isClosed = true;
    this.clearSilenceTimer();

    if (
      this.session.state === "CONFIRMING" &&
      isBookingComplete(this.session.appointment)
    ) {
      console.error(
        "[CRITICAL] Call ended in CONFIRMING with a complete appointment — booking may have been missed.",
        { callSid: this.callSid, appointment: this.session.appointment }
      );
    }

    void this.callLog.close(this.session.state).catch(console.error);
    void deleteSession(this.callSid).catch(console.error);
    console.log(`[CallHandler] Call ended in state: ${this.session.state}`);
  }

  /** Backwards compat — mark handling is done in onMark() */
  onPlaybackComplete(): void {}

  /** Called by server.ts on every Twilio mark echo */
  onMark(markName: string): void {
    console.log(`[CallHandler] Mark received: ${markName}`);
    const resolver = this.markResolvers.get(markName);
    if (resolver) {
      this.markResolvers.delete(markName);
      resolver(); // unblocks doSpeak() → queue advances
      this.session.isSpeaking = false;
      // Only start silence timer when nothing else is processing
      if (!this.session.isBusy) {
        this.resetSilenceTimer();
      }
    }
  }

  private waitForMark(markName: string): Promise<void> {
    return new Promise((resolve) => {
      this.markResolvers.set(markName, resolve);
      setTimeout(() => {
        if (this.markResolvers.has(markName)) {
          console.warn(`[Mark] Timeout waiting for ${markName}`);
          this.markResolvers.delete(markName);
          resolve();
        }
      }, 10_000);
    });
  }

  private async processTranscript(text: string): Promise<void> {
    if (this.session.state === "CONFIRMING") {
      await this.handleConfirmingTranscript(text);
      return;
    }
    await this.processTranscriptStreaming(text);
  }

  /** Non-streaming: forced tool modes + Layer 1 booking safety net. */
  private async handleConfirmingTranscript(text: string): Promise<void> {
    const { text: responseText, toolCall } =
      await this.conversation.sendMessage(text, this.session);

    if (toolCall) {
      await this.handleToolCall(toolCall.name, toolCall.args);
      return;
    }

    if (
      this.session.state === "CONFIRMING" &&
      isBookingComplete(this.session.appointment) &&
      (isAffirmative(text) || impliesPrematureBookingClaim(responseText))
    ) {
      console.log(
        "[Booking] Layer 1: forcing book_appointment (affirmative or premature booking claim in text)"
      );
      await this.handleToolCall("book_appointment", {
        name: this.session.appointment.name!,
        date: this.session.appointment.date!,
        time: this.session.appointment.time!,
        ...(this.session.appointment.reason
          ? { reason: this.session.appointment.reason }
          : {}),
      });
      return;
    }

    if (!responseText.trim()) {
      this.session.noMatchCount++;
      if (this.session.noMatchCount >= MAX_NO_MATCH) {
        await this.transitionTo("FAILED");
      }
      return;
    }

    this.session.noMatchCount = 0;

    await this.speak(responseText);
  }

  /** Gemini streaming + sentence TTS pipeline (parallel fetches, serial playback). */
  private async processTranscriptStreaming(text: string): Promise<void> {
    let sawText = false;

    const { toolCall } = await this.conversation.sendMessageStream(
      text,
      this.session,
      (sentence) => {
        sawText = true;
        console.log(`[Pipeline] TTS queued for: "${sentence.slice(0, 60)}${sentence.length > 60 ? "…" : ""}"`);
        const ttsPromise = textToMulaw(sentence);
        this.speakFromMulawPromise(ttsPromise, sentence);
      }
    );

    if (toolCall) {
      await this.handleToolCall(toolCall.name, toolCall.args);
      return;
    }

    if (!sawText) {
      this.session.noMatchCount++;
      if (this.session.noMatchCount >= MAX_NO_MATCH) {
        await this.transitionTo("FAILED");
      }
      return;
    }

    this.session.noMatchCount = 0;

    if (this.session.state === "GREETING") {
      this.session.state = "COLLECTING_INFO";
      console.log("[State] GREETING → COLLECTING_INFO");
    }
  }

  /** Queue playback of µ-law audio once the TTS fetch resolves (overlaps with next Gemini tokens). */
  private speakFromMulawPromise(
    ttsPromise: Promise<Buffer>,
    sentenceForLog: string
  ): void {
    if (sentenceForLog.trim()) {
      this.callLog.addAgentLine(sentenceForLog.trim());
    }
    this.speakQueue = this.speakQueue
      .then(async () => {
        if (this.isClosed) return;
        if (this.session.interruptRequested) {
          console.log("[Speak] Skipping — barge-in requested");
          return;
        }
        let mulawBuffer: Buffer;
        try {
          mulawBuffer = await ttsPromise;
        } catch (err) {
          console.error("[TTS] Fetch failed:", err);
          return;
        }
        if (mulawBuffer.length === 0) return;

        if (this.session.interruptRequested) {
          console.log("[Speak] Skipping — barge-in requested");
          return;
        }

        this.session.isSpeaking = true;
        this.session.interruptRequested = false;
        this.clearSilenceTimer();

        try {
          await this.doPlayBuffer(mulawBuffer);
        } catch (err) {
          console.error("[TTS] Playback error:", err);
          this.session.isSpeaking = false;
        }
      })
      .catch((err) => {
        console.error("[Speak queue]", err);
      });
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const toolArgs =
      name === "book_appointment"
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
      console.log("[Session] Appointment updated:", this.session.appointment);

      if (this.session.state === "GREETING") {
        this.session.state = "COLLECTING_INFO";
        console.log("[State] GREETING → COLLECTING_INFO");
      }

      const followUp = await this.conversation.sendToolResult(name, result);

      if (isBookingComplete(this.session.appointment)) {
        await this.transitionTo("CONFIRMING");
        return;
      }

      if (followUp.trim()) await this.speak(followUp);
      return;
    }

    if (name === "book_appointment") {
      const finalText = await this.conversation.sendToolResult(name, result);
      await this.speak(finalText);
      await this.transitionTo("BOOKED");
      return;
    }

    if (name === "send_confirmation_sms") {
      await this.conversation.sendToolResult(name, result);
      return;
    }

    const followUp = await this.conversation.sendToolResult(name, result);
    if (followUp.trim()) await this.speak(followUp);
  }

  private async transitionTo(newState: CallState): Promise<void> {
    console.log(`[State] ${this.session.state} → ${newState}`);
    this.session.state = newState;

    if (newState === "CONFIRMING") {
      await this.speak(
        await this.askGemini(
          "[SYSTEM: All info collected. Read back the appointment details and ask for confirmation.]"
        )
      );
    }

    if (newState === "FAILED") {
      await this.speak(
        await this.askGemini(
          "[SYSTEM: Could not understand caller after multiple attempts. Apologise and end politely.]"
        )
      );
    }
  }

  private speak(text: string): Promise<void> {
    if (text.trim()) {
      this.callLog.addAgentLine(text);
    }
    this.speakQueue = this.speakQueue
      .then(() => {
        if (this.isClosed) return;
        return this.doSpeak(text);
      })
      .catch((err) => {
        console.error("[Speak queue]", err);
      });
    return this.speakQueue;
  }

  private async doSpeak(text: string): Promise<void> {
    if (!text.trim()) return;

    if (this.session.interruptRequested) {
      console.log("[Speak] Skipping queued utterance due to barge-in");
      return;
    }

    this.session.isSpeaking = true;
    this.session.interruptRequested = false;
    this.clearSilenceTimer();

    try {
      const mulawBuffer = await textToMulaw(text);
      await this.doPlayBuffer(mulawBuffer);
    } catch (err) {
      console.error("[TTS] Error:", err);
      this.session.isSpeaking = false;
    }
  }

  private async doPlayBuffer(mulawBuffer: Buffer): Promise<void> {
    try {
      const chunks = chunkMulawForTwilio(mulawBuffer);

      for (const chunk of chunks) {
        if (this.session.interruptRequested) {
          console.log("[Barge-in] Cutting TTS mid-playback");
          this.sendClearAudio();
          this.session.isSpeaking = false;
          return;
        }
        if (this.ws.readyState !== 1) {
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
      console.error("[TTS] Error:", err);
      this.session.isSpeaking = false;
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

  private async askGemini(systemPrompt: string): Promise<string> {
    const { text, toolCall } = await this.conversation.sendMessage(
      systemPrompt,
      this.session
    );
    if (toolCall) {
      await this.handleToolCall(toolCall.name, toolCall.args);
      return "";
    }
    return text;
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      void this.onSilenceTimeout();
    }, SILENCE_TIMEOUT_MS);
  }

  private async onSilenceTimeout(): Promise<void> {
    // Don't fire if we're generating a response OR playing audio
    if (this.session.isBusy || this.session.isSpeaking) {
      this.resetSilenceTimer(); // reschedule and check again
      return;
    }
    console.log("[Silence] 4s of silence — reprompting");
    await this.handleSilenceReprompt();
  }

  private async handleSilenceReprompt(): Promise<void> {
    if (this.session.isBusy) return; // double-guard
    this.session.isBusy = true;
    try {
      const text = await this.askGemini(
        "[SYSTEM: Caller has been silent for a while. Gently prompt them to continue in one sentence.]"
      );
      await this.speak(text);
    } finally {
      this.session.isBusy = false;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
