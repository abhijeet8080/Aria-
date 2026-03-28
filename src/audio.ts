import { mulaw } from "alawmulaw";

/**
 * Twilio Media Streams send base64-encoded µ-law audio.
 * This converts it to the raw PCM Buffer Deepgram expects.
 */
export function decodeTwilioAudio(base64Payload: string): Buffer {
  const mulawBuffer = Buffer.from(base64Payload, "base64");
  const pcmSamples = mulaw.decode(new Uint8Array(mulawBuffer));
  return Buffer.from(
    pcmSamples.buffer,
    pcmSamples.byteOffset,
    pcmSamples.byteLength
  );
}
