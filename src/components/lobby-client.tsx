"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "next/navigation";
import Pusher from "pusher-js";
import { QRCodeSVG } from "qrcode.react";

import styles from "./lobby-client.module.css";

import type {
  CompletedDiceRound,
  CompletedLobbyRound,
  CompletedRouletteRound,
  DiceResult,
  DiceRound,
  GameType,
  LobbySummary,
  RouletteBet,
  RouletteResult,
  RouletteRound,
} from "@/lib/lobby";
import {
  filterRouletteBetDefinitionsByComplexity,
  formatRoulettePocket,
  formatRouletteZeroes,
  getRouletteBetDefinitions,
  getRoulettePocketColor,
  type RouletteBetComplexity,
  type RouletteBetDefinition,
  type RoulettePocket,
} from "@/lib/roulette";

type LobbyClientProps = {
  initialLobby: LobbySummary;
  initialServerTime: string;
  initialSessionId?: string;
  shareUrl: string;
  realtimeEnabled: boolean;
};

type LobbyPayload = {
  lobby: LobbySummary;
  serverTime?: string;
};

type LobbyUpdatedEventPayload = {
  lobbyId: string;
  serverTime?: string;
};

type RoundStageId = "setup" | "bet" | "roll" | "results";
type SidebarTab = "players" | "share";

type RoundStageSummary = {
  activeStage: RoundStageId;
  detail: string;
  timerLabel?: string;
  title: string;
};

type DiceSettingsFields = {
  addMoney: string;
  minimumBet: string;
  cheatersPercent: string;
  edgePercent: string;
};

type RouletteSettingsFields = {
  addMoney: string;
  minimumBet: string;
  zeroes: string;
  betComplexity: RouletteBetComplexity;
};

type RoundSettingsState = {
  dice: DiceSettingsFields;
  roulette: RouletteSettingsFields;
};

const DICE_STAGE_DURATION_MS = 15_000;
const DICE_REVEAL_MILESTONES_MS = [900, 2_800, 4_900, 7_000, 9_200];
const DIE_ROLL_FRAME_MS = 90;
const CLIENT_HISTORY_LIMIT = 8;
const DEVELOPMENT_MULTI_ROUND_SIMULATION_COUNT = 10;
const ROULETTE_SPIN_DURATION_MS = 10_000;
const ROULETTE_RESULTS_REVEAL_DELAY_MS = 1_200;
const ROULETTE_BALL_RAIL_DELAY_MS = 4_000;
const ROULETTE_BALL_RAIL_DURATION_MS = 2_000;
const ROULETTE_BALL_BOUNCE_DURATION_MS = 2_000;
const ROULETTE_BALL_LOCK_DURATION_MS = 2_000;
const ROULETTE_WHEEL_SPIN_TURNS = 4;
const ROULETTE_BALL_RAIL_TURNS = 0.2;
const DICE_PRESETS: Array<{ label: string; values: DiceSettingsFields }> = [
  {
    label: "Preset $1",
    values: {
      addMoney: "1",
      minimumBet: "1",
      cheatersPercent: "0",
      edgePercent: "0",
    },
  },
  {
    label: "Preset $4",
    values: {
      addMoney: "4",
      minimumBet: "4",
      cheatersPercent: "10",
      edgePercent: "20",
    },
  },
  {
    label: "Preset $10",
    values: {
      addMoney: "10",
      minimumBet: "10",
      cheatersPercent: "30",
      edgePercent: "40",
    },
  },
];
const ROULETTE_PRESETS: Array<{ label: string; values: RouletteSettingsFields }> = [
  {
    label: "Preset 0",
    values: {
      addMoney: "50",
      minimumBet: "10",
      zeroes: "1",
      betComplexity: "simple",
    },
  },
  {
    label: "Preset 00",
    values: {
      addMoney: "100",
      minimumBet: "10",
      zeroes: "2",
      betComplexity: "intermediate",
    },
  },
  {
    label: "Preset 000",
    values: {
      addMoney: "250",
      minimumBet: "25",
      zeroes: "3",
      betComplexity: "advanced",
    },
  },
];

const currencyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const diceFaces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const roundStages: Array<{ id: RoundStageId; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "bet", label: "Bet" },
  { id: "roll", label: "Roll" },
  { id: "results", label: "Results" },
];

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? "The request failed.";
}

function formatMoney(value: number) {
  return currencyFormatter.format(value);
}

function formatNetMoney(value: number) {
  return value > 0 ? `+${formatMoney(value)}` : formatMoney(value);
}

