const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";
const DEFAULT_DEEPGRAM_MODEL = "aura-2-thalia-en";

/**
 * Deepgram Aura TTS — English only, µ-law 8 kHz.
 */
async function deepgramTTS(text: string): Promise<Buffer> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");

  const model = process.env.DEEPGRAM_TTS_MODEL ?? DEFAULT_DEEPGRAM_MODEL;
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
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Deepgram TTS failed [${response.status}]: ${body}`);
  }

  const raw = Buffer.from(await response.arrayBuffer());
  console.log(`[TTS] Deepgram Aura: ${raw.length} bytes for: "${text}"`);
  return raw;
}

/**
 * Google Cloud TTS — multilingual, µ-law 8 kHz.
 * Requires GOOGLE_TTS_API_KEY env var.
 * Supports 40+ languages including all major Indian languages.
 */
async function googleTTS(text: string, language: string): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_TTS_API_KEY is not set");

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: language,
          ssmlGender: "FEMALE",
        },
        audioConfig: {
          audioEncoding: "MULAW",
          sampleRateHertz: 8000,
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google TTS failed [${response.status}]: ${body}`);
  }

  const data = (await response.json()) as { audioContent: string };
  const raw = Buffer.from(data.audioContent, "base64");
  console.log(`[TTS] Google TTS (${language}): ${raw.length} bytes for: "${text}"`);
  return raw;
}

function isEnglish(language: string): boolean {
  return language.startsWith("en");
}

/**
 * Unified TTS entry point.
 * - English → Deepgram Aura (low latency)
 * - Other languages → Google Cloud TTS (requires GOOGLE_TTS_API_KEY)
 */
export async function textToMulaw(text: string, language = "en-US"): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) return Buffer.alloc(0);

  if (!isEnglish(language) && process.env.GOOGLE_TTS_API_KEY) {
    return googleTTS(trimmed, language);
  }

  // Fall back to Deepgram for English (or if no Google key configured)
  if (!isEnglish(language)) {
    console.warn(`[TTS] No GOOGLE_TTS_API_KEY set — falling back to English TTS for language: ${language}`);
  }
  return deepgramTTS(trimmed);
}

/** Warms HTTP/TLS to Deepgram TTS so the first real utterance is faster. */
export async function prewarmTTS(): Promise<void> {
  try {
    await deepgramTTS("Hi.");
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
