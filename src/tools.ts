import { supabase } from "./db/supabase";
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

export async function checkAvailability(date: string): Promise<string> {
  console.log(`[Tool] check_availability: ${date}`);

  const { data, error } = await supabase
    .from("appointments")
    .select("appointment_time")
    .eq("appointment_date", date)
    .eq("status", "confirmed");

  if (error) {
    console.error("[Tool] Supabase error:", error);
    return "I'm having trouble checking availability right now. Please try again.";
  }

  const bookedTimes = new Set(data?.map((r) => r.appointment_time) ?? []);

  const allSlots = [
    "9:00 AM",
    "10:30 AM",
    "12:00 PM",
    "2:00 PM",
    "3:30 PM",
    "4:00 PM",
  ];
  const available = allSlots.filter((s) => !bookedTimes.has(s));

  if (available.length === 0) {
    return `No slots available on ${date}. Would you like to try another date?`;
  }

  return `Available slots on ${date}: ${available.join(", ")}`;
}

export async function bookAppointment(args: {
  name: string;
  date: string;
  time: string;
  reason?: string;
  caller_phone?: string;
}): Promise<string> {
  console.log(`[Tool] book_appointment:`, args);

  const { data: existing } = await supabase
    .from("appointments")
    .select("id")
    .eq("appointment_date", args.date)
    .eq("appointment_time", args.time)
    .eq("status", "confirmed")
    .maybeSingle();

  if (existing) {
    return `Sorry, ${args.time} on ${args.date} was just taken. Would you like a different time?`;
  }

  const confirmationId = `APT-${Date.now().toString(36).toUpperCase()}`;

  const { error } = await supabase
    .from("appointments")
    .insert({
      confirmation_id: confirmationId,
      caller_phone: args.caller_phone ?? "unknown",
      patient_name: args.name,
      appointment_date: args.date,
      appointment_time: args.time,
      reason: args.reason ?? null,
      status: "confirmed",
    })
    .select()
    .single();

  if (error) {
    console.error("[Tool] Supabase insert error:", error);
    return "I had trouble saving the appointment. Please try again.";
  }

  console.log(`[Tool] Appointment saved: ${confirmationId}`);
  return `Appointment confirmed! Confirmation ID: ${confirmationId}. ${args.name} is booked for ${args.date} at ${args.time}.`;
}

export async function sendConfirmationSms(args: {
  phone_number: string;
  message: string;
}): Promise<string> {
  console.log(`[Tool] send_sms to ${args.phone_number}`);

  if (!args.phone_number || args.phone_number === "unknown") {
    return "SMS skipped — no valid phone number.";
  }

  try {
    await twilioClient.messages.create({
      body: args.message,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: args.phone_number,
    });
    console.log(`[Tool] SMS sent to ${args.phone_number}`);
    return `SMS confirmation sent to ${args.phone_number}.`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Tool] SMS error:", msg);
    return "SMS could not be sent, but the appointment is still confirmed.";
  }
}

export async function hangUpCall(callSid: string): Promise<void> {
  try {
    await twilioClient.calls(callSid).update({ status: "completed" });
    console.log(`[Twilio] Call ${callSid} ended`);
  } catch (err: unknown) {
    console.error("[Twilio] Hang up error:", err instanceof Error ? err.message : String(err));
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "check_availability":
      return checkAvailability(String(args.date ?? ""));
    case "book_appointment":
      return bookAppointment({
        name: String(args.name ?? ""),
        date: String(args.date ?? ""),
        time: String(args.time ?? ""),
        reason:
          args.reason != null && args.reason !== ""
            ? String(args.reason)
            : undefined,
        caller_phone:
          args.caller_phone != null ? String(args.caller_phone) : undefined,
      });
    case "send_confirmation_sms":
      return sendConfirmationSms({
        phone_number: String(args.phone_number ?? ""),
        message: String(args.message ?? ""),
      });
    case "update_appointment_info":
      return "Info saved.";
    default:
      return `Unknown tool: ${name}`;
  }
}
