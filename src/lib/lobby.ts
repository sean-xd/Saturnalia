import { randomUUID } from "crypto";

import { Redis } from "@upstash/redis";

import { generateJoinCode, normalizeJoinCode } from "@/lib/code";
import { getRedisConfig } from "@/lib/env";

export type LobbyStatus = "waiting" | "started";

export type LobbyPlayer = {
  sessionId: string;
  displayName: string;
  isHost: boolean;
  joinedAt: string;
  lastSeenAt: string;
};

export type LobbySnapshot = {
  lobbyId: string;
  code: string;
  hostSessionId: string;
  players: LobbyPlayer[];
  status: LobbyStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
};

type LobbyErrorCode =
  | "CODE_GENERATION_FAILED"
  | "CONFIGURATION_REQUIRED"
  | "DUPLICATE_NAME"
  | "INVALID_CODE"
  | "LOBBY_NOT_FOUND"
  | "LOBBY_STARTED"
  | "NAME_REQUIRED"
  | "NOT_HOST";

const LOBBY_TTL_SECONDS = 60 * 60 * 6;
const MAX_DISPLAY_NAME_LENGTH = 24;
const CODE_RETRY_LIMIT = 24;

let redisClient: Redis | undefined;

export class LobbyError extends Error {
  code: LobbyErrorCode;
  status: number;

