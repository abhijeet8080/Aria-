import { DeepgramClient } from "@deepgram/sdk";

export type TranscriptHandler = (text: string, isFinal: boolean) => void;

export interface DeepgramLiveConnection {
  send(data: Buffer | ArrayBuffer): void;
  finish(): void;
}

export type DeepgramConnectionOptions = {
  /** Twilio Media Streams use 8 kHz; local WAV tests often use 16 kHz. */
  sampleRate?: number;
};

export async function createDeepgramConnection(
  onTranscript: TranscriptHandler,
  options?: DeepgramConnectionOptions
): Promise<DeepgramLiveConnection> {
  const apiKey = process.env.DEEPGRAM_API_KEY!;
  const deepgram = new DeepgramClient({ apiKey });
  const sampleRate = options?.sampleRate ?? 16000;

  const connection = await deepgram.listen.v1.connect({
    model: "nova-2",
    language: "en-US",
    smart_format: "true",
    interim_results: "true",
    utterance_end_ms: 1000,
    vad_events: "true",
    encoding: "linear16",
    sample_rate: sampleRate,
    Authorization: `Token ${apiKey}`,
  });

  connection.on("open", () => {
    console.log("[Deepgram] Connection open");
  });

  connection.on("message", (data) => {
    if (data.type === "Results") {
      const transcript = data.channel?.alternatives?.[0]?.transcript ?? "";
      if (!transcript) return;

      const isFinal = data.is_final ?? false;
      onTranscript(transcript, isFinal);
    } else if (data.type === "UtteranceEnd") {
      console.log("[Deepgram] Utterance ended");
    }
  });

  connection.on("error", (err: Error) => {
    console.error("[Deepgram] Error:", err);
  });

  connection.on("close", () => {
    console.log("[Deepgram] Connection closed");
  });

  connection.connect();
  await connection.waitForOpen();

  return {
    send(data: Buffer | ArrayBuffer) {
      connection.sendMedia(data);
    },
    finish() {
      connection.close();
    },
  };
}
