const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";

/**
 * Deepgram Aura TTS — µ-law 8 kHz raw bytes (no WAV header).
 * Docs: https://developers.deepgram.com/reference/text-to-speech/speak-request
 */
const DEFAULT_MODEL = "aura-2-thalia-en";

/** Raw µ-law audio from Deepgram (8 kHz). */
export async function textToMulaw(text: string): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) return Buffer.alloc(0);

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

  const model = process.env.DEEPGRAM_TTS_MODEL ?? DEFAULT_MODEL;

  const url = new URL(DEEPGRAM_TTS_URL);
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", "mulaw");
  url.searchParams.set("sample_rate", "8000");
  url.searchParams.set("container", "none");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: trimmed }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Deepgram TTS failed [${response.status}]: ${body}`);
  }

  const raw = Buffer.from(await response.arrayBuffer());
  console.log(`[TTS] Deepgram Aura: ${raw.length} bytes for: "${trimmed}"`);
  return raw;
}

/** Warms HTTP/TLS to Deepgram TTS so the first real utterance is faster. */
export async function prewarmTTS(): Promise<void> {
  try {
    await textToMulaw("Hi.");
    console.log("[TTS] Connection pre-warmed");
  } catch {
    // Best-effort only
  }
}

/** Split µ-law audio into 160-byte (20 ms) frames for Twilio outbound media. */
export function chunkMulawForTwilio(mulaw: Buffer): Buffer[] {
  if (mulaw.length === 0) return [];
  const chunks: Buffer[] = [];
  const FRAME_SIZE = 160;
  for (let i = 0; i < mulaw.length; i += FRAME_SIZE) {
    chunks.push(mulaw.subarray(i, i + FRAME_SIZE));
  }
  return chunks;
}
