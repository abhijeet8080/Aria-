export type CallState =
  | "GREETING"
  | "COLLECTING_INFO"
  | "CONFIRMING"
  | "BOOKED"
  | "FAILED";

export interface AppointmentInfo {
  name?: string;
  date?: string;
  time?: string;
  reason?: string;
}

export interface CallSession {
  state: CallState;
  appointment: AppointmentInfo;
  callerPhone: string;
  streamSid: string;
  noMatchCount: number;
  lastActivityAt: number;
  isSpeaking: boolean;        // true while audio chunks are being sent
  isBusy: boolean;            // true while Gemini/TTS fetch is in progress
  interruptRequested: boolean;
  language: string;           // BCP-47 code e.g. "en-US", "hi-IN" — detected at runtime
}

export function createSession(
  callerPhone: string,
  streamSid: string
): CallSession {
  return {
    state: "GREETING",
    appointment: {},
    callerPhone,
    streamSid,
    noMatchCount: 0,
    lastActivityAt: Date.now(),
    isSpeaking: false,
    isBusy: false,
    interruptRequested: false,
    language: "en-US",
  };
}

export function missingFields(appt: AppointmentInfo): string[] {
  const missing: string[] = [];
  if (!appt.name) missing.push("name");
  if (!appt.reason) missing.push("reason for visit");
  if (!appt.date) missing.push("date");
  if (!appt.time) missing.push("time");
  return missing;
}

export function isBookingComplete(appt: AppointmentInfo): boolean {
  return missingFields(appt).length === 0;
}

export function formatAppointmentSummary(appt: AppointmentInfo): string {
  return `${appt.name} on ${appt.date} at ${appt.time}${
    appt.reason ? ` for ${appt.reason}` : ""
  }`;
}
