import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const SESSION_TTL = 60 * 60; // 1 hour

export async function saveSession(
  callSid: string,
  data: object
): Promise<void> {
  await redis.set(`session:${callSid}`, JSON.stringify(data), {
    ex: SESSION_TTL,
  });
}

export async function getSession(
  callSid: string
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`session:${callSid}`);
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return null;
}

export async function deleteSession(callSid: string): Promise<void> {
  await redis.del(`session:${callSid}`);
}
