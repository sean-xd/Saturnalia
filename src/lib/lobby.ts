import { randomUUID } from "crypto";

import { Redis } from "@upstash/redis";

import { generateJoinCode, normalizeJoinCode } from "@/lib/code";
import { getRedisConfig } from "@/lib/env";
import {
  filterRouletteBetDefinitionsByComplexity,
  formatRoulettePocket,
  formatRouletteZeroes,
  getRouletteBetDefinitionMap,
  getRoulettePocketColor,
  getRouletteWheelPockets,
  type RouletteBetComplexity,
  type RouletteBetType,
  type RoulettePocket,
} from "@/lib/roulette";

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

export type CompletedDiceRound = Omit<DiceRound, "phase"> & {
  phase: "results";
};

export type RouletteBet = {
  sessionId: string;
  displayName: string;
  amount: number;
  placedAt: string;
  betKey: string;
  label: string;
  type: RouletteBetType;
  payoutMultiplier: number;
  pockets: RoulettePocket[];
};

export type RouletteResult = {
  sessionId: string;
  displayName: string;
  totalBet: number;
  payout: number;
  balanceBefore: number;
  balanceAfter: number;
  bets: RouletteBet[];
  winningBets: RouletteBet[];
};

export type RouletteRound = {
  id: string;
  game: "roulette";
  phase: "betting" | "results";
  addMoney: number;
  minimumBet: number;
  zeroes: number;
  betComplexity: RouletteBetComplexity;
  startedAt: string;
  bettingEndsAt: string;
  spinEndsAt: string | null;
  resultsEndsAt: string | null;
  wheelPockets: RoulettePocket[];
  winningPocket: RoulettePocket | null;
  bets: RouletteBet[];
  results: RouletteResult[];
  message: string;
};

export type CompletedRouletteRound = Omit<RouletteRound, "phase"> & {
  phase: "results";
};

export type LobbyRound = DiceRound | RouletteRound;
export type CompletedLobbyRound = CompletedDiceRound | CompletedRouletteRound;

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
export type LobbySummary = LobbySnapshot;

type StoredRouletteBet = Pick<RouletteBet, "sessionId" | "displayName" | "amount" | "placedAt" | "betKey">;

type StoredRouletteResult = Pick<
  RouletteResult,
  "sessionId" | "displayName" | "totalBet" | "payout" | "balanceBefore" | "balanceAfter"
>;

type StoredRouletteRound = Omit<
  RouletteRound,
  "wheelPockets" | "bets" | "results" | "message"
> & {
  bets?: StoredRouletteBet[];
  results?: StoredRouletteResult[];
  wheelPockets?: RoulettePocket[];
  message?: string;
};

type RawLobbySnapshot = Omit<LobbySnapshot, "currentRound"> & {
  currentRound?: DiceRound | StoredRouletteRound | null;
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
  | "LOBBY_BUSY"
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

type StartRoundInput =
  | {
      game: "dice";
      addMoney: number;
      minimumBet: number;
      cheatersPercent: number;
      edgePercent: number;
    }
  | {
      game: "roulette";
      addMoney: number;
      minimumBet: number;
      zeroes: number;
      betComplexity: RouletteBetComplexity;
    };

type PlaceRoundBetInput =
  | {
      game: "dice";
    }
  | {
      game: "roulette";
      placementKeys: string[];
    };

const LOBBY_TTL_SECONDS = 60 * 60 * 6;
const LOBBY_LOCK_TTL_MS = 10_000;
const LOBBY_LOCK_WAIT_MS = 2_000;
const LOBBY_LOCK_RETRY_DELAY_MS = 50;
const MAX_DISPLAY_NAME_LENGTH = 24;
const CODE_RETRY_LIMIT = 24;
const BETTING_DURATION_MS = 15_000;
const DICE_STAGE_DURATION_MS = 15_000;
const RESULTS_DISPLAY_DURATION_MS = 15_000;
const DICE_RESULTS_DURATION_MS = DICE_STAGE_DURATION_MS + RESULTS_DISPLAY_DURATION_MS;
const ROULETTE_BETTING_DURATION_MS = 30_000;
const ROULETTE_BETTING_GRACE_MS = 3_000;
const ROULETTE_SPIN_DURATION_MS = 10_000;
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

function lobbyLockKey(lobbyId: string): string {
  return `lobby-lock:${lobbyId}`;
}

function codeKey(code: string): string {
  return `lobby-code:${code}`;
}

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
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

function toZeroCount(value: number) {
  return toNonNegativeInteger(value, "Zeroes");
}

function normalizeZeroCount(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined || value < 0) {
    return 1;
  }

  return Math.round(value);
}

