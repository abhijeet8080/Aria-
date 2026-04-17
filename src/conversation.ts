import {
  ChatSession,
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  FunctionCallingMode,
  type Tool,
} from "@google/generative-ai";
import {
  type CallSession,
  formatAppointmentSummary,
  missingFields,
} from "./stateMachine";
import { isAffirmative } from "./intent";
import { extractCompleteSentences } from "./sentenceSplitter";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export const tools: Tool[] = [
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

export const BASE_SYSTEM_PROMPT = `You are a friendly AI receptionist for a medical clinic.
Rules:
- Keep every response under 2 sentences — this is a phone call
- Never ask more than one question at a time
- Today's date is ${new Date().toISOString().split("T")[0]}
- Clinic hours: Mon–Fri 9am–5pm. Address: 123 Health Street, Bangalore
- Only discuss clinic-related topics
- CRITICAL: Never tell the caller the appointment is "confirmed", "booked", "all set", "scheduled", or "on the books" until the book_appointment tool has been called and returned success in this conversation. Do not imply a completed booking with plain text alone.`;

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
Ask the caller to confirm. If they clearly confirm (yes / correct / sounds good), you MUST call book_appointment with the details above — do not describe the booking as confirmed in text only. If they want to change something, help them correct the field and do not call book_appointment until they confirm again.`;

    case "BOOKED":
      return `State: BOOKED. The appointment is confirmed. Call send_confirmation_sms, then say a warm goodbye.`;

    case "FAILED":
      return "State: FAILED. Apologise, offer to transfer to a human, and end the call politely.";
  }
}

export class CallConversation {
  private readonly model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
  private chat: ChatSession;

  constructor() {
    this.model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: BASE_SYSTEM_PROMPT,
      tools,
    });

    this.chat = this.model.startChat({ history: [] });
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

    if (session.state === "CONFIRMING" && isAffirmative(userText)) {
      const forced = await this.sendConfirmingAffirmative(fullMessage);
      if (forced !== null) {
        return forced;
      }
    }

    return this.sendMessageNormal(fullMessage);
  }

  /**
   * Streaming generation: invokes `onSentence` for each complete sentence as tokens arrive.
   * Used for lower latency on non-CONFIRMING turns. Stops TTS when a tool call is detected.
   */
  async sendMessageStream(
    userText: string,
    session: CallSession,
    onSentence: (sentence: string) => void
  ): Promise<{
    toolCall?: { name: string; args: Record<string, unknown> };
  }> {
    const fullMessage = `[${stateInstruction(session)}]\nCaller said: "${userText}"`;
    console.log(`[Gemini ←] ${userText} (state: ${session.state}) [stream]`);

    const streamResult = await this.chat.sendMessageStream(fullMessage);
    let toolCall: { name: string; args: Record<string, unknown> } | undefined;
    let buffer = "";

    try {
      for await (const chunk of streamResult.stream) {
        let fnCalls: ReturnType<typeof chunk.functionCalls> | undefined;
        try {
          fnCalls = chunk.functionCalls();
        } catch {
          fnCalls = undefined;
        }
        if (fnCalls && fnCalls.length > 0) {
          const fc = fnCalls[0];
          toolCall = {
            name: fc.name,
            args: (fc.args ?? {}) as Record<string, unknown>,
          };
          buffer = "";
          console.log(`[Gemini tool] ${toolCall.name}`, toolCall.args);
          continue;
        }

        let token = "";
        try {
          token = chunk.text();
        } catch {
          continue;
        }
        if (!token) continue;

        buffer += token;

        const { flushed, remainder } = extractCompleteSentences(buffer);
        if (flushed) {
          console.log(`[Gemini stream] sentence: "${flushed.slice(0, 80)}${flushed.length > 80 ? "…" : ""}"`);
          onSentence(flushed);
          buffer = remainder;
        }
      }

      await streamResult.response;

      const tail = buffer.trim();
      if (tail && !toolCall) {
        console.log(`[Gemini stream] final: "${tail.slice(0, 80)}${tail.length > 80 ? "…" : ""}"`);
        onSentence(tail);
      }
    } catch (e) {
      console.error("[Gemini] sendMessageStream failed:", e);
      throw e;
    }

    return toolCall ? { toolCall } : {};
  }

  /**
   * Layer 2: force book_appointment when the caller affirms in CONFIRMING.
   * Falls back to null so normal chat path runs (then Layer 1 in CallHandler can book).
   */
  private async sendConfirmingAffirmative(fullMessage: string): Promise<{
    text: string;
    toolCall?: { name: string; args: Record<string, unknown> };
  } | null> {
    try {
      const history = await this.chat.getHistory();
      const newUser: Content = { role: "user", parts: [{ text: fullMessage }] };

      const result = await this.model.generateContent({
        contents: [...history, newUser],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingMode.ANY,
            allowedFunctionNames: ["book_appointment"],
          },
        },
      });

      const response = result.response;
      const functionCall = response.functionCalls()?.[0];
      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;

      if (modelContent) {
        const contentWithRole: Content = {
          ...modelContent,
          role: modelContent.role || "model",
        };
        this.chat = this.model.startChat({
          history: [...history, newUser, contentWithRole],
        });
      }

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
    } catch (e) {
      console.warn(
        "[Gemini] CONFIRMING forced tool call failed, using normal chat:",
        e
      );
      return null;
    }
  }

  private async sendMessageNormal(fullMessage: string): Promise<{
    text: string;
    toolCall?: { name: string; args: Record<string, unknown> };
  }> {
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