  constructor(code: LobbyErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getRedis(): Redis {
  if (redisClient) {
    return redisClient;
  }

  const config = getRedisConfig();

  if (!config.url || !config.token) {
    throw new LobbyError(
      "CONFIGURATION_REQUIRED",
      "Redis is not configured. Set the Upstash environment variables before using lobby routes.",
      500,
    );
  }

  redisClient = new Redis({
    url: config.url,
    token: config.token,
  });

  return redisClient;
}

function lobbyKey(lobbyId: string): string {
  return `lobby:${lobbyId}`;
}

function codeKey(code: string): string {
  return `lobby-code:${code}`;
}

function sanitizeDisplayName(input: string | undefined, fallback: string): string {
  const normalized = input?.trim().replace(/\s+/g, " ") ?? "";
  const candidate = normalized.length > 0 ? normalized : fallback;

  return candidate.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function validateName(lobby: LobbySnapshot, sessionId: string, displayName: string) {
  if (displayName.length === 0) {
    throw new LobbyError("NAME_REQUIRED", "Display name is required.", 400);
  }

  const duplicate = lobby.players.some(
    (player) =>
      player.sessionId !== sessionId &&
      player.displayName.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0,
  );

  if (duplicate) {
    throw new LobbyError(
      "DUPLICATE_NAME",
      "That display name is already in use for this lobby.",
      409,
    );
  }
}

async function saveLobby(lobby: LobbySnapshot) {
  const redis = getRedis();

  await Promise.all([
    redis.set(lobbyKey(lobby.lobbyId), lobby, { ex: LOBBY_TTL_SECONDS }),
    redis.set(codeKey(lobby.code), lobby.lobbyId, { ex: LOBBY_TTL_SECONDS }),
  ]);
}

async function deleteLobby(lobby: LobbySnapshot) {
  const redis = getRedis();

  await Promise.all([redis.del(lobbyKey(lobby.lobbyId)), redis.del(codeKey(lobby.code))]);
}

function createPlayer(sessionId: string, displayName: string, isHost: boolean, now: string): LobbyPlayer {
  return {
    sessionId,
    displayName,
    isHost,
    joinedAt: now,
    lastSeenAt: now,
  };
}

export function findLobbyPlayer(lobby: LobbySnapshot, sessionId: string | undefined) {
  if (!sessionId) {
    return undefined;
  }

  return lobby.players.find((player) => player.sessionId === sessionId);
}

export async function getLobbyById(lobbyId: string): Promise<LobbySnapshot> {
  const redis = getRedis();
  const lobby = await redis.get<LobbySnapshot>(lobbyKey(lobbyId));

  if (!lobby) {
    throw new LobbyError("LOBBY_NOT_FOUND", "Lobby not found or expired.", 404);
  }

  return lobby;
}

export async function getLobbyByCode(rawCode: string): Promise<LobbySnapshot> {
  const code = normalizeJoinCode(rawCode);

  if (code.length === 0) {
    throw new LobbyError("INVALID_CODE", "A 4-character lobby code is required.", 400);
  }

  const redis = getRedis();
  const lobbyId = await redis.get<string>(codeKey(code));

  if (!lobbyId) {
    throw new LobbyError("INVALID_CODE", "That lobby code does not exist or has expired.", 404);
  }

  return getLobbyById(lobbyId);
}

export async function createLobby(hostSessionId: string, displayName?: string): Promise<LobbySnapshot> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const hostDisplayName = sanitizeDisplayName(displayName, "Host");

  for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
    const code = generateJoinCode();
    const existingLobbyId = await redis.get<string>(codeKey(code));

    if (existingLobbyId) {
      continue;
    }

    const lobby: LobbySnapshot = {
      lobbyId: randomUUID(),
      code,
      hostSessionId,
      players: [createPlayer(hostSessionId, hostDisplayName, true, now)],
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
    };

    await saveLobby(lobby);
    return lobby;
  }

  throw new LobbyError(
    "CODE_GENERATION_FAILED",
    "Unable to allocate a unique lobby code. Try again.",
    500,
  );
}

export async function joinLobby(
  lobbyId: string,
  sessionId: string,
  displayName?: string,
): Promise<LobbySnapshot> {
  const lobby = await getLobbyById(lobbyId);

  if (lobby.status === "started") {
    throw new LobbyError("LOBBY_STARTED", "This lobby has already started.", 409);
  }

  const now = new Date().toISOString();
  const nextDisplayName = sanitizeDisplayName(displayName, "Player");
  validateName(lobby, sessionId, nextDisplayName);

  const existingIndex = lobby.players.findIndex((player) => player.sessionId === sessionId);

  if (existingIndex >= 0) {
    const existingPlayer = lobby.players[existingIndex];
    lobby.players[existingIndex] = {
      ...existingPlayer,
      displayName: nextDisplayName,
      isHost: lobby.hostSessionId === sessionId,
      lastSeenAt: now,
    };
  } else {
    lobby.players.push(createPlayer(sessionId, nextDisplayName, lobby.hostSessionId === sessionId, now));
  }

  lobby.updatedAt = now;
  await saveLobby(lobby);
  return lobby;
}

export async function leaveLobby(lobbyId: string, sessionId: string) {
  const lobby = await getLobbyById(lobbyId);
  const remainingPlayers = lobby.players.filter((player) => player.sessionId !== sessionId);

  if (remainingPlayers.length === lobby.players.length) {
    return { deleted: false, lobby };
  }

  if (remainingPlayers.length === 0) {
    await deleteLobby(lobby);
    return { deleted: true as const, lobby: null };
  }

  const now = new Date().toISOString();
  const nextHostSessionId =
    lobby.hostSessionId === sessionId ? remainingPlayers[0].sessionId : lobby.hostSessionId;

  const nextLobby: LobbySnapshot = {
    ...lobby,
    hostSessionId: nextHostSessionId,
    players: remainingPlayers.map((player) => ({
      ...player,
      isHost: player.sessionId === nextHostSessionId,
    })),
    updatedAt: now,
  };

  await saveLobby(nextLobby);
  return { deleted: false as const, lobby: nextLobby };
}

export async function startLobby(lobbyId: string, sessionId: string): Promise<LobbySnapshot> {
  const lobby = await getLobbyById(lobbyId);

  if (lobby.hostSessionId !== sessionId) {
    throw new LobbyError("NOT_HOST", "Only the host can start the lobby.", 403);
  }

  if (lobby.status === "started") {
    return lobby;
  }

  const now = new Date().toISOString();
  const nextLobby: LobbySnapshot = {
    ...lobby,
    status: "started",
    startedAt: now,
    updatedAt: now,
  };

  await saveLobby(nextLobby);
  return nextLobby;
}

export function lobbyErrorToResponse(error: unknown) {
  if (error instanceof LobbyError) {
    return Response.json(
      {
        error: error.code,
        message: error.message,
      },
      { status: error.status },
    );
  }

  console.error(error);

  return Response.json(
    {
      error: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong while handling the lobby request.",
    },
    { status: 500 },
  );
}