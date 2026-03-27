import { randomUUID } from "crypto";

import { Redis } from "@upstash/redis";

import { generateJoinCode, normalizeJoinCode } from "@/lib/code";
import { getRedisConfig } from "@/lib/env";

export type LobbyStatus = "waiting" | "started";
export type GameType = "dice" | "roulette";

export type LobbyPlayer = {
  sessionId: string;
  displayName: string;
  isHost: boolean;
  joinedAt: string;
  lastSeenAt: string;
  balance: number;
};

export type DiceBet = {
  sessionId: string;
  displayName: string;
  bet: number;
  placedAt: string;
  isCheater: boolean;
};

export type DiceResult = {
  sessionId: string;
  displayName: string;
  bet: number;
  dice: number[];
  score: number;
  payout: number;
  balanceBefore: number;
  balanceAfter: number;
  isWinner: boolean;
  isCheater: boolean;
};

export type DiceRound = {
  id: string;
  game: "dice";
  phase: "betting" | "results";
  addMoney: number;
  minimumBet: number;
  cheatersPercent: number;
  edgePercent: number;
  startedAt: string;
  bettingEndsAt: string;
  resultsEndsAt: string | null;
  rules: string;
  bets: DiceBet[];
  results: DiceResult[];
  pot: number;
  winningsPerWinner: number;
  winners: string[];
  nonParticipants: string[];
};

export type RouletteRound = {
  id: string;
  game: "roulette";
  phase: "results";
  addMoney: number;
  minimumBet: number;
  cheatersPercent: number;
  edgePercent: number;
  startedAt: string;
  resultsEndsAt: string;
  message: string;
};

export type LobbyRound = DiceRound | RouletteRound;

export type LobbySnapshot = {
  lobbyId: string;
  code: string;
  hostSessionId: string;
  players: LobbyPlayer[];
  totalRoundMoneyAllocated: number;
  status: LobbyStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  currentRound: LobbyRound | null;
};

type LobbyErrorCode =
  | "BETTING_CLOSED"
  | "CODE_GENERATION_FAILED"
  | "CONFIGURATION_REQUIRED"
  | "DUPLICATE_NAME"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_AMOUNT"
  | "INVALID_CODE"
  | "INVALID_GAME"
  | "LOBBY_NOT_FOUND"
  | "LOBBY_NOT_STARTED"
  | "LOBBY_STARTED"
  | "NAME_REQUIRED"
  | "NOT_HOST"
  | "NOT_PLAYER"
  | "ROUND_ALREADY_ACTIVE"
  | "ROUND_NOT_ACTIVE"
  | "ROUND_NOT_BETTING"
  | "WAGER_ALREADY_PLACED";

type StartRoundInput = {
  game: GameType;
  addMoney: number;
  minimumBet: number;
  cheatersPercent: number;
  edgePercent: number;
};

const LOBBY_TTL_SECONDS = 60 * 60 * 6;
const MAX_DISPLAY_NAME_LENGTH = 24;
const CODE_RETRY_LIMIT = 24;
const BETTING_DURATION_MS = 15_000;
const DICE_STAGE_DURATION_MS = 15_000;
const RESULTS_DISPLAY_DURATION_MS = 15_000;
const DICE_RESULTS_DURATION_MS = DICE_STAGE_DURATION_MS + RESULTS_DISPLAY_DURATION_MS;
const ROULETTE_RESULTS_DURATION_MS = 15_000;
const DICE_RULES = "All players will roll 4 dice. Player(s) with the highest score split the prize.";

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

function nowIso() {
  return new Date().toISOString();
}

function addMilliseconds(timestamp: string, durationMs: number) {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function toNonNegativeInteger(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new LobbyError("INVALID_AMOUNT", `${field} must be a non-negative number.`, 400);
  }

  return Math.round(value);
}

function toPercentage(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new LobbyError("INVALID_AMOUNT", `${field} must be a non-negative percentage.`, 400);
  }

  return Number(value.toFixed(2));
}