function normalizeRouletteBet(bet: RouletteBet): RouletteBet {
  return {
    ...bet,
    amount: bet.amount ?? 0,
    payoutMultiplier: bet.payoutMultiplier ?? 0,
    pockets: bet.pockets ?? [],
  };
}

function hydrateRouletteBet(
  bet: Partial<RouletteBet> & Pick<StoredRouletteBet, "betKey" | "amount" | "placedAt" | "sessionId" | "displayName">,
  zeroes: number,
): RouletteBet {
  const definition = getRouletteBetDefinitionMap(zeroes).get(bet.betKey);

  return {
    sessionId: bet.sessionId,
    displayName: bet.displayName,
    amount: bet.amount ?? 0,
    placedAt: bet.placedAt,
    betKey: bet.betKey,
    label: bet.label ?? definition?.label ?? bet.betKey,
    type: bet.type ?? definition?.type ?? "color",
    payoutMultiplier: bet.payoutMultiplier ?? definition?.payoutMultiplier ?? 0,
    pockets: bet.pockets ?? definition?.pockets ?? [],
  };
}

function hydrateRouletteResult(
  result: Partial<RouletteResult> & StoredRouletteResult,
  bets: RouletteBet[],
  winningPocket: RoulettePocket | null,
): RouletteResult {
  const playerBets = bets.filter((bet) => bet.sessionId === result.sessionId);
  const winningBets = winningPocket === null
    ? []
    : playerBets.filter((bet) => bet.pockets.includes(winningPocket));

  return {
    sessionId: result.sessionId,
    displayName: result.displayName,
    totalBet: result.totalBet ?? 0,
    payout: result.payout ?? 0,
    balanceBefore: result.balanceBefore ?? 0,
    balanceAfter: result.balanceAfter ?? 0,
    bets: result.bets?.map(normalizeRouletteBet) ?? playerBets,
    winningBets: result.winningBets?.map(normalizeRouletteBet) ?? winningBets,
  };
}

function getRouletteRoundMessage(round: Pick<RouletteRound, "phase" | "zeroes" | "betComplexity" | "winningPocket">) {
  if (round.phase === "betting") {
    const complexityMessage =
      round.betComplexity === "simple"
        ? "Simple mode limits bets to red or black."
        : round.betComplexity === "intermediate"
          ? "Intermediate mode allows straight numbers plus red or black."
          : "Advanced mode unlocks the full table.";

    return `Roulette board configured with ${formatRouletteZeroes(round.zeroes)}. ${complexityMessage}`;
  }

  if (round.winningPocket === null) {
    return "Wheel spinning.";
  }

  return `Ball landed on ${formatRoulettePocket(round.winningPocket)} ${getRoulettePocketColor(round.winningPocket)}.`;
}

function normalizeRouletteRound(round: RouletteRound | StoredRouletteRound): RouletteRound {
  const zeroes = normalizeZeroCount((round as RouletteRound & { zeroes?: number }).zeroes);
  const bets = (round.bets ?? []).map((bet) => hydrateRouletteBet(bet, zeroes));
  const winningPocket = round.winningPocket ?? null;

  return {
    ...round,
    zeroes,
    betComplexity: round.betComplexity ?? "simple",
    bettingEndsAt: round.bettingEndsAt ?? round.startedAt,
    spinEndsAt: round.spinEndsAt ?? (round.phase === "results" ? round.startedAt : null),
    resultsEndsAt: round.resultsEndsAt ?? null,
    wheelPockets: round.wheelPockets ?? getRouletteWheelPockets(zeroes),
    winningPocket,
    bets,
    results: (round.results ?? []).map((result) => hydrateRouletteResult(result, bets, winningPocket)),
    message: round.message ?? getRouletteRoundMessage({
      phase: round.phase,
      zeroes,
      betComplexity: round.betComplexity ?? "simple",
      winningPocket,
    }),
  };
}

function normalizeCurrentRound(round: DiceRound | RouletteRound | StoredRouletteRound): LobbyRound {
  if (round.game === "dice") {
    return {
      ...round,
      cheatersPercent: round.cheatersPercent ?? 0,
      edgePercent: round.edgePercent ?? 0,
      bets: round.bets.map((bet) => ({
        ...bet,
        isCheater: bet.isCheater ?? false,
      })),
      results: round.results.map((result) => ({
        ...result,
        isCheater: result.isCheater ?? false,
      })),
    };
  }

  return normalizeRouletteRound(round);
}