function formatRoi(value: number) {
  const formatted = percentFormatter.format(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function formatNetRoundDelta(payout: number, bet: number) {
  return formatNetMoney(payout - bet);
}

function getSignedMoneyToneClass(value: number) {
  return value > 0 ? styles.moneyPositive : value < 0 ? styles.moneyNegative : "";
}

function secondsRemaining(target: string, now: number) {
  return Math.max(0, Math.ceil((new Date(target).getTime() - now) / 1000));
}

function secondsRemainingAt(targetTime: number, now: number) {
  return Math.max(0, Math.ceil((targetTime - now) / 1000));
}

function renderDie(value: number) {
  return diceFaces[value] ?? String(value);
}

function getRollingDieValue(seed: string, index: number, tick: number) {
  let hash = 0;

  for (let characterIndex = 0; characterIndex < seed.length; characterIndex += 1) {
    hash = (hash * 31 + seed.charCodeAt(characterIndex)) % 997;
  }

  return ((hash + index * 17 + tick * 5) % 6) + 1;
}

function getRollingDieIndex(resultRevealStep: number, resultsVisible: boolean) {
  if (resultsVisible || resultRevealStep < 1) {
    return null;
  }

  const settledDiceCount = Math.max(0, Math.min(resultRevealStep - 1, 4));
  return settledDiceCount < 4 ? settledDiceCount : null;
}

function matchesPreset(settings: DiceSettingsFields, preset: DiceSettingsFields) {
  return (
    settings.addMoney === preset.addMoney &&
    settings.minimumBet === preset.minimumBet &&
    settings.cheatersPercent === preset.cheatersPercent &&
    settings.edgePercent === preset.edgePercent
  );
}

function matchesRoulettePreset(settings: RouletteSettingsFields, preset: RouletteSettingsFields) {
  return (
    settings.addMoney === preset.addMoney &&
    settings.minimumBet === preset.minimumBet &&
    settings.zeroes === preset.zeroes &&
    settings.betComplexity === preset.betComplexity
  );
}

function getRouletteSelectionCount(keys: string[], key: string) {
  return keys.reduce((total, current) => (current === key ? total + 1 : total), 0);
}

function groupRouletteBetsByKey(bets: RouletteBet[]) {
  const grouped = new Map<string, { bet: RouletteBet; count: number }>();

  bets.forEach((bet) => {
    const current = grouped.get(bet.betKey);

    if (current) {
      current.count += 1;
      return;
    }

    grouped.set(bet.betKey, { bet, count: 1 });
  });

  return Array.from(grouped.values());
}

function getRoulettePocketSortValue(pocket: RoulettePocket) {
  return pocket <= 0 ? pocket : pocket + 10;
}

function compareRouletteBetDefinitions(left: RouletteBetDefinition, right: RouletteBetDefinition) {
  const leftColorPriority = left.type === "color" ? (left.key.includes("red") ? 0 : 1) : 2;
  const rightColorPriority = right.type === "color" ? (right.key.includes("red") ? 0 : 1) : 2;

  if (leftColorPriority !== rightColorPriority) {
    return leftColorPriority - rightColorPriority;
  }

  if (left.payoutMultiplier !== right.payoutMultiplier) {
    return left.payoutMultiplier - right.payoutMultiplier;
  }

  const leftPocket = getRoulettePocketSortValue(left.pockets[0] ?? Number.MAX_SAFE_INTEGER);
  const rightPocket = getRoulettePocketSortValue(right.pockets[0] ?? Number.MAX_SAFE_INTEGER);

  if (leftPocket !== rightPocket) {
    return leftPocket - rightPocket;
  }

  if (left.pockets.length !== right.pockets.length) {
    return left.pockets.length - right.pockets.length;
  }

  return left.label.localeCompare(right.label);
}

function sortRouletteBetDefinitions(definitions: RouletteBetDefinition[]) {
  return [...definitions].sort(compareRouletteBetDefinitions);
}

function getRouletteBetExpectedValue(definition: RouletteBetDefinition, zeroes: number) {
  const totalPockets = 36 + Math.max(0, zeroes);

  return ((definition.payoutMultiplier + 1) * definition.pockets.length) / totalPockets;
}

function compareRouletteResults(left: RouletteResult, right: RouletteResult) {
  const leftNet = left.payout - left.totalBet;
  const rightNet = right.payout - right.totalBet;

  if (leftNet !== rightNet) {
    return rightNet - leftNet;
  }

  if (left.payout !== right.payout) {
    return right.payout - left.payout;
  }

  if (left.totalBet !== right.totalBet) {
    return right.totalBet - left.totalBet;
  }

  return left.displayName.localeCompare(right.displayName);
}

function sortGroupedRouletteBetEntries(entries: Array<{ bet: RouletteBet; count: number }>) {
  return entries
    .map((entry) => ({
      ...entry,
      amount: entry.bet.amount * entry.count,
    }))
    .sort((left, right) => left.bet.payoutMultiplier - right.bet.payoutMultiplier || left.bet.label.localeCompare(right.bet.label));
}

function getRouletteGroupedBetNet(entry: { bet: RouletteBet; amount: number }, winningPocket: RoulettePocket | null) {
  return winningPocket !== null && entry.bet.pockets.includes(winningPocket)
    ? entry.amount * entry.bet.payoutMultiplier
    : -entry.amount;
}

function getHistoryStorageKey(lobbyId: string) {
  return `lobby-history:${lobbyId}`;
}

function getCompletedRound(round: LobbySummary["currentRound"]): CompletedLobbyRound | null {
  return round?.phase === "results" ? round as CompletedLobbyRound : null;
}

function appendCompletedRound(history: CompletedLobbyRound[], round: CompletedLobbyRound) {
  const nextHistory = [round, ...history.filter((entry) => entry.id !== round.id)];
  return nextHistory.slice(0, CLIENT_HISTORY_LIMIT);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value ** 3
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function getRoulettePocketGradient(pockets: RoulettePocket[]) {
  const angleStep = 360 / Math.max(1, pockets.length);

  return `conic-gradient(from ${-angleStep / 2}deg, ${pockets.map((pocket, index) => {
    const color = getRoulettePocketColor(pocket);
    const background =
      color === "red"
        ? "rgb(211, 49, 39)"
        : color === "black"
          ? "rgb(47, 47, 50)"
          : "rgb(99, 184, 54)";
    const start = (index * angleStep).toFixed(4);
    const end = ((index + 1) * angleStep).toFixed(4);
    return `${background} ${start}deg ${end}deg`;
  }).join(", ")})`;
}

export function LobbyClient({
  initialLobby,
  initialServerTime,
  initialSessionId,
  shareUrl,
  realtimeEnabled,
}: LobbyClientProps) {
  const router = useRouter();
  const initialServerTimeMs = new Date(initialServerTime).getTime();
  const initialCompletedRound = getCompletedRound(initialLobby.currentRound);
  const [lobby, setLobby] = useState(initialLobby);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(() =>
    Number.isNaN(initialServerTimeMs) ? 0 : initialServerTimeMs - Date.now(),
  );
  const [joinName, setJoinName] = useState("Player");
  const [busy, setBusy] = useState<"idle" | "join" | "leave" | "start-round" | "simulate-rounds" | "bet" | "finish-round">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("players");
  const [qrExpanded, setQrExpanded] = useState(false);
  const [expandedResultLists, setExpandedResultLists] = useState<string[]>([]);
  const [gameTab, setGameTab] = useState<GameType>("dice");
  const [rouletteBetSelectionDraft, setRouletteBetSelectionDraft] = useState<{ roundId: string; keys: string[] } | null>(null);
  const [isRouletteBetSaving, setIsRouletteBetSaving] = useState(false);
  const [expandedRoundState, setExpandedRoundState] = useState<{
    scopeRoundId: string | null;
    value: string | false | null;
  }>({
    scopeRoundId: null,
    value: null,
  });
  const [rollAnimationTick, setRollAnimationTick] = useState(0);
  const [roundHistory, setRoundHistory] = useState<CompletedLobbyRound[]>(() => {
    if (typeof window === "undefined") {
      return initialCompletedRound ? [initialCompletedRound] : [];
    }

    try {
      const storedHistory = window.localStorage.getItem(getHistoryStorageKey(initialLobby.lobbyId));
      const parsedHistory = storedHistory ? JSON.parse(storedHistory) as CompletedLobbyRound[] : [];
      const baseHistory = Array.isArray(parsedHistory) ? parsedHistory : [];

      return initialCompletedRound ? appendCompletedRound(baseHistory, initialCompletedRound) : baseHistory;
    } catch {
      return initialCompletedRound ? [initialCompletedRound] : [];
    }
  });
  const [settings, setSettings] = useState<RoundSettingsState>({
    dice: {
      addMoney: "1",
      minimumBet: "1",
      cheatersPercent: "0",
      edgePercent: "0",
    },
    roulette: {
      addMoney: "100",
      minimumBet: "10",
      zeroes: "1",
      betComplexity: "simple",
    },
  });
  const [now, setNow] = useState(() => (Number.isNaN(initialServerTimeMs) ? Date.now() : initialServerTimeMs));
  const viewer = initialSessionId
    ? lobby.players.find((player) => player.sessionId === initialSessionId)
    : undefined;
  const isHost = Boolean(initialSessionId && lobby.hostSessionId === initialSessionId);
  const activeRound = lobby.currentRound;
  const displayedPlayers = activeRound?.game === "dice" && activeRound.phase === "betting"
    ? (() => {
        const betSessions = new Set(activeRound.bets.map((bet) => bet.sessionId));

        return lobby.players.map((player) => ({
          ...player,
          balance:
            player.balance -
            activeRound.addMoney +
            (betSessions.has(player.sessionId) ? activeRound.minimumBet : 0),
        }));
      })()
    : lobby.players;
  const headlineFunds = viewer ? formatMoney(viewer.balance) : formatMoney(0);
  const shouldPollLobby = lobby.status === "started" && !realtimeEnabled && (
    !activeRound ||
    activeRound.game === "roulette" ||
    activeRound.phase === "betting"
  );
  const lobbyPollKey = shouldPollLobby
    ? [lobby.status, activeRound?.id ?? "setup", activeRound?.game ?? "none", activeRound?.phase ?? "setup"].join(":")
    : null;
  const totalMoney = displayedPlayers.reduce((total, player) => total + player.balance, 0);
  const displayedTotalRoundMoneyAllocated = activeRound?.game === "dice" && activeRound.phase === "betting"
    ? lobby.totalRoundMoneyAllocated - activeRound.addMoney * lobby.players.length
    : lobby.totalRoundMoneyAllocated;
  const displayedAllocatedPerPlayer = lobby.players.length > 0
    ? displayedTotalRoundMoneyAllocated / lobby.players.length
    : 0;
  const totalReturn = totalMoney - displayedTotalRoundMoneyAllocated;
  const totalRoi = displayedTotalRoundMoneyAllocated > 0
    ? totalReturn / displayedTotalRoundMoneyAllocated
    : 0;
  const playerReturn = viewer ? viewer.balance - displayedAllocatedPerPlayer : 0;
  const bettingCountdown =
    activeRound?.phase === "betting"
      ? secondsRemaining(activeRound.bettingEndsAt, now)
      : 0;
  const viewerHasBet =
    activeRound?.game === "dice" && activeRound.phase === "betting" && initialSessionId
      ? activeRound.bets.some((bet) => bet.sessionId === initialSessionId)
      : false;
  const viewerRouletteBets =
    activeRound?.game === "roulette" && initialSessionId
      ? activeRound.bets.filter((bet) => bet.sessionId === initialSessionId)
      : [];
  const viewerRouletteBetKeys = viewerRouletteBets.map((bet) => bet.betKey);
  const viewerRouletteBetKey = viewerRouletteBetKeys.join("|");
  const selectedRouletteBetKeys =
    activeRound?.game === "roulette" && activeRound.phase === "betting" && rouletteBetSelectionDraft?.roundId === activeRound.id
      ? rouletteBetSelectionDraft.keys
      : activeRound?.game === "roulette" && activeRound.phase === "betting"
        ? viewerRouletteBetKeys
      : [];
  const viewerHasRouletteBet =
    activeRound?.game === "roulette" && activeRound.phase === "betting"
      ? selectedRouletteBetKeys.length > 0
      : viewerRouletteBets.length > 0;
  const isRouletteBetLocked = Boolean(
    activeRound?.game === "roulette" && activeRound.phase === "betting" && bettingCountdown <= 0,
  );
  const activeRouletteResult =
    activeRound?.game === "roulette" && activeRound.phase === "results" && initialSessionId
      ? activeRound.results.find((result) => result.sessionId === initialSessionId)
      : undefined;
  const viewerResult =
    activeRound?.game === "dice" && activeRound.phase === "results" && initialSessionId
      ? activeRound.results.find((result) => result.sessionId === initialSessionId)
      : undefined;
  const diceStageEndsAt =
    activeRound?.game === "dice" && activeRound.phase === "results"
      ? new Date(activeRound.bettingEndsAt).getTime() + DICE_STAGE_DURATION_MS
      : null;
  const diceStageCountdown = diceStageEndsAt ? secondsRemainingAt(diceStageEndsAt, now) : 0;
  const resultRevealStep =
    activeRound?.game === "dice" && activeRound.phase === "results"
      ? DICE_REVEAL_MILESTONES_MS.reduce(
          (step, milestone, index) =>
            now >= new Date(activeRound.bettingEndsAt).getTime() + milestone ? index + 1 : step,
          0,
        )
      : 5;
  const resultsVisible =
    activeRound?.game === "dice" && activeRound.phase === "results" ? diceStageCountdown === 0 : false;
  const rouletteSpinCountdown =
    activeRound?.game === "roulette" && activeRound.phase === "results" && activeRound.spinEndsAt
      ? secondsRemaining(activeRound.spinEndsAt, now)
      : 0;
  const rouletteWinnerVisible =
    activeRound?.game === "roulette" && activeRound.phase === "results"
      ? rouletteSpinCountdown === 0
      : false;
  const rouletteResultsRevealCountdown =
    activeRound?.game === "roulette" && activeRound.phase === "results" && activeRound.spinEndsAt
      ? secondsRemainingAt(new Date(activeRound.spinEndsAt).getTime() + ROULETTE_RESULTS_REVEAL_DELAY_MS, now)
      : 0;
  const rouletteResultsVisible =
    activeRound?.game === "roulette" && activeRound.phase === "results"
      ? rouletteWinnerVisible && rouletteResultsRevealCountdown === 0
      : false;
  const rouletteSpinTimeRemainingMs =
    activeRound?.game === "roulette" && activeRound.phase === "results" && activeRound.spinEndsAt
      ? Math.max(0, new Date(activeRound.spinEndsAt).getTime() - now)
      : 0;
  const rouletteSpinElapsedMs =
    activeRound?.game === "roulette" && activeRound.phase === "results"
      ? clamp(ROULETTE_SPIN_DURATION_MS - rouletteSpinTimeRemainingMs, 0, ROULETTE_SPIN_DURATION_MS)
      : 0;
  const isRouletteAnimating = Boolean(
    activeRound?.game === "roulette" && activeRound.phase === "results" && !rouletteWinnerVisible,
  );
  const rollingDieIndex = getRollingDieIndex(resultRevealStep, resultsVisible);
  const isDiceRolling = Boolean(activeRound?.game === "dice" && activeRound.phase === "results" && rollingDieIndex !== null);
  const viewerScoreVisible = Boolean(activeRound?.game === "dice" && activeRound.phase === "results" && resultRevealStep >= 5);
  const previousRounds = activeRound?.phase === "results"
    ? roundHistory.filter((round) => round.id !== activeRound.id)
    : roundHistory;
  const previousDiceRounds = previousRounds.filter(
    (round): round is CompletedDiceRound => round.game === "dice",
  );
  const previousRouletteRounds = previousRounds.filter(
    (round): round is CompletedRouletteRound => round.game === "roulette",
  );
  const hasPlayedDiceRound = previousDiceRounds.length > 0 || (activeRound?.game === "dice" && activeRound.phase === "results");
  const hasPlayedRouletteRound = previousRouletteRounds.length > 0 || activeRound?.game === "roulette";
  const diceRoundsWithResults = activeRound?.game === "dice" && activeRound.phase === "results"
    ? [activeRound, ...previousDiceRounds]
    : previousDiceRounds;
  const rouletteRoundsWithResults = activeRound?.game === "roulette" && activeRound.phase === "results"
    ? [activeRound, ...previousRouletteRounds]
    : previousRouletteRounds;
  const totalLostToCheating = diceRoundsWithResults.reduce(
    (total, round) => total + round.results.reduce(
      (roundTotal, result) => roundTotal + (result.isCheater ? result.payout - result.bet : 0),
      0,
    ),
    0,
  );
  const totalLostToHouseEdge = rouletteRoundsWithResults.reduce((total, round) => {
    const totalBet = round.bets.reduce((roundTotal, bet) => roundTotal + bet.amount, 0);
    const totalPayout = round.results.reduce((roundTotal, result) => roundTotal + result.payout, 0);
    return total + (totalBet - totalPayout);
  }, 0);
  const currentDiceRoundNumber = activeRound?.game === "dice" && activeRound.phase === "results"
    ? previousDiceRounds.length + 1
    : null;
  const activeDiceRoundNumber = activeRound?.game === "dice"
    ? previousDiceRounds.length + 1
    : null;
  const activeRouletteRoundNumber = activeRound?.game === "roulette"
    ? previousRouletteRounds.length + 1
    : null;
  const activeRoundScopeId = activeRound?.id ?? null;
  const defaultExpandedRoundId = activeRoundScopeId ? `current:${activeRoundScopeId}` : null;
  const resolvedExpandedRoundId =
    activeRoundScopeId && expandedRoundState.scopeRoundId !== activeRoundScopeId
      ? defaultExpandedRoundId
      : expandedRoundState.value === null
        ? defaultExpandedRoundId
        : expandedRoundState.value || null;
  const roundStageSummary = getRoundStageSummary({
    activeRound,
    bettingCountdown,
    diceStageCountdown,
    initialSessionId,
    isHost,
    resultRevealStep,
    viewer,
    viewerHasBet,
    viewerHasRouletteBet,
    rouletteSpinCountdown,
  });
  const rouletteBetSelectionDraftRef = useRef<{ roundId: string; keys: string[] } | null>(rouletteBetSelectionDraft);
  const viewerRouletteBetKeysRef = useRef<string[]>(viewerRouletteBetKeys);
  const rouletteSubmitTimeoutRef = useRef<number | null>(null);
  const submittedRouletteRoundIdRef = useRef<string | null>(null);
  const applyLobbyUpdateRef = useRef<(nextLobby: LobbySummary, serverTime?: string) => void>(() => {});
  const submitLockedRouletteBetRef = useRef<(round: RouletteRound) => void>(() => {});

  const syncServerClock = useCallback((serverTime: string | undefined) => {
    if (!serverTime) {
      return;
    }

    const serverTimeMs = new Date(serverTime).getTime();

    if (Number.isNaN(serverTimeMs)) {
      return;
    }

    const nextOffsetMs = serverTimeMs - Date.now();
    setServerClockOffsetMs(nextOffsetMs);
    setNow(serverTimeMs);
  }, []);

  const applyLobbyUpdate = useCallback((nextLobby: LobbySummary, serverTime?: string) => {
    applyLobbyUpdateRef.current(nextLobby, serverTime);
  }, []);

  const fetchLobbySnapshot = useCallback(async () => {
    const response = await fetch(`/api/lobbies/${lobby.lobbyId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as LobbyPayload;
  }, [lobby.lobbyId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(getHistoryStorageKey(lobby.lobbyId), JSON.stringify(roundHistory));
    } catch {
      // Ignore storage failures and keep the local in-memory history.
    }
  }, [lobby.lobbyId, roundHistory]);

  useEffect(() => {
    if (!realtimeEnabled || !initialSessionId) {
      return undefined;
    }

    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

    if (!pusherKey || !pusherCluster) {
      return undefined;
    }

    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
      authEndpoint: "/api/realtime/auth",
    });

    const channel = pusher.subscribe(`private-lobby-${lobby.lobbyId}`);
    const handleUpdate = (payload: LobbyUpdatedEventPayload) => {
      void (async () => {
        syncServerClock(payload.serverTime);
        const nextPayload = await fetchLobbySnapshot();

        if (!nextPayload) {
          return;
        }

        applyLobbyUpdate(nextPayload.lobby, nextPayload.serverTime);
      })();
    };

    channel.bind("lobby.updated", handleUpdate);

    return () => {
      channel.unbind("lobby.updated", handleUpdate);
      pusher.unsubscribe(`private-lobby-${lobby.lobbyId}`);
      pusher.disconnect();
    };
  }, [applyLobbyUpdate, fetchLobbySnapshot, initialSessionId, lobby.lobbyId, realtimeEnabled, syncServerClock]);

  useEffect(() => {
    if (!sidebarOpen && !qrExpanded) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (qrExpanded) {
          setQrExpanded(false);
          return;
        }

        setSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [qrExpanded, sidebarOpen]);

  useEffect(() => {
    if (lobby.status !== "started" || isRouletteAnimating) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now() + serverClockOffsetMs);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRouletteAnimating, lobby.status, serverClockOffsetMs]);

  useEffect(() => {
    if (!isRouletteAnimating) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now() + serverClockOffsetMs);
    }, 40);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRouletteAnimating, serverClockOffsetMs]);

  useEffect(() => {
    if (!isDiceRolling) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setRollAnimationTick((current) => current + 1);
    }, DIE_ROLL_FRAME_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeRound?.id, isDiceRolling]);

  useEffect(() => {
    if (!realtimeEnabled || !isHost || activeRound?.phase !== "betting") {
      return undefined;
    }

    const bettingEndsAtMs = new Date(activeRound.bettingEndsAt).getTime();
    const delayMs = Math.max(0, bettingEndsAtMs - (Date.now() + serverClockOffsetMs) + 150);

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const payload = await fetchLobbySnapshot();

        if (payload) {
          applyLobbyUpdate(payload.lobby, payload.serverTime);
        }
      })();
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeRound, applyLobbyUpdate, fetchLobbySnapshot, isHost, realtimeEnabled, serverClockOffsetMs]);

  useEffect(() => {
    if (!lobbyPollKey) {
      return undefined;
    }

    let cancelled = false;

    const syncLobby = async () => {
      const payload = await fetchLobbySnapshot();

      if (cancelled || !payload) {
        return;
      }

      applyLobbyUpdate(payload.lobby, payload.serverTime);
    };

    void syncLobby();

    const intervalId = window.setInterval(() => {
      void syncLobby();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [applyLobbyUpdate, fetchLobbySnapshot, lobbyPollKey]);

  useEffect(() => {
    applyLobbyUpdateRef.current = (nextLobby: LobbySummary, serverTime?: string) => {
      syncServerClock(serverTime);
      const completedRound = getCompletedRound(nextLobby.currentRound);

      if (completedRound) {
        setRoundHistory((current) => appendCompletedRound(current, completedRound));
      }

      setLobby(nextLobby);
    };
  }, [syncServerClock]);

  useEffect(() => {
    rouletteBetSelectionDraftRef.current = rouletteBetSelectionDraft;
  }, [rouletteBetSelectionDraft]);

  useEffect(() => {
    viewerRouletteBetKeysRef.current = viewerRouletteBetKey.length > 0 ? viewerRouletteBetKey.split("|") : [];
  }, [viewerRouletteBetKey]);

  const submitLockedRouletteBet = useCallback((round: RouletteRound) => {
    submitLockedRouletteBetRef.current(round);
  }, []);

  useEffect(() => {
    submittedRouletteRoundIdRef.current = null;
  }, [activeRound?.id]);

  useEffect(() => {
    submitLockedRouletteBetRef.current = (round: RouletteRound) => {
      if (submittedRouletteRoundIdRef.current === round.id) {
        return;
      }

      submittedRouletteRoundIdRef.current = round.id;

      startTransition(() => {
        void (async () => {
          setIsRouletteBetSaving(true);
          setError(null);

          const selectionToPersist =
            rouletteBetSelectionDraftRef.current?.roundId === round.id
              ? rouletteBetSelectionDraftRef.current.keys
              : viewerRouletteBetKeysRef.current;

          const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/bet`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              game: "roulette",
              placementKeys: selectionToPersist,
            }),
          });

          setIsRouletteBetSaving(false);

          if (!response.ok) {
            submittedRouletteRoundIdRef.current = null;
            setError(await readError(response));
            return;
          }

          const payload = (await response.json()) as LobbyPayload;
          applyLobbyUpdate(payload.lobby, payload.serverTime);
        })();
      });
    };
  }, [applyLobbyUpdate, lobby.lobbyId]);

  useEffect(() => {
    return () => {
      if (rouletteSubmitTimeoutRef.current !== null) {
        window.clearTimeout(rouletteSubmitTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (rouletteSubmitTimeoutRef.current !== null) {
      window.clearTimeout(rouletteSubmitTimeoutRef.current);
      rouletteSubmitTimeoutRef.current = null;
    }

    if (!initialSessionId || !activeRound || activeRound.game !== "roulette" || activeRound.phase !== "betting") {
      return;
    }

    if (submittedRouletteRoundIdRef.current === activeRound.id) {
      return;
    }

    const delayMs = Math.max(0, new Date(activeRound.bettingEndsAt).getTime() - (Date.now() + serverClockOffsetMs));

    rouletteSubmitTimeoutRef.current = window.setTimeout(() => {
      submitLockedRouletteBet(activeRound);
    }, delayMs);

    return () => {
      if (rouletteSubmitTimeoutRef.current !== null) {
        window.clearTimeout(rouletteSubmitTimeoutRef.current);
        rouletteSubmitTimeoutRef.current = null;
      }
    };
  }, [activeRound, initialSessionId, serverClockOffsetMs, submitLockedRouletteBet]);

  useEffect(() => {
    if (!initialSessionId || !activeRound || activeRound.game !== "roulette" || activeRound.phase !== "betting") {
      return;
    }

    if (!isRouletteBetLocked || submittedRouletteRoundIdRef.current === activeRound.id) {
      return;
    }

    submitLockedRouletteBet(activeRound);
  }, [activeRound, initialSessionId, isRouletteBetLocked, submitLockedRouletteBet]);

  function updateDiceSettings(field: keyof DiceSettingsFields, value: string) {
    setSettings((current) => ({
      ...current,
      dice: {
        ...current.dice,
        [field]: value,
      },
    }));
  }

  function updateRouletteSettings(field: keyof RouletteSettingsFields, value: string) {
    setSettings((current) => ({
      ...current,
      roulette: {
        ...current.roulette,
        [field]: value,
      },
    }));
  }

  function applyDicePreset(preset: DiceSettingsFields) {
    setSettings((current) => ({
      ...current,
      dice: preset,
    }));
  }

  function applyRoulettePreset(preset: RouletteSettingsFields) {
    setSettings((current) => ({
      ...current,
      roulette: preset,
    }));
  }

  function saveRouletteBetSelection(nextSelection: string[]) {
    if (
      !initialSessionId ||
      !activeRound ||
      activeRound.game !== "roulette" ||
      activeRound.phase !== "betting" ||
      isRouletteBetLocked ||
      bettingCountdown <= 0
    ) {
      return;
    }

    rouletteBetSelectionDraftRef.current = { roundId: activeRound.id, keys: nextSelection };
    setRouletteBetSelectionDraft({ roundId: activeRound.id, keys: nextSelection });
    setError(null);
  }

  function addRouletteBetSelection(key: string) {
    saveRouletteBetSelection([...selectedRouletteBetKeys, key]);
  }

  function removeRouletteBetSelection(key: string) {
    const index = selectedRouletteBetKeys.lastIndexOf(key);

    if (index < 0) {
      return;
    }

    saveRouletteBetSelection(selectedRouletteBetKeys.filter((_, entryIndex) => entryIndex !== index));
  }

  function renderRouletteBetControl(
    definition: RouletteBetDefinition,
    minimumBet: number,
    canAddChip: boolean,
    extraClassName?: string,
    style?: React.CSSProperties,
  ) {
    const selectionCount = getRouletteSelectionCount(selectedRouletteBetKeys, definition.key);
    const wager = selectionCount * minimumBet;

    return (
      <div
        className={`${styles.rouletteBetControl} ${selectionCount > 0 ? styles.rouletteBetButtonActive : ""} ${extraClassName ?? ""}`.trim()}
        key={definition.key}
        style={style}
      >
        <button
          aria-label={`Remove chip from ${definition.label}`}
          className={`${styles.rouletteBetStepper} ${styles.rouletteBetStepperMinus}`}
          disabled={selectionCount === 0 || isRouletteBetLocked || isRouletteBetSaving}
          onClick={() => removeRouletteBetSelection(definition.key)}
          type="button"
        >
          -
        </button>
        <div className={styles.rouletteBetControlBody}>
          <strong>{definition.shortLabel}</strong>
          <span>{formatMoney(wager)}</span>
        </div>
        <button
          aria-label={`Add chip to ${definition.label}`}
          className={`${styles.rouletteBetStepper} ${styles.rouletteBetStepperPlus}`}
          disabled={!canAddChip}
          onClick={() => addRouletteBetSelection(definition.key)}
          type="button"
        >
          +
        </button>
      </div>
    );
  }

  function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("join");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/join`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: joinName }),
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        applyLobbyUpdate(payload.lobby, payload.serverTime);
        router.refresh();
        setBusy("idle");
      })();
    });
  }

  function handleStartRound(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("start-round");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            gameTab === "dice"
              ? {
                  game: gameTab,
                  addMoney: Number(settings.dice.addMoney),
                  minimumBet: Number(settings.dice.minimumBet),
                  cheatersPercent: Number(settings.dice.cheatersPercent),
                  edgePercent: Number(settings.dice.edgePercent),
                }
              : {
                  game: gameTab,
                  addMoney: Number(settings.roulette.addMoney),
                  minimumBet: Number(settings.roulette.minimumBet),
                  zeroes: Number(settings.roulette.zeroes),
                  betComplexity: settings.roulette.betComplexity,
                },
          ),
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        applyLobbyUpdate(payload.lobby, payload.serverTime);
        setRouletteBetSelectionDraft(null);
        setBusy("idle");
      })();
    });
  }

  function handleSimulateRounds() {
    startTransition(() => {
      void (async () => {
        setBusy("simulate-rounds");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            gameTab === "dice"
              ? {
                  game: gameTab,
                  addMoney: Number(settings.dice.addMoney),
                  minimumBet: Number(settings.dice.minimumBet),
                  cheatersPercent: Number(settings.dice.cheatersPercent),
                  edgePercent: Number(settings.dice.edgePercent),
                  simulateRounds: DEVELOPMENT_MULTI_ROUND_SIMULATION_COUNT,
                }
              : {
                  game: gameTab,
                  addMoney: Number(settings.roulette.addMoney),
                  minimumBet: Number(settings.roulette.minimumBet),
                  zeroes: Number(settings.roulette.zeroes),
                  betComplexity: settings.roulette.betComplexity,
                  simulateRounds: DEVELOPMENT_MULTI_ROUND_SIMULATION_COUNT,
                },
          ),
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        applyLobbyUpdate(payload.lobby, payload.serverTime);
        setRouletteBetSelectionDraft(null);
        setBusy("idle");
      })();
    });
  }

  function handlePlaceBet() {
    startTransition(() => {
      void (async () => {
        setBusy("bet");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/bet`, {
          method: "POST",
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        applyLobbyUpdate(payload.lobby, payload.serverTime);
        setBusy("idle");
      })();
    });
  }

  function handleFinishRound() {
    startTransition(() => {
      void (async () => {
        setBusy("finish-round");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/finish`, {
          method: "POST",
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        applyLobbyUpdate(payload.lobby, payload.serverTime);
        setBusy("idle");
      })();
    });
  }

  function handleLeaveLobby() {
    startTransition(() => {
      void (async () => {
        setBusy("leave");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/leave`, {
          method: "POST",
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as
          | { deleted: true; redirectUrl: string }
          | { deleted: false; lobby: LobbySummary; serverTime?: string };

        if (payload.deleted) {
          router.push(payload.redirectUrl);
          router.refresh();
          return;
        }

        applyLobbyUpdate(payload.lobby, payload.serverTime);
        router.refresh();
        setBusy("idle");
      })();
    });
  }

  function renderDiceFaces(
    dice: number[],
    keyPrefix: string,
    compact = false,
    revealCount = 4,
    currentRollingDieIndex: number | null = null,
  ) {
    return (
      <div className={compact ? styles.diceStrip : styles.diceGrid}>
        {dice.map((die, index) => {
          const isSettled = index < revealCount;
          const isRolling = currentRollingDieIndex === index;
          const displayValue = isSettled
            ? die
            : isRolling
              ? getRollingDieValue(`${keyPrefix}:${die}`, index, rollAnimationTick)
              : null;

          return (
            <div
              className={`${compact ? styles.dieFaceSmall : styles.dieFace} ${!isSettled && !isRolling ? styles.dieFaceHidden : ""} ${isRolling ? styles.dieFaceRolling : ""}`}
              key={`${keyPrefix}-${die}-${index}`}
              style={{ animationDelay: isRolling ? "0ms" : `${index * 140}ms` }}
            >
              {displayValue === null ? "?" : renderDie(displayValue)}
            </div>
          );
        })}
      </div>
    );
  }

  function renderRoundStageDisplay() {
    if (!roundStageSummary) {
      return null;
    }

    const activeIndex = roundStages.findIndex((stage) => stage.id === roundStageSummary.activeStage);
    const usesSpinLabel = activeRound?.game === "roulette" || (!activeRound && gameTab === "roulette");

    return (
      <article className={styles.stageDisplay}>
        <div className={styles.stageTrack} role="list" aria-label="Round flow">
          {roundStages.map((stage, index) => {
            const stateClassName =
              index < activeIndex
                ? styles.stageStepComplete
                : index === activeIndex
                  ? styles.stageStepActive
                  : styles.stageStepPending;
            const stageDotClassName = `${styles.stageDot} ${
              index === activeIndex
                ? `${styles.stageDotActive} ${realtimeEnabled ? styles.stageDotPulse : ""}`
                : index < activeIndex
                  ? styles.stageDotComplete
                  : ""
            }`;

            return (
              <div
                aria-current={index === activeIndex ? "step" : undefined}
                className={`${styles.stageStep} ${stateClassName}`}
                key={stage.id}
                role="listitem"
              >
                <span aria-hidden="true" className={stageDotClassName} />
                <strong>{stage.id === "roll" && usesSpinLabel ? "Spin" : stage.label}</strong>
                <span className={styles.stageState}>
                  {index < activeIndex
                    ? "Done"
                    : index === activeIndex
                      ? roundStageSummary.timerLabel ?? "Now"
                      : "Next"}
                </span>
              </div>
            );
          })}
        </div>
      </article>
    );
  }

  function renderWaitingLobbyCard() {
    return (
      <article className={`${styles.card} ${styles.cardWide}`}>
        {!viewer ? (
          <>
            <div className={styles.cardHeader}>
              <p>Join This Lobby</p>
              <span>Jump in for the next round</span>
            </div>
            <form className={styles.form} onSubmit={handleJoin}>
              <label className={styles.field}>
                <span>Display name</span>
                <input
                  autoComplete="nickname"
                  enterKeyHint="go"
                  maxLength={24}
                  onChange={(event) => setJoinName(event.target.value)}
                  placeholder="Player"
                  value={joinName}
                />
              </label>
              <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
                {busy === "join" ? "Joining..." : "Join lobby"}
              </button>
            </form>
          </>
        ) : null}
      </article>
    );
  }

  function renderSettingsCard() {
    if (!viewer) {
      return null;
    }

    if (!isHost) {
      return (
        <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
          <div className={styles.cardHeader}>
            <p>Waiting for Next Round</p>
            <span>Host controls round setup</span>
          </div>
          <p className={styles.waitingState}>
            The host is choosing the next game. Your current bankroll is {formatMoney(viewer.balance)}.
          </p>
        </article>
      );
    }

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <div className={styles.cardHeader}>
          <p>Game Settings</p>
          <span>Host only</span>
        </div>
        <div className={styles.tabRow} role="tablist" aria-label="Game selection">
          <button
            aria-selected={gameTab === "dice"}
            className={`${styles.tabButton} ${gameTab === "dice" ? styles.tabButtonActive : ""}`}
            onClick={() => setGameTab("dice")}
            role="tab"
            type="button"
          >
            Dice
          </button>
          <button
            aria-selected={gameTab === "roulette"}
            className={`${styles.tabButton} ${gameTab === "roulette" ? styles.tabButtonActive : ""}`}
            onClick={() => setGameTab("roulette")}
            role="tab"
            type="button"
          >
            Roulette
          </button>
        </div>

        {gameTab === "dice" ? (
          <div className={styles.presetRow} role="group" aria-label="Dice presets">
            {DICE_PRESETS.map((preset) => {
              const selected = matchesPreset(settings.dice, preset.values);

              return (
                <button
                  aria-pressed={selected}
                  className={`${styles.presetButton} ${selected ? styles.presetButtonActive : ""}`}
                  key={preset.label}
                  onClick={() => applyDicePreset(preset.values)}
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        ) : (
          <div className={styles.presetRow} role="group" aria-label="Roulette presets">
            {ROULETTE_PRESETS.map((preset) => {
              const selected = matchesRoulettePreset(settings.roulette, preset.values);

              return (
                <button
                  aria-pressed={selected}
                  className={`${styles.presetButton} ${selected ? styles.presetButtonActive : ""}`}
                  key={preset.label}
                  onClick={() => applyRoulettePreset(preset.values)}
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        )}

        <form className={styles.form} onSubmit={handleStartRound}>
          <div className={styles.settingsGrid}>
            <label className={styles.field}>
              <span>Add money</span>
              <input
                inputMode="numeric"
                min="0"
                name="addMoney"
                onChange={(event) => {
                  if (gameTab === "dice") {
                    updateDiceSettings("addMoney", event.target.value);
                    return;
                  }

                  updateRouletteSettings("addMoney", event.target.value);
                }}
                step="1"
                type="number"
                value={gameTab === "dice" ? settings.dice.addMoney : settings.roulette.addMoney}
              />
            </label>

            <label className={styles.field}>
              <span>Minimum bet</span>
              <input
                inputMode="numeric"
                min="0"
                name="minimumBet"
                onChange={(event) => {
                  if (gameTab === "dice") {
                    updateDiceSettings("minimumBet", event.target.value);
                    return;
                  }

                  updateRouletteSettings("minimumBet", event.target.value);
                }}
                step="1"
                type="number"
                value={gameTab === "dice" ? settings.dice.minimumBet : settings.roulette.minimumBet}
              />
            </label>

            {gameTab === "dice" ? (
              <>
                <label className={styles.field}>
                  <span>Cheaters (%)</span>
                  <input
                    inputMode="decimal"
                    min="0"
                    name="cheatersPercent"
                    onChange={(event) => updateDiceSettings("cheatersPercent", event.target.value)}
                    step="0.01"
                    type="number"
                    value={settings.dice.cheatersPercent}
                  />
                </label>

                <label className={styles.field}>
                  <span>Edge (%)</span>
                  <input
                    inputMode="decimal"
                    min="0"
                    name="edgePercent"
                    onChange={(event) => updateDiceSettings("edgePercent", event.target.value)}
                    step="0.01"
                    type="number"
                    value={settings.dice.edgePercent}
                  />
                </label>
              </>
            ) : (
              <>
                <label className={styles.field}>
                  <span>Zeroes</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    name="zeroes"
                    onChange={(event) => updateRouletteSettings("zeroes", event.target.value)}
                    step="1"
                    type="number"
                    value={settings.roulette.zeroes}
                  />
                </label>

                <label className={styles.field}>
                  <span>Bet Complexity</span>
                  <select
                    name="betComplexity"
                    onChange={(event) => updateRouletteSettings("betComplexity", event.target.value as RouletteBetComplexity)}
                    value={settings.roulette.betComplexity}
                  >
                    <option value="simple">Simple</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                  </select>
                </label>
              </>
            )}
          </div>

          <div className={styles.buttonRow}>
            <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
              {busy === "start-round" ? "Starting round..." : "Start Round"}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={busy !== "idle"}
              onClick={handleSimulateRounds}
              type="button"
            >
              {busy === "simulate-rounds"
                ? `Simulating ${DEVELOPMENT_MULTI_ROUND_SIMULATION_COUNT} rounds...`
                : `Simulate ${DEVELOPMENT_MULTI_ROUND_SIMULATION_COUNT} Rounds`}
            </button>
          </div>
        </form>
      </article>
    );
  }

  function renderDiceBettingCard(round: DiceRound) {
    const accordionId = `current:${round.id}`;
    const isExpanded = resolvedExpandedRoundId === accordionId;
    const wagerAmount = viewerHasBet ? round.minimumBet : 0;

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <button
          aria-controls={accordionId}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => setExpandedRoundState((current) => {
            const resolvedCurrent =
              current.scopeRoundId !== activeRoundScopeId
                ? defaultExpandedRoundId
                : current.value === null
                  ? defaultExpandedRoundId
                  : current.value || null;
            return {
              scopeRoundId: activeRoundScopeId,
              value: resolvedCurrent === accordionId ? false : accordionId,
            };
          })}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Dice Round {activeDiceRoundNumber}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            Prize pool: {formatMoney(round.bets.length * round.minimumBet)}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={accordionId}>
            {viewer ? (
              <div className={styles.viewerResult}>
                <div className={styles.viewerResultHeader}>
                  <h3>Your Wager</h3>
                  <span className={styles.infoChip}>Wager: {formatMoney(wagerAmount)}</span>
                </div>
                <p className={styles.waitingState}>
                  {viewerHasBet
                    ? `You are in this round for ${formatMoney(round.minimumBet)}. Sit tight while betting finishes.`
                    : `Place the minimum bet of ${formatMoney(round.minimumBet)} within 30 seconds to play.`}
                </p>
                <p className={styles.rules}>{round.rules}</p>
                {!viewerHasBet ? (
                  <div className={styles.buttonRow}>
                    <button
                      className={styles.primaryButton}
                      disabled={busy !== "idle" || viewer.balance < round.minimumBet}
                      onClick={handlePlaceBet}
                      type="button"
                    >
                      {busy === "bet" ? "Placing bet..." : "Place Bet"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  }

  function renderDiceResultStage(
    dice: number[],
    keyPrefix: string,
    score: number | string,
    compact = false,
    revealCount = 4,
    currentRollingDieIndex: number | null = null,
    showScoreOverlay = true,
  ) {
    const isScoreLocked = showScoreOverlay && score !== "...";

    return (
      <div className={styles.diceStageWrap}>
        <div className={`${styles.diceStageGrid} ${isScoreLocked ? styles.diceStageGridFaded : ""}`}>
          {renderDiceFaces(dice, keyPrefix, compact, revealCount, currentRollingDieIndex)}
        </div>
        {showScoreOverlay ? (
          <div className={`${styles.diceScoreOverlay} ${isScoreLocked ? styles.diceScoreOverlayVisible : ""}`}>
            <span className={styles.scoreValue}>{score}</span>
          </div>
        ) : null}
      </div>
    );
  }

  function renderRouletteWheel(
    pockets: RoulettePocket[],
    winningPocket: RoulettePocket | null,
    revealWinner: boolean,
    spinElapsedMs: number,
  ) {
    const angleStep = 360 / Math.max(1, pockets.length);
    const railBallRadiusPx = 108;
    const lockBallRadiusPx = 62;
    const centerColor = revealWinner && winningPocket !== null ? getRoulettePocketColor(winningPocket) : "green";
    const pocketGradient = getRoulettePocketGradient(pockets);
    const winningPocketIndex = winningPocket === null ? 0 : Math.max(0, pockets.findIndex((pocket) => pocket === winningPocket));
    const finalWheelRotationDeg = -(winningPocketIndex * angleStep);
    const totalWheelProgress = clamp(spinElapsedMs / Math.max(1, ROULETTE_SPIN_DURATION_MS), 0, 1);
    const railPhaseElapsedMs = Math.max(0, spinElapsedMs - ROULETTE_BALL_RAIL_DELAY_MS);
    const railPhaseProgress = clamp(railPhaseElapsedMs / Math.max(1, ROULETTE_BALL_RAIL_DURATION_MS), 0, 1);
    const bouncePhaseElapsedMs = Math.max(
      0,
      spinElapsedMs - ROULETTE_BALL_RAIL_DELAY_MS - ROULETTE_BALL_RAIL_DURATION_MS,
    );
    const bouncePhaseProgress = clamp(bouncePhaseElapsedMs / Math.max(1, ROULETTE_BALL_BOUNCE_DURATION_MS), 0, 1);
    const lockPhaseStartMs = ROULETTE_SPIN_DURATION_MS - ROULETTE_BALL_LOCK_DURATION_MS;
    const lockStartWheelProgress = lockPhaseStartMs / ROULETTE_SPIN_DURATION_MS;
    const wheelTargetRotationDeg = finalWheelRotationDeg - ROULETTE_WHEEL_SPIN_TURNS * 360;
    const wheelRotationDeg = revealWinner
      ? wheelTargetRotationDeg
      : lerp(0, wheelTargetRotationDeg, easeOutCubic(totalWheelProgress));
    const winningPocketAngleDeg = winningPocketIndex * angleStep;
    const lockBallAngleDeg = wheelRotationDeg + winningPocketAngleDeg;
    const lockStartBallAngleDeg = lerp(0, wheelTargetRotationDeg, easeOutCubic(lockStartWheelProgress)) + winningPocketAngleDeg;
    const railEndAngleDeg = -ROULETTE_BALL_RAIL_TURNS * 360;
    const bounceApproachAngleDeg = lerp(railEndAngleDeg, lockStartBallAngleDeg - 2, easeOutCubic(bouncePhaseProgress));
    const bouncePocketNudgeDeg = Math.sin(bouncePhaseProgress * Math.PI * 4) * (1 - bouncePhaseProgress) ** 2 * 1.75;
    const bounceRadiusJitterPx = -Math.abs(Math.sin(bouncePhaseProgress * Math.PI * 4)) * (1 - bouncePhaseProgress) ** 2 * 4.5;

    let ballAngleDeg = 0;
    let ballRadiusPx = railBallRadiusPx;
    let ballVisible = revealWinner;

    if (revealWinner) {
      ballAngleDeg = lockBallAngleDeg;
      ballRadiusPx = lockBallRadiusPx;
      ballVisible = true;
    } else if (spinElapsedMs >= lockPhaseStartMs) {
      ballAngleDeg = lockBallAngleDeg;
      ballRadiusPx = lockBallRadiusPx;
      ballVisible = true;
    } else if (spinElapsedMs >= ROULETTE_BALL_RAIL_DELAY_MS + ROULETTE_BALL_RAIL_DURATION_MS) {
      ballAngleDeg = bounceApproachAngleDeg + bouncePocketNudgeDeg;
      ballRadiusPx = lerp(railBallRadiusPx, lockBallRadiusPx, easeInOutCubic(bouncePhaseProgress)) + bounceRadiusJitterPx;
      ballVisible = true;
    } else if (spinElapsedMs >= ROULETTE_BALL_RAIL_DELAY_MS) {
      ballAngleDeg = lerp(0, railEndAngleDeg, easeOutCubic(railPhaseProgress));
      ballRadiusPx = railBallRadiusPx;
      ballVisible = true;
    }

    return (
      <div className={styles.rouletteWheelWrap}>
        <div className={styles.rouletteWheelPointer} aria-hidden="true" />
        <div className={styles.rouletteWheel}>
          <div className={styles.rouletteWheelSurface} style={{ transform: `rotate(${wheelRotationDeg}deg)` }}>
            <div className={styles.rouletteWheelPocketRing} style={{ backgroundImage: pocketGradient }}>
              <div className={styles.rouletteWheelTrack}>
                {pockets.map((pocket, index) => {
                  const isWinning = revealWinner && winningPocket === pocket;

                  return (
                    <span
                      className={`${styles.roulettePocketLabel} ${isWinning ? styles.roulettePocketWinning : ""}`}
                      key={`${pocket}-${index}`}
                      style={{
                        transform: `translate(-50%, -50%) rotate(${index * angleStep}deg) translateY(-136px)`,
                      }}
                    >
                      {formatRoulettePocket(pocket)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
          <div className={styles.rouletteWheelBallRail} aria-hidden="true" />
          <div
            className={styles.rouletteWheelBallLayer}
            style={{
              opacity: ballVisible ? 1 : 0,
              transform: `translate(-50%, -50%) rotate(${ballAngleDeg}deg) translateY(-${ballRadiusPx}px)`,
            }}
          >
            <div className={styles.rouletteWheelBall} aria-hidden="true" />
          </div>
          <div className={styles.rouletteWheelInnerBorder} aria-hidden="true" />
          <div className={styles.rouletteWheelCenter}>
            <div
              className={`${styles.rouletteWheelDisplay} ${
                centerColor === "red"
                  ? styles.rouletteWheelDisplayRed
                  : centerColor === "black"
                    ? styles.rouletteWheelDisplayBlack
                    : styles.rouletteWheelDisplayGreen
              }`}
            >
              <strong>
                {revealWinner && winningPocket !== null ? formatRoulettePocket(winningPocket) : "Spin"}
              </strong>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderRouletteBettingCard(round: RouletteRound) {
    const accordionId = `current:${round.id}`;
    const isExpanded = resolvedExpandedRoundId === accordionId;
    const definitions = sortRouletteBetDefinitions(filterRouletteBetDefinitionsByComplexity(
      getRouletteBetDefinitions(round.zeroes),
      round.betComplexity,
    ));
    const straightBets = definitions.filter((definition) => definition.type === "straight");
    const splitBets = definitions.filter((definition) => definition.type === "split");
    const streetBets = definitions.filter((definition) => definition.type === "street");
    const cornerBets = definitions.filter((definition) => definition.type === "corner");
    const sixLineBets = definitions.filter((definition) => definition.type === "six-line");
    const outsideBets = definitions.filter((definition) => definition.group === "outside");
    const colorBets = outsideBets.filter((definition) => definition.type === "color");
    const otherOutsideBets = outsideBets.filter((definition) => definition.type !== "color");
    const selectedDefinitions = selectedRouletteBetKeys
      .map((key) => definitions.find((definition) => definition.key === key))
      .filter((definition): definition is RouletteBetDefinition => Boolean(definition));
    const groupedSelectedDefinitions = selectedDefinitions.reduce<Map<string, { definition: RouletteBetDefinition; count: number }>>((current, definition) => {
      const existing = current.get(definition.key);

      if (existing) {
        existing.count += 1;
        return current;
      }

      current.set(definition.key, { definition, count: 1 });
      return current;
    }, new Map());
    const groupedSelectedBets = Array.from(groupedSelectedDefinitions.values()).map(({ definition, count }) => ({
      count,
      definition,
      amount: count * round.minimumBet,
    })).sort((left, right) => compareRouletteBetDefinitions(left.definition, right.definition));
    const totalStake = selectedDefinitions.length * round.minimumBet;
    const remainingFunds = Math.max(0, (viewer?.balance ?? 0) - totalStake);
    const canAddChip = !isRouletteBetLocked && !isRouletteBetSaving && remainingFunds >= round.minimumBet;
    const showExpectedValue = round.betComplexity === "advanced";
    const renderRouletteSectionHeader = (
      title: string,
      subtitle: string,
      sampleDefinition?: RouletteBetDefinition,
    ) => (
      <div className={styles.rouletteBoardHeader}>
        <div className={styles.rouletteBoardHeading}>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        {showExpectedValue && sampleDefinition ? (
          <span
            className={`${styles.infoChip} ${styles.rouletteEvChip}`}
            title="Expected value is the average return per $1 staked over many spins, including your original chip. Values below 1.00 mean the house edge is against the player."
          >
            EV {getRouletteBetExpectedValue(sampleDefinition, round.zeroes).toFixed(2)}
          </span>
        ) : null}
      </div>
    );

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <button
          aria-controls={accordionId}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => {
            const nextExpanded = resolvedExpandedRoundId === accordionId ? false : accordionId;
            setExpandedRoundState(() => ({
              scopeRoundId: activeRoundScopeId,
              value: nextExpanded,
            }));
          }}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Roulette Spin {activeRouletteRoundNumber}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            Wager: {formatMoney(totalStake)}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={accordionId}>
            {renderRouletteWheel(round.wheelPockets, null, false, 0)}

            <p className={styles.rules}>
              Each selected placement stakes one chip worth {formatMoney(round.minimumBet)}. {round.betComplexity === "simple" ? "Simple mode only offers red or black." : round.betComplexity === "intermediate" ? "Intermediate mode offers straight numbers plus red or black." : "Advanced mode unlocks the full table."}
            </p>

            {viewer ? (
              <div className={styles.actionPanel}>
              <div className={styles.rouletteSelectionSummary}>
                <strong>{selectedDefinitions.length} bets selected</strong>
                <span>
                  {isRouletteBetSaving
                    ? "Locked. Submitting bets..."
                    : isRouletteBetLocked || bettingCountdown <= 0
                      ? "Bets locked"
                      : `Total stake: ${formatMoney(totalStake)}`}
                </span>
              </div>

              {selectedDefinitions.length > 0 ? (
                <div className={styles.chipRow}>
                  {groupedSelectedBets.map(({ definition, amount }) => (
                    <button
                      className={`${styles.infoChip} ${styles.rouletteSelectedChip}`}
                      key={definition.key}
                      onClick={() => removeRouletteBetSelection(definition.key)}
                      type="button"
                    >
                      <strong>{definition.shortLabel}</strong>
                      <span>{formatMoney(amount)}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {round.betComplexity === "simple" ? (
                <div className={styles.rouletteBoardSection}>
                  {renderRouletteSectionHeader(
                    "Simple Bets",
                    "Pick red or black. Covers 18 numbers and pays 1:1.",
                    colorBets[0],
                  )}
                  <div className={styles.rouletteOptionGrid}>
                    {colorBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                  </div>
                </div>
              ) : round.betComplexity === "intermediate" ? (
                <>
                  <div className={styles.rouletteBoardSection}>
                    {renderRouletteSectionHeader(
                      "Color Bets",
                      "Pick red or black. Covers 18 numbers and pays 1:1.",
                      colorBets[0],
                    )}
                    <div className={styles.rouletteOptionGrid}>
                      {colorBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                    </div>
                  </div>

                  <div className={styles.rouletteBoardSection}>
                    {renderRouletteSectionHeader(
                      "Straight Up",
                      `Pick one exact pocket, including ${formatRouletteZeroes(round.zeroes)}. Covers 1 number and pays 35:1.`,
                      straightBets[0],
                    )}
                    <div className={styles.rouletteNumberGrid}>
                      {straightBets.map((definition) => {
                        const pocket = definition.pockets[0] ?? 0;
                        const color = getRoulettePocketColor(pocket);

                        return renderRouletteBetControl(
                          definition,
                          round.minimumBet,
                          canAddChip,
                          color === "green"
                            ? styles.rouletteZeroButton
                            : color === "red"
                              ? styles.rouletteNumberRed
                              : styles.rouletteNumberBlack,
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.rouletteBoardSection}>
                    {renderRouletteSectionHeader(
                      "Color Bets",
                      "Pick red or black. Covers 18 numbers and pays 1:1.",
                      colorBets[0],
                    )}
                    <div className={styles.rouletteOptionGrid}>
                      {colorBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                    </div>
                  </div>

                  <section className={styles.rouletteBoardSection}>
                    {renderRouletteSectionHeader(
                      "Outside Bets",
                      "Pick dozens, columns, odd or even, or low or high. Covers 12 or 18 numbers and pays 2:1 or 1:1.",
                      otherOutsideBets[0],
                    )}
                    <div className={styles.rouletteOptionGrid}>
                      {otherOutsideBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                    </div>
                  </section>

                  <div className={styles.rouletteBetGrid}>
                    <section className={styles.rouletteBoardSection}>
                      {renderRouletteSectionHeader(
                        "Six Lines",
                        "Pick two adjacent rows. Covers 6 numbers and pays 5:1.",
                        sixLineBets[0],
                      )}
                      <div className={styles.rouletteOptionGrid}>
                        {sixLineBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                      </div>
                    </section>

                    <section className={styles.rouletteBoardSection}>
                      {renderRouletteSectionHeader(
                        "Corners",
                        "Pick a four-number square. Covers 4 numbers and pays 8:1.",
                        cornerBets[0],
                      )}
                      <div className={styles.rouletteOptionGrid}>
                        {cornerBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                      </div>
                    </section>

                    <section className={styles.rouletteBoardSection}>
                      {renderRouletteSectionHeader(
                        "Streets",
                        "Pick one row across the table. Covers 3 numbers and pays 11:1.",
                        streetBets[0],
                      )}
                      <div className={styles.rouletteOptionGrid}>
                        {streetBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                      </div>
                    </section>

                    <section className={styles.rouletteBoardSection}>
                      {renderRouletteSectionHeader(
                        "Splits",
                        "Pick a line between two adjacent numbers. Covers 2 numbers and pays 17:1.",
                        splitBets[0],
                      )}
                      <div className={styles.rouletteOptionGrid}>
                        {splitBets.map((definition) => renderRouletteBetControl(definition, round.minimumBet, canAddChip))}
                      </div>
                    </section>
                  </div>

                  <div className={styles.rouletteBoardSection}>
                    {renderRouletteSectionHeader(
                      "Straight Up",
                      `Pick one exact pocket, including ${formatRouletteZeroes(round.zeroes)}. Covers 1 number and pays 35:1.`,
                      straightBets[0],
                    )}
                    <div className={styles.rouletteNumberGrid}>
                      {straightBets.map((definition) => {
                        const pocket = definition.pockets[0] ?? 0;
                        const color = getRoulettePocketColor(pocket);

                        return renderRouletteBetControl(
                          definition,
                          round.minimumBet,
                          canAddChip,
                          color === "green"
                            ? styles.rouletteZeroButton
                            : color === "red"
                              ? styles.rouletteNumberRed
                              : styles.rouletteNumberBlack,
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              <div className={styles.buttonRow}>
                <button
                  className={styles.secondaryButton}
                  disabled={selectedRouletteBetKeys.length === 0 || isRouletteBetLocked || isRouletteBetSaving}
                  onClick={() => saveRouletteBetSelection([])}
                  type="button"
                >
                  Clear Selection
                </button>
              </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  }

  function renderHistoricRouletteResults(round: CompletedRouletteRound, index: number) {
    const accordionId = `roulette-history:${round.id}`;
    const isExpanded = resolvedExpandedRoundId === accordionId;
    const resultListId = `roulette-history-results:${round.id}`;
    const isResultListExpanded = expandedResultLists.includes(resultListId);
    const sortedResults = [...round.results].sort(compareRouletteResults);
    const visibleResults = isResultListExpanded
      ? sortedResults
      : sortedResults.filter((result) => result.payout > result.totalBet);

    const renderRouletteResultRow = (result: RouletteResult, winningPocket: RoulettePocket | null) => {
      const groupedBets = sortGroupedRouletteBetEntries(groupRouletteBetsByKey(result.bets));
      const netReturn = result.payout - result.totalBet;

      return (
        <div
          className={`${styles.resultRow} ${isResultListExpanded && initialSessionId === result.sessionId ? styles.playerResult : ""}`}
          key={result.sessionId}
        >
          <div className={styles.resultTotals}>
            <strong>{formatNetMoney(netReturn)}</strong>
          </div>
          <div className={styles.resultIdentity}>
            <strong>{result.displayName}</strong>
            <div className={styles.resultChipRow}>
              {groupedBets.map((entry) => {
                const betNet = getRouletteGroupedBetNet(entry, winningPocket);

                return (
                  <span
                    className={styles.infoChip}
                    key={`${result.sessionId}-${entry.bet.betKey}`}
                  >
                    {entry.bet.label}: {formatNetMoney(betNet)}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      );
    };

    return (
      <article className={`${styles.card} ${styles.cardWide}`} key={round.id}>
        <button
          aria-controls={accordionId}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => {
            const nextExpanded = resolvedExpandedRoundId === accordionId ? false : accordionId;
            setExpandedRoundState((current) => ({
              scopeRoundId: current.scopeRoundId,
              value: nextExpanded,
            }));
          }}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Roulette Spin {previousRouletteRounds.length - index}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            Winner: {round.winningPocket !== null ? formatRoulettePocket(round.winningPocket) : "-"}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={accordionId}>
            <div className={styles.resultListSection}>
              <button
                className={styles.resultListToggle}
                onClick={() => setExpandedResultLists((current) => (
                  current.includes(resultListId)
                    ? current.filter((entry) => entry !== resultListId)
                    : [...current, resultListId]
                ))}
                type="button"
              >
                <strong>{isResultListExpanded ? "All Players" : "Winners"}</strong>
                <span>{isResultListExpanded ? "-" : "+"}</span>
              </button>

              {visibleResults.length > 0 ? (
                <div className={styles.rankingList}>
                  {visibleResults.map((result) => renderRouletteResultRow(result, round.winningPocket))}
                </div>
              ) : (
                <p className={styles.waitingState}>
                  {isResultListExpanded ? "No chips were placed before the spin." : "No player won money on this spin."}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  function renderRouletteResultsCard(round: RouletteRound) {
    const accordionId = `current:${round.id}`;
    const isExpanded = resolvedExpandedRoundId === accordionId;
    const resultListId = `roulette-current-results:${round.id}`;
    const isResultListExpanded = expandedResultLists.includes(resultListId);
    const roundDefinitions = getRouletteBetDefinitions(round.zeroes);
    const viewerSpinBets = initialSessionId
      ? round.bets.filter((bet) => bet.sessionId === initialSessionId)
      : [];
    const viewerDraftSpinBets =
      viewerSpinBets.length === 0 && rouletteBetSelectionDraft?.roundId === round.id
        ? rouletteBetSelectionDraft.keys.reduce<Map<string, { bet: RouletteBet; count: number }>>((current, key) => {
            const definition = roundDefinitions.find((entry) => entry.key === key);

            if (!definition) {
              return current;
            }

            const existing = current.get(definition.key);

            if (existing) {
              existing.count += 1;
              return current;
            }

            current.set(definition.key, {
              bet: {
                amount: round.minimumBet,
                betKey: definition.key,
                displayName: viewer?.displayName ?? "You",
                label: definition.label,
                payoutMultiplier: definition.payoutMultiplier,
                placedAt: round.startedAt,
                pockets: definition.pockets,
                sessionId: initialSessionId ?? "",
                type: definition.type,
              },
              count: 1,
            });

            return current;
          }, new Map())
        : new Map<string, { bet: RouletteBet; count: number }>();
    const groupedViewerSpinBets = viewerSpinBets.length > 0 ? groupRouletteBetsByKey(viewerSpinBets) : Array.from(viewerDraftSpinBets.values());
    const groupedViewerSpinBetEntries = sortGroupedRouletteBetEntries(groupedViewerSpinBets);
    const viewerSpinStake = groupedViewerSpinBetEntries.reduce((sum, entry) => sum + entry.amount, 0);
    const activeViewerReturn = activeRouletteResult
      ? formatNetRoundDelta(activeRouletteResult.payout, activeRouletteResult.totalBet)
      : formatMoney(0);
    const sortedResults = [...round.results].sort(compareRouletteResults);
    const visibleResults = isResultListExpanded
      ? sortedResults
      : sortedResults.filter((result) => result.payout > result.totalBet);
    const renderRouletteResultRow = (result: RouletteResult) => {
      const groupedBets = sortGroupedRouletteBetEntries(groupRouletteBetsByKey(result.bets));
      const netReturn = result.payout - result.totalBet;

      return (
        <div
          className={`${styles.resultRow} ${isResultListExpanded && initialSessionId === result.sessionId ? styles.playerResult : ""}`}
          key={result.sessionId}
        >
          <div className={styles.resultTotals}>
            <strong>{formatNetMoney(netReturn)}</strong>
          </div>
          <div className={styles.resultIdentity}>
            <strong>{result.displayName}</strong>
            <div className={styles.resultChipRow}>
              {groupedBets.map((entry) => {
                const betNet = getRouletteGroupedBetNet(entry, round.winningPocket);

                return (
                  <span
                    className={styles.infoChip}
                    key={`${result.sessionId}-${entry.bet.betKey}`}
                  >
                    {entry.bet.label}: {formatNetMoney(betNet)}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      );
    };

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <button
          aria-controls={accordionId}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => {
            const nextExpanded = resolvedExpandedRoundId === accordionId ? false : accordionId;
            setExpandedRoundState(() => ({
              scopeRoundId: activeRoundScopeId,
              value: nextExpanded,
            }));
          }}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Roulette Spin {activeRouletteRoundNumber}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            {rouletteWinnerVisible ? (
              <>
                Return: <span className={getSignedMoneyToneClass((activeRouletteResult?.payout ?? 0) - (activeRouletteResult?.totalBet ?? 0))}>{activeViewerReturn}</span>
              </>
            ) : (
              <>
                Wager: {formatMoney(viewerSpinStake)}
              </>
            )}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={accordionId}>
            {renderRouletteWheel(round.wheelPockets, round.winningPocket, rouletteWinnerVisible, rouletteSpinElapsedMs)}

            {viewer ? (
              groupedViewerSpinBetEntries.length > 0 ? (
                <div className={styles.chipRow}>
                  {groupedViewerSpinBetEntries.map(({ bet, amount }) => (
                    <span className={`${styles.infoChip} ${styles.rouletteSelectedChip}`} key={bet.betKey}>
                      <strong>{bet.label}</strong>
                      <span>
                        {rouletteWinnerVisible ? formatNetMoney(getRouletteGroupedBetNet({ bet, amount }, round.winningPocket)) : formatMoney(amount)}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className={styles.waitingState}>No locked bets found for you on this spin.</p>
              )
            ) : null}

            {!rouletteWinnerVisible ? (
              <div className={styles.resultsInterstitial}>
                <div className={styles.resultsPulse} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h3>Wheel spinning</h3>
                <p className={styles.waitingState}>The ball is still in motion. Results will lock in after the spin.</p>
              </div>
            ) : !rouletteResultsVisible ? (
              <div className={styles.resultsInterstitial}>
                <div className={styles.resultsPulse} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h3>Calculating winners</h3>
                <p className={styles.waitingState}>The wheel is settled. Ranking the table and totaling every wager now.</p>
              </div>
            ) : round.results.length > 0 ? (
              <>
                <div className={styles.resultListSection}>
                  <button
                    className={styles.resultListToggle}
                    onClick={() => setExpandedResultLists((current) => (
                      current.includes(resultListId)
                        ? current.filter((entry) => entry !== resultListId)
                        : [...current, resultListId]
                    ))}
                    type="button"
                  >
                    <strong>{isResultListExpanded ? "All Players" : "Winners"}</strong>
                    <span>{isResultListExpanded ? "-" : "+"}</span>
                  </button>

                  {visibleResults.length > 0 ? (
                    <div className={styles.rankingList}>
                      {visibleResults.map((result) => renderRouletteResultRow(result))}
                    </div>
                  ) : (
                    <p className={styles.waitingState}>
                      {isResultListExpanded ? "No chips were placed before the spin." : "No player won money on this spin."}
                    </p>
                  )}
                </div>
                {isHost ? (
                  <div className={styles.buttonRow}>
                    <button
                      className={styles.primaryButton}
                      disabled={busy !== "idle"}
                      onClick={handleFinishRound}
                      type="button"
                    >
                      {busy === "finish-round" ? "Returning..." : "Return to Setup"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className={styles.waitingState}>No chips were placed before the spin.</p>
            )}
          </div>
        ) : null}
      </article>
    );
  }

  function renderViewerResult(result: DiceResult | undefined) {
    if (!result) {
      return (
        <div className={styles.viewerResult}>
          <h3>You sat out this round</h3>
          <p className={styles.waitingState}>No bet was placed before the timer expired.</p>
        </div>
      );
    }

    return (
      <div className={styles.viewerResult}>
        <div className={styles.viewerResultHeader}>
          <h3>Your Wager</h3>
          <span className={styles.infoChip}>
            {resultsVisible ? (
              <>
                Return: <span className={getSignedMoneyToneClass(result.payout - result.bet)}>{formatNetRoundDelta(result.payout, result.bet)}</span>
              </>
            ) : (
              <>
                Wager: {formatMoney(result.bet)}
              </>
            )}
          </span>
        </div>
        {renderDiceResultStage(
          result.dice,
          result.sessionId,
          viewerScoreVisible ? result.score : "...",
          false,
          Math.max(0, Math.min(resultRevealStep - 1, 4)),
          rollingDieIndex,
        )}
        {resultRevealStep <= 1 ? <p className={styles.rollingHint}>Dice are rolling...</p> : null}
        {resultRevealStep > 1 && resultRevealStep < 5 ? (
          <p className={styles.rollingHint}>Rolling one die at a time...</p>
        ) : null}
        {resultRevealStep >= 5 && !resultsVisible ? (
          <p className={styles.rollingHint}>Your score is locked in. Waiting for the full table results.</p>
        ) : null}
      </div>
    );
  }

  function renderHistoricViewerResult(result: DiceResult | undefined) {
    if (!initialSessionId) {
      return null;
    }

    if (!result) {
      return (
        <div className={styles.viewerResult}>
          <h3>You sat out this round</h3>
          <p className={styles.waitingState}>No bet was placed before the timer expired.</p>
        </div>
      );
    }

    return (
      <div className={styles.viewerResult}>
        <div className={styles.viewerResultHeader}>
          <h3>Your Wager</h3>
          <span className={styles.infoChip}>Return: <span className={getSignedMoneyToneClass(result.payout - result.bet)}>{formatNetRoundDelta(result.payout, result.bet)}</span></span>
        </div>
        {renderDiceResultStage(result.dice, `${result.sessionId}-historic`, result.score)}
      </div>
    );
  }

  function renderDiceResultsCard(round: DiceRound) {
    const accordionId = `current:${round.id}`;
    const isExpanded = resolvedExpandedRoundId === accordionId;
    const resultListId = `results:${round.id}`;
    const isResultListExpanded = expandedResultLists.includes(resultListId);
    const visibleResults = isResultListExpanded
      ? round.results
      : round.results.filter((result) => result.payout > result.bet);

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <button
          aria-controls={accordionId}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => setExpandedRoundState((current) => {
            const resolvedCurrent =
              current.scopeRoundId !== activeRoundScopeId
                ? defaultExpandedRoundId
                : current.value === null
                  ? defaultExpandedRoundId
                  : current.value || null;
            return {
              scopeRoundId: activeRoundScopeId,
              value: resolvedCurrent === accordionId ? false : accordionId,
            };
          })}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Dice Round {currentDiceRoundNumber}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            Prize pool: {formatMoney(round.pot)}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={accordionId}>
            {renderViewerResult(viewerResult)}

            {!resultsVisible ? (
              <div className={styles.resultsInterstitial}>
                <div className={styles.resultsPulse} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h3>Calculating winners</h3>
                <p className={styles.waitingState}>
                  Totals are locked in. Ranking the table and splitting the pot now.
                </p>
              </div>
            ) : round.results.length > 0 ? (
              <>
                <div className={styles.resultListSection}>
                  <button
                    className={styles.resultListToggle}
                    onClick={() => setExpandedResultLists((current) => (
                      current.includes(resultListId)
                        ? current.filter((entry) => entry !== resultListId)
                        : [...current, resultListId]
                    ))}
                    type="button"
                  >
                    <strong>{isResultListExpanded ? "All Players" : "Winners"}</strong>
                    <span>{isResultListExpanded ? "-" : "+"}</span>
                  </button>

                  {visibleResults.length > 0 ? (
                    <div className={styles.rankingList}>
                      {visibleResults.map((result) => (
                        <div
                          className={`${styles.resultRow} ${isResultListExpanded && initialSessionId === result.sessionId ? styles.playerResult : ""} ${result.isCheater ? styles.resultCheater : ""}`}
                          key={result.sessionId}
                        >
                          <div className={styles.resultTotals}>
                            <strong>{resultsVisible ? result.score : "..."}</strong>
                            <span className={styles.balanceDelta}>
                              {formatNetRoundDelta(result.payout, result.bet)}
                            </span>
                          </div>
                          <div className={styles.resultIdentity}>
                            <strong>{result.displayName}</strong>
                            <div className={styles.resultMetaRow}>
                              {renderDiceFaces(
                                result.dice,
                                result.sessionId,
                                true,
                                Math.max(0, Math.min(resultRevealStep - 1, 4)),
                                rollingDieIndex,
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.waitingState}>No player finished above their wager.</p>
                  )}
                </div>

                {isHost ? (
                  <div className={styles.buttonRow}>
                    <button
                      className={styles.primaryButton}
                      disabled={busy !== "idle"}
                      onClick={handleFinishRound}
                      type="button"
                    >
                      {busy === "finish-round" ? "Returning..." : "Return to Setup"}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className={styles.waitingState}>No bets were placed, so this round had no entrants.</p>
            )}
          </div>
        ) : null}
      </article>
    );
  }

  function renderHistoricDiceResults(round: CompletedDiceRound, index: number) {
    const isExpanded = resolvedExpandedRoundId === round.id;
    const resultListId = `history-results:${round.id}`;
    const isResultListExpanded = expandedResultLists.includes(resultListId);
    const historicViewerResult = initialSessionId
      ? round.results.find((result) => result.sessionId === initialSessionId)
      : undefined;
    const visibleResults = isResultListExpanded
      ? round.results
      : round.results.filter((result) => result.payout > result.bet);

    return (
      <article className={`${styles.card} ${styles.cardWide}`} key={round.id}>
        <button
          aria-controls={`round-history-${round.id}`}
          aria-expanded={isExpanded}
          className={styles.historyToggle}
          onClick={() => {
            setExpandedRoundState((current) => {
              const resolvedCurrent =
                current.scopeRoundId !== activeRoundScopeId
                  ? defaultExpandedRoundId
                  : current.value === null
                    ? defaultExpandedRoundId
                    : current.value || null;

              return {
                scopeRoundId: activeRoundScopeId,
                value: resolvedCurrent === round.id ? false : round.id,
              };
            });
          }}
          type="button"
        >
          <span className={styles.historyToggleLabel}>
            <strong>Dice Round {previousDiceRounds.length - index}</strong>
          </span>
          <span className={`${styles.infoChip} ${styles.historyToggleChip} ${isExpanded ? styles.historyToggleChipActive : ""}`}>
            Prize pool: {formatMoney(round.pot)}
          </span>
        </button>

        {isExpanded ? (
          <div className={styles.historyBody} id={`round-history-${round.id}`}>
            {renderHistoricViewerResult(historicViewerResult)}

            <div className={styles.resultListSection}>
              <button
                className={styles.resultListToggle}
                onClick={() => setExpandedResultLists((current) => (
                  current.includes(resultListId)
                    ? current.filter((entry) => entry !== resultListId)
                    : [...current, resultListId]
                ))}
                type="button"
              >
                <strong>{isResultListExpanded ? "All Results" : "Winner(s)"}</strong>
                <span>{isResultListExpanded ? "Show winners" : "Show all"}</span>
              </button>

              {visibleResults.length > 0 ? (
                <div className={styles.rankingList}>
                  {visibleResults.map((result) => (
                    <div
                      className={`${styles.resultRow} ${isResultListExpanded && initialSessionId === result.sessionId ? styles.playerResult : ""} ${result.isCheater ? styles.resultCheater : ""}`}
                      key={result.sessionId}
                    >
                      <div className={styles.resultTotals}>
                        <strong>{result.score}</strong>
                        <span className={styles.balanceDelta}>
                          {formatNetRoundDelta(result.payout, result.bet)}
                        </span>
                      </div>
                      <div className={styles.resultIdentity}>
                        <strong>{result.displayName}</strong>
                        <div className={styles.resultMetaRow}>
                          {renderDiceFaces(result.dice, `${round.id}-${result.sessionId}`, true, 4)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.waitingState}>No player finished above their wager.</p>
              )}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <main className={styles.page}>
      <button
        aria-controls="lobby-sidebar"
        aria-expanded={sidebarOpen}
        className={`${styles.menuButton} ${sidebarOpen ? styles.menuButtonOpen : ""}`}
        onClick={() => setSidebarOpen((current) => !current)}
        type="button"
      >
        <span />
        <span />
        <span />
      </button>

      <section className={styles.header}>
        <div>
          <p className={styles.kicker}>Your Funds</p>
          <h1>{headlineFunds}</h1>
          <div className={styles.chipRow}>
            <span className={styles.infoChip}>
              Return: <span className={getSignedMoneyToneClass(playerReturn)}>{formatMoney(playerReturn)}</span>
            </span>
          </div>
        </div>
      </section>

      <div className={styles.shell}>
        <button
          aria-hidden={!sidebarOpen}
          className={`${styles.sidebarBackdrop} ${sidebarOpen ? styles.sidebarBackdropVisible : ""}`}
          onClick={() => setSidebarOpen(false)}
          tabIndex={sidebarOpen ? 0 : -1}
          type="button"
        />

        <aside
          className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}
          id="lobby-sidebar"
        >
          <div className={styles.sidebarInner}>
            <div className={styles.sidebarTop}>
              <div>
                <p className={styles.sidebarLabel}>All Players Return</p>
                <h2>{formatMoney(totalReturn)}</h2>
                {hasPlayedDiceRound || hasPlayedRouletteRound ? (
                  <div className={`${styles.chipRow} ${styles.sidebarSummaryChips}`}>
                    <span className={styles.infoChip}>ROI: <span className={getSignedMoneyToneClass(totalRoi)}>{formatRoi(totalRoi)}</span></span>
                    {hasPlayedDiceRound ? <span className={styles.infoChip}>Cheaters: <span className={getSignedMoneyToneClass(totalLostToCheating)}>{formatMoney(totalLostToCheating)}</span></span> : null}
                    {hasPlayedRouletteRound ? <span className={styles.infoChip}>House: <span className={getSignedMoneyToneClass(totalLostToHouseEdge)}>{formatMoney(totalLostToHouseEdge)}</span></span> : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className={styles.sidebarTabs}
              role="tablist"
              aria-label="Lobby sidebar sections"
            >
              <button
                aria-selected={sidebarTab === "players"}
                className={`${styles.sidebarTab} ${sidebarTab === "players" ? styles.sidebarTabActive : ""}`}
                onClick={() => setSidebarTab("players")}
                role="tab"
                type="button"
              >
                Players ({lobby.players.length})
              </button>
              <button
                aria-selected={sidebarTab === "share"}
                className={`${styles.sidebarTab} ${sidebarTab === "share" ? styles.sidebarTabActive : ""}`}
                onClick={() => setSidebarTab("share")}
                role="tab"
                type="button"
              >
                Share
              </button>
            </div>

            {sidebarTab === "players" ? (
              <div className={styles.sidebarPlayersSection}>
                <div className={styles.playerList}>
                  {displayedPlayers
                    .slice()
                    .sort((left, right) => right.balance - left.balance || left.displayName.localeCompare(right.displayName))
                    .map((player) => {
                      const playerReturnValue = player.balance - displayedAllocatedPerPlayer;

                      return (
                    <div className={styles.playerRow} key={player.sessionId}>
                      <div className={styles.playerFundsBlock}>
                        <span className={styles.playerFunds}>{formatMoney(player.balance)}</span>
                        <span className={`${styles.playerReturn} ${getSignedMoneyToneClass(playerReturnValue)}`}>
                          {formatNetMoney(playerReturnValue)}
                        </span>
                      </div>
                      <div className={styles.playerIdentity}>
                        <strong>{player.displayName}</strong>
                        <span>{player.isHost ? "Host" : "Player"}</span>
                      </div>
                      {initialSessionId === player.sessionId ? <mark>You</mark> : null}
                    </div>
                      );
                    })}
                </div>
              </div>
            ) : sidebarTab === "share" ? (
              <div className={styles.sidebarShareSection}>
                <div className={styles.shareCard}>
                  <span className={styles.shareLabel}>Lobby Code</span>
                  <strong className={styles.shareCode}>{lobby.code}</strong>
                </div>

                <button
                  aria-label="Expand lobby QR code"
                  className={styles.qrButton}
                  onClick={() => setQrExpanded(true)}
                  type="button"
                >
                  <div className={styles.qrBlock}>
                    <QRCodeSVG bgColor="transparent" fgColor="#1f1f1a" size={160} value={shareUrl} />
                  </div>
                </button>

                <div className={styles.shareCard}>
                  <span className={styles.shareLabel}>URL</span>
                  <a className={styles.shareLink} href={shareUrl} target="_blank" rel="noreferrer">
                    {shareUrl}
                  </a>
                </div>

                {viewer ? (
                  <div className={styles.sidebarShareActions}>
                    <button
                      className={styles.secondaryButton}
                      disabled={busy !== "idle"}
                      onClick={handleLeaveLobby}
                      type="button"
                    >
                      {busy === "leave" ? "Leaving..." : "Leave Lobby"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!realtimeEnabled ? (
              <div className={styles.sidebarFooter}>
                <p className={styles.notice}>
                  Live sync is disabled until the Pusher environment variables are configured.
                </p>
              </div>
            ) : null}
          </div>
        </aside>

        <section className={styles.mainColumn}>
          {renderRoundStageDisplay()}
          <section className={styles.grid}>
            {!viewer ? renderWaitingLobbyCard() : null}
            {lobby.status === "started" && !activeRound ? renderSettingsCard() : null}
            {activeRound?.game === "dice" && activeRound.phase === "betting"
              ? renderDiceBettingCard(activeRound)
              : null}
            {activeRound?.game === "dice" && activeRound.phase === "results"
              ? (
                  <>
                    {renderDiceResultsCard(activeRound)}
                    {previousDiceRounds.map((round, index) => renderHistoricDiceResults(round, index))}
                  </>
                )
              : null}
            {activeRound?.game === "roulette" && activeRound.phase === "betting"
              ? renderRouletteBettingCard(activeRound)
              : null}
            {activeRound?.game === "roulette" && activeRound.phase === "results"
              ? (
                  <>
                    {renderRouletteResultsCard(activeRound)}
                    {previousRouletteRounds.map((round, index) => renderHistoricRouletteResults(round, index))}
                  </>
                )
              : null}
          </section>
        </section>
      </div>

      {qrExpanded ? (
        <div className={styles.qrOverlay} onClick={() => setQrExpanded(false)} role="presentation">
          <button
            aria-label="Close expanded QR code"
            className={styles.qrOverlayClose}
            onClick={() => setQrExpanded(false)}
            type="button"
          >
            Close
          </button>
          <div
            className={styles.qrOverlayCard}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Lobby QR code"
          >
            <QRCodeSVG bgColor="transparent" fgColor="#1f1f1a" size={320} value={shareUrl} />
          </div>
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}
    </main>
  );
}

function getRoundStageSummary({
  activeRound,
  bettingCountdown,
  diceStageCountdown,
  initialSessionId,
  isHost,
  resultRevealStep,
  rouletteSpinCountdown,
  viewer,
  viewerHasBet,
  viewerHasRouletteBet,
}: {
  activeRound: LobbySummary["currentRound"];
  bettingCountdown: number;
  diceStageCountdown: number;
  initialSessionId?: string;
  isHost: boolean;
  resultRevealStep: number;
  rouletteSpinCountdown: number;
  viewer?: LobbySummary["players"][number];
  viewerHasBet: boolean;
  viewerHasRouletteBet: boolean;
}): RoundStageSummary | null {
  if (!viewer && !initialSessionId) {
    return null;
  }

  if (!activeRound) {
    return {
      activeStage: "setup",
      detail: isHost
        ? "Choose a game, tune the rules, and launch the next round."
        : "The host is setting the table for the next round.",
      title: "Round Setup",
    };
  }

  if (activeRound.game === "dice" && activeRound.phase === "betting") {
    return {
      activeStage: "bet",
      detail: viewerHasBet
        ? "You're locked in while the rest of the table decides whether to join."
        : "Betting is live now. Join before the timer closes.",
      timerLabel: `${bettingCountdown}s left`,
      title: "Betting Open",
    };
  }

  if (activeRound.game === "dice" && activeRound.phase === "results") {
    if (diceStageCountdown > 0) {
      return {
        activeStage: "roll",
        detail:
          resultRevealStep <= 1
            ? "Dice are tumbling now. The reveal starts in a beat."
            : resultRevealStep >= 5
              ? "The table is being ranked before the results board opens."
              : "Dice are being revealed one by one.",
        timerLabel: `${diceStageCountdown}s left`,
        title: "Rolling Dice",
      };
    }

    return {
      activeStage: "results",
      detail: isHost
        ? "Scores and payouts are on screen. Return to setup when you're ready for the next round."
        : "Scores and payouts are on screen while the host prepares the next round.",
      title: "Results Live",
    };
  }

  if (activeRound.game === "roulette" && activeRound.phase === "betting") {
    return {
      activeStage: "bet",
      detail: viewerHasRouletteBet
        ? "Your chips are on the table while the rest of the lobby finishes betting."
        : "Betting is open now. Build your roulette card before the spin starts.",
      timerLabel: `${bettingCountdown}s left`,
      title: "Betting Open",
    };
  }

  if (activeRound.game === "roulette" && activeRound.phase === "results") {
    if (rouletteSpinCountdown > 0) {
      return {
        activeStage: "roll",
        detail: "The wheel is spinning and the ball is still in motion.",
        timerLabel: `${rouletteSpinCountdown}s left`,
        title: "Wheel Spinning",
      };
    }

    return {
      activeStage: "results",
      detail: isHost
        ? `${activeRound.message} Return to setup when you're ready for the next round.`
        : activeRound.message,
      title: "Roulette Results",
    };
  }

  return {
    activeStage: "setup",
    detail: "The host is setting the table for the next round.",
    title: "Round Setup",
  };
}