function normalizeLobbySnapshot(rawLobby: LobbySnapshot): { lobby: LobbySnapshot; changed: boolean } {
  let changed = false;

  const players = rawLobby.players.map((player) => {
    if (typeof player.balance === "number") {
      return player;
    }

    changed = true;

    return {
      ...player,
      balance: 0,
    };
  });

  const lobby: LobbySnapshot = {
    ...rawLobby,
    players,
    totalRoundMoneyAllocated: rawLobby.totalRoundMoneyAllocated ?? 0,
    currentRound:
      rawLobby.currentRound == null
        ? null
        : rawLobby.currentRound.game === "dice"
          ? {
              ...rawLobby.currentRound,
              cheatersPercent: rawLobby.currentRound.cheatersPercent ?? 0,
              edgePercent: rawLobby.currentRound.edgePercent ?? 0,
              bets: rawLobby.currentRound.bets.map((bet) => ({
                ...bet,
                isCheater: bet.isCheater ?? false,
              })),
              results: rawLobby.currentRound.results.map((result) => ({
                ...result,
                isCheater: result.isCheater ?? false,
              })),
            }
          : {
              ...rawLobby.currentRound,
              cheatersPercent: rawLobby.currentRound.cheatersPercent ?? 0,
              edgePercent: rawLobby.currentRound.edgePercent ?? 0,
            },
  };

  if (
    rawLobby.totalRoundMoneyAllocated === undefined ||
    rawLobby.currentRound === undefined ||
    (rawLobby.currentRound?.game === "dice" &&
      (rawLobby.currentRound.cheatersPercent === undefined ||
        rawLobby.currentRound.edgePercent === undefined ||
        rawLobby.currentRound.bets.some((bet) => bet.isCheater === undefined) ||
        rawLobby.currentRound.results.some((result) => result.isCheater === undefined))) ||
    (rawLobby.currentRound?.game === "roulette" &&
      (rawLobby.currentRound.cheatersPercent === undefined ||
        rawLobby.currentRound.edgePercent === undefined))
  ) {
    changed = true;
  }

  return { lobby, changed };
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
    balance: 0,
  };
}

function requireLobbyPlayer(lobby: LobbySnapshot, sessionId: string) {
  const player = lobby.players.find((entry) => entry.sessionId === sessionId);

  if (!player) {
    throw new LobbyError("NOT_PLAYER", "You must be in the lobby to do that.", 403);
  }

  return player;
}