function normalizeLobbySnapshot(rawLobby: RawLobbySnapshot): { lobby: LobbySnapshot; changed: boolean } {
  let changed = false;
  const rawCurrentRound = rawLobby.currentRound;

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
    currentRound: rawLobby.currentRound == null ? null : normalizeCurrentRound(rawLobby.currentRound),
  };

  if (
    rawLobby.totalRoundMoneyAllocated === undefined ||
    rawCurrentRound === undefined ||
    (rawCurrentRound?.game === "dice" &&
      (rawCurrentRound.cheatersPercent === undefined ||
        rawCurrentRound.edgePercent === undefined ||
        rawCurrentRound.bets.some((bet) => bet.isCheater === undefined) ||
        rawCurrentRound.results.some((result) => result.isCheater === undefined))) ||
    (rawCurrentRound?.game === "roulette" &&
      ((rawCurrentRound as RouletteRound & { zeroes?: number }).zeroes === undefined ||
        rawCurrentRound.bettingEndsAt === undefined ||
        rawCurrentRound.spinEndsAt === undefined ||
        rawCurrentRound.wheelPockets === undefined ||
        rawCurrentRound.winningPocket === undefined ||
        rawCurrentRound.betComplexity === undefined ||
        rawCurrentRound.bets === undefined ||
        rawCurrentRound.results === undefined))
  ) {
    changed = true;
  }

  return { lobby, changed };
}

async function saveLobby(lobby: LobbySnapshot) {
  const redis = getRedis();
  const compactLobby = compactLobbySnapshot(lobby);

  await Promise.all([
    redis.set(lobbyKey(lobby.lobbyId), compactLobby, { ex: LOBBY_TTL_SECONDS }),
    redis.set(codeKey(lobby.code), lobby.lobbyId, { ex: LOBBY_TTL_SECONDS }),
  ]);
}

function compactRouletteBet(bet: RouletteBet): StoredRouletteBet {
  return {
    sessionId: bet.sessionId,
    displayName: bet.displayName,
    amount: bet.amount,
    placedAt: bet.placedAt,
    betKey: bet.betKey,
  };
}

function compactRouletteResult(result: RouletteResult): StoredRouletteResult {
  return {
    sessionId: result.sessionId,
    displayName: result.displayName,
    totalBet: result.totalBet,
    payout: result.payout,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
  };
}

function compactRouletteRound(round: RouletteRound): StoredRouletteRound {
  return {
    id: round.id,
    game: round.game,
    phase: round.phase,
    addMoney: round.addMoney,
    minimumBet: round.minimumBet,
    zeroes: round.zeroes,
    betComplexity: round.betComplexity,
    startedAt: round.startedAt,
    bettingEndsAt: round.bettingEndsAt,
    spinEndsAt: round.spinEndsAt,
    resultsEndsAt: round.resultsEndsAt,
    winningPocket: round.winningPocket,
    bets: round.bets.map(compactRouletteBet),
    results: round.results.map(compactRouletteResult),
  };
}

function compactLobbySnapshot(lobby: LobbySnapshot): RawLobbySnapshot {
  return {
    ...lobby,
    currentRound:
      lobby.currentRound == null
        ? null
        : lobby.currentRound.game === "roulette"
          ? compactRouletteRound(lobby.currentRound)
          : lobby.currentRound,
  };
}

async function deleteLobby(lobby: LobbySnapshot) {
  const redis = getRedis();

  await Promise.all([redis.del(lobbyKey(lobby.lobbyId)), redis.del(codeKey(lobby.code))]);
}

