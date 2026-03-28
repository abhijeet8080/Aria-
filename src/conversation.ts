import {
  ChatSession,
  GoogleGenerativeAI,
  SchemaType,
  type FunctionDeclaration,
  type Tool,
} from "@google/generative-ai";
import {
  type CallSession,
  formatAppointmentSummary,
  missingFields,
} from "./stateMachine";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "update_appointment_info",
        description:
          "Store any appointment details the caller just provided",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            name: {
              type: SchemaType.STRING,
              description: "Caller full name",
            },
            date: {
              type: SchemaType.STRING,
              description: "Date YYYY-MM-DD",
            },
            time: {
              type: SchemaType.STRING,
              description: "Time e.g. 10:00 AM",
            },
            reason: {
              type: SchemaType.STRING,
              description: "Reason for visit",
            },
          },
        },
      } as FunctionDeclaration,
      {
        name: "check_availability",
        description: "Check available slots for a date",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            date: {
              type: SchemaType.STRING,
              description: "Date YYYY-MM-DD",
            },
          },
          required: ["date"],
        },
      } as FunctionDeclaration,
      {
        name: "book_appointment",
        description:
          "Book the appointment once all details are confirmed",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            name: { type: SchemaType.STRING },
            date: { type: SchemaType.STRING },
            time: { type: SchemaType.STRING },
            reason: { type: SchemaType.STRING },
          },
          required: ["name", "date", "time"],
        },
      } as FunctionDeclaration,
      {
        name: "send_confirmation_sms",
        description: "Send booking confirmation SMS to caller",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            phone_number: { type: SchemaType.STRING },
            message: { type: SchemaType.STRING },
          },
          required: ["phone_number", "message"],
        },
      } as FunctionDeclaration,
    ],
  },
];

const BASE_SYSTEM_PROMPT = `You are a friendly AI receptionist for a medical clinic.
Rules:
- Keep every response under 2 sentences — this is a phone call
- Never ask more than one question at a time
- Today's date is ${new Date().toISOString().split("T")[0]}
- Clinic hours: Mon–Fri 9am–5pm. Address: 123 Health Street, Bangalore
- Only discuss clinic-related topics`;

function stateInstruction(session: CallSession): string {
  switch (session.state) {
    case "GREETING":
      return "State: GREETING. Warmly greet the caller and ask how you can help.";

    case "COLLECTING_INFO": {
      const missing = missingFields(session.appointment);
      const collected = JSON.stringify(session.appointment);
      return `State: COLLECTING_INFO.
Collected so far: ${collected}.
Still need: ${missing.join(", ") || "(none — use tools to finalize)"}.
Ask for the next missing field only. Use update_appointment_info when the caller provides any detail.`;
    }

    case "CONFIRMING":
      return `State: CONFIRMING.
Read back the full booking: ${formatAppointmentSummary(session.appointment)}.
Ask the caller to confirm. If they confirm, call book_appointment. If they want to change something, say which field to correct.`;

    case "BOOKED":
      return `State: BOOKED. The appointment is confirmed. Call send_confirmation_sms, then say a warm goodbye.`;

    case "FAILED":
      return "State: FAILED. Apologise, offer to transfer to a human, and end the call politely.";
  }
}

export class CallConversation {
  private readonly chat: ChatSession;

  constructor() {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: BASE_SYSTEM_PROMPT,
      tools,
    });

    this.chat = model.startChat({ history: [] });
  }

  async sendMessage(
    userText: string,
    session: CallSession
  ): Promise<{
    text: string;
    toolCall?: { name: string; args: Record<string, unknown> };
  }> {
    const fullMessage = `[${stateInstruction(session)}]\nCaller said: "${userText}"`;
    console.log(`[Gemini ←] ${userText} (state: ${session.state})`);

    const result = await this.chat.sendMessage(fullMessage);
    const response = result.response;

    const functionCall = response.functionCalls()?.[0];
    if (functionCall) {
      console.log(`[Gemini tool] ${functionCall.name}`, functionCall.args);
      return {
        text: "",
        toolCall: {
          name: functionCall.name,
          args: functionCall.args as Record<string, unknown>,
        },
      };
    }

    const text = response.text();
    console.log(`[Gemini →] ${text}`);
    return { text };
  }

  async sendToolResult(toolName: string, result: string): Promise<string> {
    const response = await this.chat.sendMessage([
      {
        functionResponse: {
          name: toolName,
          response: { result },
        },
      },
    ]);
    const text = response.response.text();
    console.log(`[Gemini tool result →] ${text}`);
    return text;
  }
}
