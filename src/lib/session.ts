import { randomUUID } from "crypto";
import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "saturnalia-session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function createCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export async function getSessionId(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}

export async function ensureSessionId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (existing) {
    return existing;
  }

  const sessionId = randomUUID();
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, createCookieOptions());
  return sessionId;
}