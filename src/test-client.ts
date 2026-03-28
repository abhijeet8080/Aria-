import WebSocket from "ws";
import fs from "fs";
import path from "path";

const SERVER_URL = "ws://localhost:8080/audio";
const CHUNK_SIZE = 3200; // 100ms of 16kHz 16-bit mono audio
const CHUNK_INTERVAL_MS = 100;
/** Wait after connect before sending audio (gives server / Deepgram time to come up). */
const START_DELAY_MS = 750;

async function streamAudioFile(filePath: string) {
  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    console.log("[Client] Connected to server.");

    const fileBuffer = fs.readFileSync(filePath);
    // Skip WAV header (44 bytes) and stream raw PCM
    const pcmData = fileBuffer.slice(44);

    setTimeout(() => {
      console.log("[Client] Starting audio stream...");
      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= pcmData.length || ws.readyState !== WebSocket.OPEN) {
          clearInterval(interval);
          console.log("[Client] Finished streaming, closing...");
          setTimeout(() => ws.close(), 2000); // wait for final transcript
          return;
        }

        const chunk = pcmData.slice(offset, offset + CHUNK_SIZE);
        ws.send(chunk);
        offset += CHUNK_SIZE;
      }, CHUNK_INTERVAL_MS);
    }, START_DELAY_MS);
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.isFinal) {
      console.log(`[Client received FINAL]: "${msg.transcript}"`);
    }
  });

  ws.on("error", (err) => console.error("[Client] Error:", err));
  ws.on("close", () => console.log("[Client] Connection closed"));
}

// Usage: npx tsx src/test-client.ts path/to/audio.wav
const audioFile = process.argv[2] ?? "test.wav";
streamAudioFile(path.resolve(audioFile));