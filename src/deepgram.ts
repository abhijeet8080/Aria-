import { DeepgramClient } from "@deepgram/sdk";

export type TranscriptHandler = (text: string, isFinal: boolean) => void;

export type DeepgramConnectionOptions = {
  /** Twilio Media Streams use 8 kHz; local WAV tests often use 16 kHz. */
  sampleRate?: number;
};

export function createDeepgramConnection(
  onTranscript: TranscriptHandler,
  options?: DeepgramConnectionOptions
): { safeSend: (data: Buffer) => void; safeFinish: () => void } {
  const apiKey = process.env.DEEPGRAM_API_KEY!;
  const deepgram = new DeepgramClient({ apiKey });
  const sampleRate = options?.sampleRate ?? 16000;

  let isOpen = false;
  // connection is set once the async connect() resolves
  let conn: Awaited<ReturnType<typeof deepgram.listen.v1.connect>> | null =
    null;

  // Start connection asynchronously; safeSend/safeFinish guard with isOpen
  deepgram.listen.v1
    .connect({
      model: "nova-2",
      language: "en-US",
      smart_format: "true",
      interim_results: "true",
      utterance_end_ms: 1000,
      vad_events: "true",
      encoding: "linear16",
      sample_rate: sampleRate,
      Authorization: `Token ${apiKey}`,
    })
    .then((connection) => {
      conn = connection;

      connection.on("open", () => {
        isOpen = true;
        console.log("[Deepgram] Connection open");
      });

      connection.on("message", (data) => {
        if (data.type === "Results") {
          const transcript =
            data.channel?.alternatives?.[0]?.transcript ?? "";
          if (!transcript) return;
          onTranscript(transcript, data.is_final ?? false);
        } else if (data.type === "UtteranceEnd") {
          console.log("[Deepgram] Utterance ended");
        }
      });

      connection.on("error", (err: Error) => {
        console.error("[Deepgram] Error:", err);
      });

      connection.on("close", () => {
        isOpen = false;
        console.log("[Deepgram] Connection closed");
      });

      connection.connect();
    })
    .catch((err: unknown) => {
      console.error("[Deepgram] Failed to connect:", err);
    });

  const safeSend = (data: Buffer): void => {
    if (!isOpen || !conn) return;
    try {
      conn.sendMedia(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Deepgram] Send skipped:", msg);
    }
  };

  const safeFinish = (): void => {
    if (!isOpen || !conn) return;
    try {
      conn.close();
    } catch {
      // ignore
    }
  };

  return { safeSend, safeFinish };
}
