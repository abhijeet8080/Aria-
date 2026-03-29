import { supabase } from "./supabase";

export interface TranscriptEntry {
  role: "agent" | "caller";
  text: string;
  timestamp: string;
}

export class CallLog {
  private readonly callSid: string;
  private readonly callerPhone: string;
  private transcript: TranscriptEntry[] = [];
  private readonly startedAt: string;

  constructor(callSid: string, callerPhone: string) {
    this.callSid = callSid;
    this.callerPhone = callerPhone;
    this.startedAt = new Date().toISOString();
  }

  addCallerLine(text: string): void {
    this.transcript.push({
      role: "caller",
      text,
      timestamp: new Date().toISOString(),
    });
  }

  addAgentLine(text: string): void {
    this.transcript.push({
      role: "agent",
      text,
      timestamp: new Date().toISOString(),
    });
  }

  async save(): Promise<void> {
    const { error } = await supabase.from("call_logs").upsert({
      call_sid: this.callSid,
      caller_phone: this.callerPhone,
      started_at: this.startedAt,
      transcript: this.transcript,
    });
    if (error) console.error("[CallLog] Save error:", error);
  }

  async close(
    finalState: string,
    appointmentId?: string
  ): Promise<void> {
    const { error } = await supabase
      .from("call_logs")
      .update({
        ended_at: new Date().toISOString(),
        final_state: finalState,
        transcript: this.transcript,
        ...(appointmentId ? { appointment_id: appointmentId } : {}),
      })
      .eq("call_sid", this.callSid);

    if (error) console.error("[CallLog] Close error:", error);
    else
      console.log(
        `[CallLog] Saved — state: ${finalState}, entries: ${this.transcript.length}`
      );
  }
}
