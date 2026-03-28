// Mock availability slots — Phase 6 will replace with real DB queries
export async function checkAvailability(date: string): Promise<string> {
  console.log(`[Tool] check_availability for ${date}`);
  const slots = ["9:00 AM", "10:30 AM", "2:00 PM", "4:00 PM"];
  return `Available slots on ${date}: ${slots.join(", ")}`;
}

export async function bookAppointment(args: {
  name: string;
  date: string;
  time: string;
  reason?: string;
}): Promise<string> {
  console.log("[Tool] book_appointment", args);
  const confirmationId = `APT-${Math.floor(Math.random() * 90000) + 10000}`;
  return `Appointment booked for ${args.name} on ${args.date} at ${args.time}. Confirmation ID: ${confirmationId}`;
}

export async function sendConfirmationSms(args: {
  phone_number: string;
  message: string;
}): Promise<string> {
  console.log(
    `[Tool] send_sms to ${args.phone_number}: ${args.message}`
  );
  return `SMS sent to ${args.phone_number}`;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "check_availability":
      return checkAvailability(String(args.date));
    case "book_appointment":
      return bookAppointment({
        name: String(args.name),
        date: String(args.date),
        time: String(args.time),
        reason: args.reason != null ? String(args.reason) : undefined,
      });
    case "send_confirmation_sms":
      return sendConfirmationSms({
        phone_number: String(args.phone_number),
        message: String(args.message),
      });
    default:
      return `Unknown tool: ${name}`;
  }
}
