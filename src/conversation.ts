import {
  ChatSession,
  GoogleGenerativeAI,
  SchemaType,
  type FunctionDeclaration,
  type Tool,
} from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "check_availability",
        description:
          "Check available appointment slots for a given date",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            date: {
              type: SchemaType.STRING,
              description: "Date to check in YYYY-MM-DD format",
            },
          },
          required: ["date"],
        },
      } as FunctionDeclaration,
      {
        name: "book_appointment",
        description: "Book an appointment for the caller",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            name: {
              type: SchemaType.STRING,
              description: "Caller's full name",
            },
            date: {
              type: SchemaType.STRING,
              description: "Date in YYYY-MM-DD",
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
          required: ["name", "date", "time"],
        },
      } as FunctionDeclaration,
      {
        name: "send_confirmation_sms",
        description: "Send a confirmation SMS to the caller",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            phone_number: {
              type: SchemaType.STRING,
              description: "Caller phone number",
            },
            message: {
              type: SchemaType.STRING,
              description: "SMS message text",
            },
          },
          required: ["phone_number", "message"],
        },
      } as FunctionDeclaration,
    ],
  },
];

const SYSTEM_PROMPT = `You are a friendly AI receptionist for a medical clinic.
Your job is to:
- Greet callers warmly
- Help them book, check, or cancel appointments
- Answer basic FAQs about the clinic
- Keep responses SHORT — 1-2 sentences max since this is a phone call
- Never ask more than one question at a time
- When you have enough info, use the available tools to book or check appointments

Clinic hours: Monday–Friday 9am–5pm.
Address: 123 Health Street, Bangalore.
Do not discuss anything unrelated to the clinic.`;

export class CallConversation {
  private readonly chat: ChatSession;
  public readonly callerPhone: string;

  constructor(callerPhone: string) {
    this.callerPhone = callerPhone;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_PROMPT,
      tools,
    });

    this.chat = model.startChat({ history: [] });
  }

  async sendMessage(transcript: string): Promise<{
    text: string;
    toolCall?: { name: string; args: Record<string, unknown> };
  }> {
    console.log(`[Gemini] User said: "${transcript}"`);

    const result = await this.chat.sendMessage(transcript);
    const response = result.response;

    const functionCall = response.functionCalls()?.[0];
    if (functionCall) {
      console.log(`[Gemini] Tool call: ${functionCall.name}`, functionCall.args);
      return {
        text: "",
        toolCall: {
          name: functionCall.name,
          args: functionCall.args as Record<string, unknown>,
        },
      };
    }

    const text = response.text();
    console.log(`[Gemini] Response: "${text}"`);
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
    console.log(`[Gemini] After tool: "${text}"`);
    return text;
  }
}
