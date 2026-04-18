import { DeepgramClient } from "@deepgram/sdk";

export type TranscriptHandler = (
  text: string,
  isFinal: boolean,
  detectedLanguage?: string
) => void;

export type DeepgramConnectionOptions = {
  /** Twilio Media Streams use 8 kHz; local WAV tests often use 16 kHz. */
  sampleRate?: number;
};

/**
 * Normalise Deepgram's detected_language to a full BCP-47 code.
 * Deepgram may return bare codes like "hi" or "kn"; we map them to regional
 * variants so Google TTS and Gemini get the right voice.
 */
function normaliseLangCode(code: string): string {
  const map: Record<string, string> = {
    hi: "hi-IN",
    kn: "kn-IN",
    ta: "ta-IN",
    te: "te-IN",
    ml: "ml-IN",
    mr: "mr-IN",
    bn: "bn-IN",
    gu: "gu-IN",
    pa: "pa-IN",
    ur: "ur-IN",
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    de: "de-DE",
    ja: "ja-JP",
    ko: "ko-KR",
    zh: "zh-CN",
    ar: "ar-XA",
    pt: "pt-BR",
  };
  if (code.includes("-")) return code; // already has region
  return map[code] ?? code;
}

export function createDeepgramConnection(
  onTranscript: TranscriptHandler,
  options?: DeepgramConnectionOptions
): { safeSend: (data: Buffer) => void; safeFinish: () => void } {
  const apiKey = process.env.DEEPGRAM_API_KEY!;
  const deepgram = new DeepgramClient({ apiKey });
  const sampleRate = options?.sampleRate ?? 16000;

  let isOpen = false;
  let conn: Awaited<ReturnType<typeof deepgram.listen.v1.connect>> | null = null;
  // Accumulate is_final results until UtteranceEnd to send one combined transcript
  let utteranceBuffer: string[] = [];
  let utteranceLang: string | undefined;

  deepgram.listen.v1
    .connect({
      model: "nova-2",
      language: "multi",       // multi-language model (covers 30+ languages)
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
        console.log("[Deepgram] Connection open (multi-language mode)");
      });

      connection.on("message", (data) => {
        if (data.type === "Results") {
          const transcript = data.channel?.alternatives?.[0]?.transcript ?? "";
          if (!transcript) return;

          const rawLang: string | undefined =
            (data as any).channel?.detected_language ??
            (data as any).detected_language;
          const lang = rawLang ? normaliseLangCode(rawLang) : undefined;

          if (data.is_final) {
            utteranceBuffer.push(transcript);
            if (lang) utteranceLang = lang; // keep the last detected language
            onTranscript(transcript, false, lang); // interim signal for activity detection
          } else {
            onTranscript(transcript, false, lang);
          }
        } else if (data.type === "UtteranceEnd") {
          console.log("[Deepgram] Utterance ended");
          const combined = utteranceBuffer.join(" ").trim();
          const lang = utteranceLang;
          utteranceBuffer = [];
          utteranceLang = undefined;
          if (combined) onTranscript(combined, true, lang); // single final call per utterance
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
