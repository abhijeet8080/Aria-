const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";

/**
 * Deepgram Aura TTS — included in the free tier (no separate key needed).
 * Returns µ-law 8 kHz audio split into 160-byte / 20 ms frames for Twilio.
 * Docs: https://developers.deepgram.com/reference/text-to-speech/speak-request
 *
 * Available models (Aura 2 recommended):
 *   aura-2-thalia-en  — warm female  (default)
 *   aura-2-apollo-en  — clear male
 *   aura-asteria-en   — original female (Aura 1, also free)
 */
const DEFAULT_MODEL = "aura-2-thalia-en";

export async function textToMulaw(text: string): Promise<Buffer[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

  const model = process.env.DEEPGRAM_TTS_MODEL ?? DEFAULT_MODEL;

  const url = new URL(DEEPGRAM_TTS_URL);
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", "mulaw");
  url.searchParams.set("sample_rate", "8000");
  url.searchParams.set("container", "none"); // raw bytes, no WAV header

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

  // Split into 160-byte frames (20 ms at 8 kHz µ-law)
  const chunks: Buffer[] = [];
  const FRAME_SIZE = 160;
  for (let i = 0; i < raw.length; i += FRAME_SIZE) {
    chunks.push(raw.subarray(i, i + FRAME_SIZE));
  }

  console.log(`[TTS] Deepgram Aura: ${chunks.length} frames for: "${trimmed}"`);
  return chunks;
}