function creditAllPlayers(players: LobbyPlayer[], amount: number) {
  if (amount <= 0) {
    return players;
  }

  return players.map((player) => ({
    ...player,
    balance: player.balance + amount,
  }));
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function cheaterDisplayName(index: number) {
  return index === 0 ? "Shady" : `Shady ${index + 1}`;
}

function resolveDiceRound(lobby: LobbySnapshot, timestamp: string): LobbySnapshot {
  const currentRound = lobby.currentRound;

  if (!currentRound || currentRound.game !== "dice" || currentRound.phase !== "betting") {
    return lobby;
  }

  const betsBySession = new Map(currentRound.bets.map((bet) => [bet.sessionId, bet]));
  const humanParticipants = lobby.players
    .filter((player) => betsBySession.has(player.sessionId))
    .map((player) => ({
      sessionId: player.sessionId,
      displayName: player.displayName,
      bet: betsBySession.get(player.sessionId)!,
      balanceBefore: player.balance,
      isCheater: false,
    }));
  const cheaterCount =
    humanParticipants.length > 0
      ? Math.ceil((currentRound.cheatersPercent / 100) * humanParticipants.length)
      : 0;
  const cheaterParticipants = Array.from({ length: cheaterCount }, (_, index) => ({
    sessionId: `cheater:${currentRound.id}:${index}`,
    displayName: cheaterDisplayName(index),
    bet: {
      sessionId: `cheater:${currentRound.id}:${index}`,
      displayName: cheaterDisplayName(index),
      bet: currentRound.minimumBet,
      placedAt: currentRound.bettingEndsAt,
      isCheater: true,
    },
    balanceBefore: 0,
    isCheater: true,
  }));
  const allParticipants = [...humanParticipants, ...cheaterParticipants];
  const rankedResults = allParticipants
    .map((participant) => {
      const dice = [rollDie(), rollDie(), rollDie(), rollDie()];
      const baseScore = dice.reduce((total, value) => total + value, 0);
      const score = participant.isCheater
        ? Number((baseScore * (1 + currentRound.edgePercent / 100)).toFixed(2))
        : baseScore;

      return {
        participant,
        dice,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.participant.displayName.localeCompare(right.participant.displayName);
    });

  const highestScore = rankedResults[0]?.score ?? null;
  const winners =
    highestScore === null
      ? []
      : rankedResults
          .filter((entry) => entry.score === highestScore)
          .map((entry) => entry.participant.sessionId);
  const pot = currentRound.bets.reduce((total, bet) => total + bet.bet, 0) +
    cheaterParticipants.length * currentRound.minimumBet;
  const winningsPerWinner = winners.length > 0 ? pot / winners.length : 0;

  const nextPlayers = lobby.players.map((player) => {
    if (!winners.includes(player.sessionId)) {
      return player;
    }

    return {
      ...player,
      balance: player.balance + winningsPerWinner,
    };
  });

  const playerBalances = new Map(nextPlayers.map((player) => [player.sessionId, player.balance]));
  const originalBalances = new Map(lobby.players.map((player) => [player.sessionId, player.balance]));

  const results: DiceResult[] = rankedResults.map((entry) => ({
    sessionId: entry.participant.sessionId,
    displayName: entry.participant.displayName,
    bet: entry.participant.bet.bet,
    dice: entry.dice,
    score: entry.score,
    payout: winners.includes(entry.participant.sessionId) ? winningsPerWinner : 0,
    balanceBefore: entry.participant.isCheater
      ? entry.participant.balanceBefore
      : (originalBalances.get(entry.participant.sessionId) ?? 0),
    balanceAfter: entry.participant.isCheater
      ? entry.participant.balanceBefore +
        (winners.includes(entry.participant.sessionId) ? winningsPerWinner : 0)
      : (playerBalances.get(entry.participant.sessionId) ?? 0),
    isWinner: winners.includes(entry.participant.sessionId),
    isCheater: entry.participant.isCheater,
  }));

  const nextRound: DiceRound = {
    ...currentRound,
    phase: "results",
    bets: [...currentRound.bets, ...cheaterParticipants.map((participant) => participant.bet)],
    results,
    pot,
    winners,
    winningsPerWinner,
    nonParticipants: lobby.players
      .filter((player) => !betsBySession.has(player.sessionId))
      .map((player) => player.sessionId),
    resultsEndsAt: addMilliseconds(timestamp, DICE_RESULTS_DURATION_MS),
  };

  return {
    ...lobby,
    players: nextPlayers,
    currentRound: nextRound,
    updatedAt: timestamp,
  };
}

function clearFinishedRound(lobby: LobbySnapshot, timestamp: string): LobbySnapshot {
  return {
    ...lobby,
    currentRound: null,
    updatedAt: timestamp,
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
  const rawLobby = await redis.get<LobbySnapshot>(lobbyKey(lobbyId));

  if (!rawLobby) {
    throw new LobbyError("LOBBY_NOT_FOUND", "Lobby not found or expired.", 404);
  }

  const { lobby, changed } = normalizeLobbySnapshot(rawLobby);

  if (changed) {
    await saveLobby(lobby);
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
  const now = nowIso();
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
      totalRoundMoneyAllocated: 0,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      currentRound: null,
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

  const now = nowIso();
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

  const now = nowIso();
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

  const now = nowIso();
  const nextLobby: LobbySnapshot = {
    ...lobby,
    status: "started",
    startedAt: now,
    updatedAt: now,
  };

  await saveLobby(nextLobby);
  return nextLobby;
}

export async function startGameRound(
  lobbyId: string,
  sessionId: string,
  input: StartRoundInput,
): Promise<LobbySnapshot> {
  const lobby = await getLobbyById(lobbyId);

  if (lobby.status !== "started") {
    throw new LobbyError("LOBBY_NOT_STARTED", "Start the lobby before starting rounds.", 409);
  }

  if (lobby.hostSessionId !== sessionId) {
    throw new LobbyError("NOT_HOST", "Only the host can start rounds.", 403);
  }

  if (lobby.currentRound) {
    throw new LobbyError("ROUND_ALREADY_ACTIVE", "Finish the current round before starting another.", 409);
  }

  const addMoney = toNonNegativeInteger(input.addMoney, "Add money");
  const minimumBet = toNonNegativeInteger(input.minimumBet, "Minimum bet");
  const cheatersPercent = toPercentage(input.cheatersPercent, "Cheaters");
  const edgePercent = toPercentage(input.edgePercent, "Edge");

  if (input.game !== "dice" && input.game !== "roulette") {
    throw new LobbyError("INVALID_GAME", "Choose a valid game type.", 400);
  }

  const now = nowIso();
  const players = creditAllPlayers(lobby.players, addMoney);

  const currentRound: LobbyRound =
    input.game === "dice"
      ? {
          id: randomUUID(),
          game: "dice",
          phase: "betting",
          addMoney,
          minimumBet,
          cheatersPercent,
          edgePercent,
          startedAt: now,
          bettingEndsAt: addMilliseconds(now, BETTING_DURATION_MS),
          resultsEndsAt: null,
          rules: DICE_RULES,
          bets: [],
          results: [],
          pot: 0,
          winningsPerWinner: 0,
          winners: [],
          nonParticipants: [],
        }
      : {
          id: randomUUID(),
          game: "roulette",
          phase: "results",
          addMoney,
          minimumBet,
          cheatersPercent,
          edgePercent,
          startedAt: now,
          resultsEndsAt: addMilliseconds(now, ROULETTE_RESULTS_DURATION_MS),
          message: "Roulette rounds are not implemented yet.",
        };

  const nextLobby: LobbySnapshot = {
    ...lobby,
    players,
    totalRoundMoneyAllocated: lobby.totalRoundMoneyAllocated + addMoney * players.length,
    currentRound,
    updatedAt: now,
  };

  await saveLobby(nextLobby);
  return nextLobby;
}

export async function placeRoundBet(lobbyId: string, sessionId: string): Promise<LobbySnapshot> {
  const lobby = await getLobbyById(lobbyId);
  const currentRound = lobby.currentRound;

  if (!currentRound) {
    throw new LobbyError("ROUND_NOT_ACTIVE", "There is no active round to join.", 409);
  }

  if (currentRound.game !== "dice") {
    throw new LobbyError("ROUND_NOT_BETTING", "This round does not accept bets.", 409);
  }

  if (currentRound.phase !== "betting") {
    throw new LobbyError("BETTING_CLOSED", "Betting for this round is closed.", 409);
  }

  if (new Date(currentRound.bettingEndsAt).getTime() <= Date.now()) {
    throw new LobbyError("BETTING_CLOSED", "Betting for this round is closed.", 409);
  }

  const player = requireLobbyPlayer(lobby, sessionId);

  if (currentRound.bets.some((bet) => bet.sessionId === sessionId)) {
    throw new LobbyError("WAGER_ALREADY_PLACED", "You have already placed the round bet.", 409);
  }

  if (player.balance < currentRound.minimumBet) {
    throw new LobbyError("INSUFFICIENT_FUNDS", "You do not have enough money to place that bet.", 409);
  }

  const now = nowIso();
  const nextPlayers = lobby.players.map((entry) =>
    entry.sessionId === sessionId
      ? {
          ...entry,
          balance: entry.balance - currentRound.minimumBet,
        }
      : entry,
  );

  const nextRound: DiceRound = {
    ...currentRound,
    bets: [
      ...currentRound.bets,
      {
        sessionId,
        displayName: player.displayName,
        bet: currentRound.minimumBet,
        placedAt: now,
        isCheater: false,
      },
    ],
  };

  const nextLobby: LobbySnapshot = {
    ...lobby,
    players: nextPlayers,
    currentRound: nextRound,
    updatedAt: now,
  };

  await saveLobby(nextLobby);
  return nextLobby;
}

export async function syncLobbyRoundState(lobbyId: string) {
  const lobby = await getLobbyById(lobbyId);
  const currentRound = lobby.currentRound;

  if (!currentRound) {
    return { lobby, changed: false };
  }

  const now = nowIso();

  if (currentRound.game === "dice") {
    if (currentRound.phase === "betting" && new Date(currentRound.bettingEndsAt).getTime() <= Date.now()) {
      const resolvedLobby = resolveDiceRound(lobby, now);
      await saveLobby(resolvedLobby);
      return { lobby: resolvedLobby, changed: true };
    }

    if (currentRound.phase === "results" && currentRound.resultsEndsAt) {
      if (new Date(currentRound.resultsEndsAt).getTime() <= Date.now()) {
        const clearedLobby = clearFinishedRound(lobby, now);
        await saveLobby(clearedLobby);
        return { lobby: clearedLobby, changed: true };
      }
    }
  }

  if (currentRound.game === "roulette") {
    if (new Date(currentRound.resultsEndsAt).getTime() <= Date.now()) {
      const clearedLobby = clearFinishedRound(lobby, now);
      await saveLobby(clearedLobby);
      return { lobby: clearedLobby, changed: true };
    }
  }

  return { lobby, changed: false };
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