async function releaseLobbyLock(lobbyId: string, token: string) {
  const redis = getRedis();

  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0`,
    [lobbyLockKey(lobbyId)],
    [token],
  );
}

async function acquireLobbyLock(lobbyId: string, waitMs = LOBBY_LOCK_WAIT_MS) {
  const redis = getRedis();
  const token = randomUUID();
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    const acquired = await redis.set(lobbyLockKey(lobbyId), token, {
      nx: true,
      px: LOBBY_LOCK_TTL_MS,
    });

    if (acquired) {
      return token;
    }

    await sleep(LOBBY_LOCK_RETRY_DELAY_MS);
  }

  throw new LobbyError(
    "LOBBY_BUSY",
    "The lobby is busy. Please try again.",
    503,
  );
}

async function withLobbyMutationLock<T>(lobbyId: string, operation: () => Promise<T>, waitMs?: number) {
  const token = await acquireLobbyLock(lobbyId, waitMs);

  try {
    return await operation();
  } finally {
    await releaseLobbyLock(lobbyId, token);
  }
}

function isRoundTransitionDue(round: LobbyRound | null) {
  if (!round) {
    return false;
  }

  const now = Date.now();

  if (round.game === "dice") {
    return round.phase === "betting" && new Date(round.bettingEndsAt).getTime() <= now;
  }

  if (round.game === "roulette") {
    return round.phase === "betting" && new Date(round.bettingEndsAt).getTime() + ROULETTE_BETTING_GRACE_MS <= now;
  }

  return false;
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
  return index === 0 ? "Cheater" : `Cheater ${index + 1}`;
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

function resolveRouletteRound(lobby: LobbySnapshot, timestamp: string): LobbySnapshot {
  const currentRound = lobby.currentRound;

  if (!currentRound || currentRound.game !== "roulette" || currentRound.phase !== "betting") {
    return lobby;
  }

  const winningPocket = currentRound.wheelPockets[Math.floor(Math.random() * currentRound.wheelPockets.length)] ?? 0;
  const betsBySession = new Map<string, RouletteBet[]>();

  currentRound.bets.forEach((bet) => {
    const currentBets = betsBySession.get(bet.sessionId) ?? [];
    currentBets.push(bet);
    betsBySession.set(bet.sessionId, currentBets);
  });

  const nextPlayers = lobby.players.map((player) => {
    const playerBets = betsBySession.get(player.sessionId) ?? [];
    const payout = playerBets.reduce((total, bet) => (
      bet.pockets.includes(winningPocket) ? total + bet.amount * (bet.payoutMultiplier + 1) : total
    ), 0);

    return payout > 0
      ? {
          ...player,
          balance: player.balance + payout,
        }
      : player;
  });

  const originalBalances = new Map(lobby.players.map((player) => [player.sessionId, player.balance]));
  const nextBalances = new Map(nextPlayers.map((player) => [player.sessionId, player.balance]));
  const results: RouletteResult[] = lobby.players
    .filter((player) => betsBySession.has(player.sessionId))
    .map((player) => {
      const bets = betsBySession.get(player.sessionId) ?? [];
      const winningBets = bets.filter((bet) => bet.pockets.includes(winningPocket));
      const payout = winningBets.reduce((total, bet) => total + bet.amount * (bet.payoutMultiplier + 1), 0);
      const totalBet = bets.reduce((total, bet) => total + bet.amount, 0);

      return {
        sessionId: player.sessionId,
        displayName: player.displayName,
        totalBet,
        payout,
        balanceBefore: originalBalances.get(player.sessionId) ?? 0,
        balanceAfter: nextBalances.get(player.sessionId) ?? 0,
        bets,
        winningBets,
      };
    })
    .sort((left, right) => {
      const leftNet = left.payout - left.totalBet;
      const rightNet = right.payout - right.totalBet;

      if (rightNet !== leftNet) {
        return rightNet - leftNet;
      }

      return left.displayName.localeCompare(right.displayName);
    });

  const pocketColor = getRoulettePocketColor(winningPocket);
  const nextRound: RouletteRound = {
    ...currentRound,
    phase: "results",
    winningPocket,
    spinEndsAt: addMilliseconds(timestamp, ROULETTE_SPIN_DURATION_MS),
    resultsEndsAt: addMilliseconds(timestamp, ROULETTE_RESULTS_DURATION_MS),
    results,
    message: `Ball landed on ${formatRoulettePocket(winningPocket)} ${pocketColor}.`,
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

export function summarizeLobby(lobby: LobbySnapshot): LobbySummary {
  return lobby;
}

export function findLobbyPlayer(lobby: LobbySnapshot, sessionId: string | undefined) {
  if (!sessionId) {
    return undefined;
  }

  return lobby.players.find((player) => player.sessionId === sessionId);
}

export async function getLobbyById(lobbyId: string): Promise<LobbySnapshot> {
  const redis = getRedis();
  const rawLobby = await redis.get<RawLobbySnapshot>(lobbyKey(lobbyId));

  if (!rawLobby) {
    throw new LobbyError("LOBBY_NOT_FOUND", "Lobby not found or expired.", 404);
  }

  const { lobby, changed } = normalizeLobbySnapshot(rawLobby);

  if (changed) {
    await saveLobby(lobby);
  }

  return lobby;
}

export async function getLobbySummaryById(lobbyId: string): Promise<LobbySummary> {
  return summarizeLobby(await getLobbyById(lobbyId));
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
      status: "started",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
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
  return withLobbyMutationLock(lobbyId, async () => {
    const lobby = await getLobbyById(lobbyId);

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
  });
}

export async function leaveLobby(lobbyId: string, sessionId: string) {
  return withLobbyMutationLock(lobbyId, async () => {
    const lobby = await getLobbyById(lobbyId);
    const remainingPlayers = lobby.players.filter((player) => player.sessionId !== sessionId);

    if (remainingPlayers.length === lobby.players.length) {
      return { deleted: false as const, lobby };
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
  });
}

export async function startLobby(lobbyId: string, sessionId: string): Promise<LobbySnapshot> {
  return withLobbyMutationLock(lobbyId, async () => {
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
  });
}

export async function startGameRound(
  lobbyId: string,
  sessionId: string,
  input: StartRoundInput,
): Promise<LobbySnapshot> {
  const addMoney = toNonNegativeInteger(input.addMoney, "Add money");
  const minimumBet = toNonNegativeInteger(input.minimumBet, "Minimum bet");

  if (input.game !== "dice" && input.game !== "roulette") {
    throw new LobbyError("INVALID_GAME", "Choose a valid game type.", 400);
  }

  const cheatersPercent = input.game === "dice" ? toPercentage(input.cheatersPercent, "Cheaters") : 0;
  const edgePercent = input.game === "dice" ? toPercentage(input.edgePercent, "Edge") : 0;
  const zeroes = input.game === "roulette" ? toZeroCount(input.zeroes) : 0;
  const betComplexity = input.game === "roulette" ? input.betComplexity : "simple";

  return withLobbyMutationLock(lobbyId, async () => {
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
            phase: "betting",
            addMoney,
            minimumBet,
            zeroes,
            betComplexity,
            startedAt: now,
            bettingEndsAt: addMilliseconds(now, ROULETTE_BETTING_DURATION_MS),
            spinEndsAt: null,
            resultsEndsAt: null,
            wheelPockets: getRouletteWheelPockets(zeroes),
            winningPocket: null,
            bets: [],
            results: [],
            message: `Roulette board configured with ${formatRouletteZeroes(zeroes)}. ${betComplexity === "simple" ? "Simple mode limits bets to red or black." : betComplexity === "intermediate" ? "Intermediate mode allows straight numbers plus red or black." : "Advanced mode unlocks the full table."}`,
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
  });
}

export async function placeRoundBet(
  lobbyId: string,
  sessionId: string,
  input: PlaceRoundBetInput = { game: "dice" },
): Promise<LobbySnapshot> {
  return withLobbyMutationLock(lobbyId, async () => {
    const lobby = await getLobbyById(lobbyId);
    const currentRound = lobby.currentRound;

    if (!currentRound) {
      throw new LobbyError("ROUND_NOT_ACTIVE", "There is no active round to join.", 409);
    }

    if (currentRound.phase !== "betting") {
      throw new LobbyError("BETTING_CLOSED", "Betting for this round is closed.", 409);
    }

    if (
      currentRound.game === "dice"
        ? new Date(currentRound.bettingEndsAt).getTime() <= Date.now()
        : new Date(currentRound.bettingEndsAt).getTime() + ROULETTE_BETTING_GRACE_MS <= Date.now()
    ) {
      throw new LobbyError("BETTING_CLOSED", "Betting for this round is closed.", 409);
    }

    const player = requireLobbyPlayer(lobby, sessionId);

    if (currentRound.game === "dice") {
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

    if (input.game !== "roulette") {
      throw new LobbyError("INVALID_AMOUNT", "Select valid roulette bets.", 400);
    }

    const definitions = getRouletteBetDefinitionMap(currentRound.zeroes);
    const allowedDefinitions = filterRouletteBetDefinitionsByComplexity(
      Array.from(definitions.values()),
      currentRound.betComplexity,
    );
    const allowedKeys = new Set(allowedDefinitions.map((definition) => definition.key));
    const selectedPlacements = input.placementKeys.map((key) => definitions.get(key) ?? null);

    if (selectedPlacements.some((placement) => placement == null) || input.placementKeys.some((key) => !allowedKeys.has(key))) {
      throw new LobbyError("INVALID_AMOUNT", "One or more roulette bets are invalid for this table.", 400);
    }

    const existingPlayerBets = currentRound.bets.filter((bet) => bet.sessionId === sessionId);
    const otherPlayerBets = currentRound.bets.filter((bet) => bet.sessionId !== sessionId);
    const existingStake = existingPlayerBets.reduce((total, bet) => total + bet.amount, 0);
    const totalStake = input.placementKeys.length * currentRound.minimumBet;
    const netStakeChange = totalStake - existingStake;

    if (netStakeChange > 0 && player.balance < netStakeChange) {
      throw new LobbyError("INSUFFICIENT_FUNDS", "You do not have enough money to place those bets.", 409);
    }

    const now = nowIso();
    const placedBets: RouletteBet[] = selectedPlacements.map((placement) => ({
      sessionId,
      displayName: player.displayName,
      amount: currentRound.minimumBet,
      placedAt: now,
      betKey: placement!.key,
      label: placement!.label,
      type: placement!.type,
      payoutMultiplier: placement!.payoutMultiplier,
      pockets: placement!.pockets,
    }));

    const nextPlayers = lobby.players.map((entry) =>
      entry.sessionId === sessionId
        ? {
            ...entry,
            balance: entry.balance - netStakeChange,
          }
        : entry,
    );

    const nextRound: RouletteRound = {
      ...currentRound,
      bets: [...otherPlayerBets, ...placedBets],
    };

    const nextLobby: LobbySnapshot = {
      ...lobby,
      players: nextPlayers,
      currentRound: nextRound,
      updatedAt: now,
    };

    await saveLobby(nextLobby);
    return nextLobby;
  }, 5_000);
}

export async function syncLobbyRoundState(lobbyId: string) {
  const lobby = await getLobbyById(lobbyId);
  const currentRound = lobby.currentRound;

  if (!isRoundTransitionDue(currentRound)) {
    return { lobby, changed: false };
  }

  return withLobbyMutationLock(lobbyId, async () => {
    const lockedLobby = await getLobbyById(lobbyId);
    const lockedRound = lockedLobby.currentRound;

    if (!lockedRound) {
      return { lobby: lockedLobby, changed: false };
    }

    const now = nowIso();

    if (lockedRound.game === "dice") {
      if (lockedRound.phase === "betting" && new Date(lockedRound.bettingEndsAt).getTime() <= Date.now()) {
        const resolvedLobby = resolveDiceRound(lockedLobby, now);
        await saveLobby(resolvedLobby);
        return { lobby: resolvedLobby, changed: true };
      }
    }

    if (lockedRound.game === "roulette") {
      if (
        lockedRound.phase === "betting" &&
        new Date(lockedRound.bettingEndsAt).getTime() + ROULETTE_BETTING_GRACE_MS <= Date.now()
      ) {
        const resolvedLobby = resolveRouletteRound(lockedLobby, now);
        await saveLobby(resolvedLobby);
        return { lobby: resolvedLobby, changed: true };
      }
    }

    return { lobby: lockedLobby, changed: false };
  });
}

export async function forceResolveCurrentRound(lobbyId: string): Promise<LobbySnapshot> {
  return withLobbyMutationLock(lobbyId, async () => {
    const lobby = await getLobbyById(lobbyId);
    const currentRound = lobby.currentRound;

    if (!currentRound || currentRound.phase !== "betting") {
      return lobby;
    }

    const now = nowIso();
    const resolvedLobby = currentRound.game === "dice"
      ? resolveDiceRound(lobby, now)
      : resolveRouletteRound(lobby, now);

    await saveLobby(resolvedLobby);
    return resolvedLobby;
  });
}

export async function returnLobbyToSetup(lobbyId: string, sessionId: string): Promise<LobbySnapshot> {
  return withLobbyMutationLock(lobbyId, async () => {
    const lobby = await getLobbyById(lobbyId);

    if (lobby.hostSessionId !== sessionId) {
      throw new LobbyError("NOT_HOST", "Only the host can return the lobby to setup.", 403);
    }

    if (!lobby.currentRound || lobby.currentRound.phase !== "results") {
      throw new LobbyError("ROUND_NOT_ACTIVE", "There are no round results to close.", 409);
    }

    const now = nowIso();
    const nextLobby = clearFinishedRound(lobby, now);
    await saveLobby(nextLobby);
    return nextLobby;
  });
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
