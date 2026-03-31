import type { LobbySnapshot } from "@/lib/lobby";
import { getLobbyById, joinLobby, lobbyErrorToResponse, placeRoundBet, simulateLobbyRounds, startGameRound, summarizeLobby } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";

type RouteContext = {
  params: Promise<{
    lobbyId: string;
  }>;
};

type StartRoundBody = {
  game?: "dice" | "roulette";
  addMoney?: number;
  minimumBet?: number;
  cheatersPercent?: number;
  edgePercent?: number;
  zeroes?: number;
  betComplexity?: "simple" | "intermediate" | "advanced";
  simulateRounds?: number;
};

const DEVELOPMENT_SIMULATION_TARGET_PLAYERS = 30;
const DEVELOPMENT_SIMULATION_ROUND_COUNT = 10;
const DEVELOPMENT_SIMULATION_PREFIX = "sim:";

type StartRoundConfig = {
  game: "dice" | "roulette";
  addMoney: number;
  minimumBet: number;
  cheatersPercent: number;
  edgePercent: number;
  zeroes: number;
  betComplexity: "simple" | "intermediate" | "advanced";
};

function isDevelopmentSimulationEnabled() {
  return process.env.NODE_ENV !== "production";
}

function getSimulationSessionId(lobbyId: string, index: number) {
  return `${DEVELOPMENT_SIMULATION_PREFIX}${lobbyId}:${index}`;
}

function isSimulatedSession(sessionId: string) {
  return sessionId.startsWith(DEVELOPMENT_SIMULATION_PREFIX);
}

async function ensureDevelopmentSimulatedPlayers(lobbyId: string, hostSessionId: string, allowWithRealPlayers = false) {
  if (!allowWithRealPlayers && !isDevelopmentSimulationEnabled()) {
    return getLobbyById(lobbyId);
  }

  let lobby = await getLobbyById(lobbyId);
  const nonSimulatedNonHostPlayers = lobby.players.filter((player) => player.sessionId !== hostSessionId && !isSimulatedSession(player.sessionId));

  if (nonSimulatedNonHostPlayers.length > 0) {
    return lobby;
  }

  const existingSimulatedCount = lobby.players.filter((player) => isSimulatedSession(player.sessionId)).length;
  const missingSimulatedCount = Math.max(0, DEVELOPMENT_SIMULATION_TARGET_PLAYERS - lobby.players.length);

  for (let index = existingSimulatedCount; index < existingSimulatedCount + missingSimulatedCount; index += 1) {
    lobby = await joinLobby(lobbyId, getSimulationSessionId(lobbyId, index), `Sim ${String(index + 1).padStart(2, "0")}`);
  }

  return lobby;
}

async function simulateDevelopmentRoundTraffic(lobbyId: string, game: "dice" | "roulette") {
  if (!isDevelopmentSimulationEnabled()) {
    return getLobbyById(lobbyId);
  }

  let lobby = await getLobbyById(lobbyId);
  const simulatedPlayers = lobby.players.filter((player) => isSimulatedSession(player.sessionId));

  for (const player of simulatedPlayers) {
    if (!lobby.currentRound || lobby.currentRound.phase !== "betting") {
      break;
    }

    if (game === "dice") {
      lobby = await placeRoundBet(lobbyId, player.sessionId, { game: "dice" });
      continue;
    }

    const currentPlayer = lobby.players.find((entry) => entry.sessionId === player.sessionId);
    const currentRound = lobby.currentRound;

    if (!currentPlayer || currentRound.game !== "roulette") {
      continue;
    }

    const targetStake = Math.floor(currentPlayer.balance / 2 / Math.max(1, currentRound.minimumBet)) * currentRound.minimumBet;

    if (targetStake < currentRound.minimumBet) {
      continue;
    }

    const chipCount = Math.floor(targetStake / currentRound.minimumBet);
    const colorKey = Math.random() < 0.5 ? "color:red" : "color:black";

    lobby = await placeRoundBet(lobbyId, player.sessionId, {
      game: "roulette",
      placementKeys: Array.from({ length: chipCount }, () => colorKey),
    });
  }

  return lobby;
}

function normalizeStartRoundConfig(body: StartRoundBody): StartRoundConfig {
  const game = body.game ?? "dice";

  return {
    game,
    addMoney: body.addMoney ?? 0,
    minimumBet: body.minimumBet ?? 0,
    cheatersPercent: body.cheatersPercent ?? 0,
    edgePercent: body.edgePercent ?? 0,
    zeroes: body.zeroes ?? 1,
    betComplexity: body.betComplexity ?? "simple",
  };
}

function canRunDevelopmentSimulationLobby(lobby: LobbySnapshot, hostSessionId: string) {
  return lobby.players.every((player) => player.sessionId === hostSessionId || isSimulatedSession(player.sessionId));
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as StartRoundBody;
    const config = normalizeStartRoundConfig(body);
    const game = config.game;
    const requestedSimulationRounds = Math.max(1, Math.min(DEVELOPMENT_SIMULATION_ROUND_COUNT, Math.floor(body.simulateRounds ?? 1)));
    const currentLobby = await getLobbyById(lobbyId);
    const shouldPrepareSimulation =
      isDevelopmentSimulationEnabled() &&
      currentLobby.hostSessionId === sessionId &&
      currentLobby.status === "started" &&
      currentLobby.currentRound === null;
    const preppedLobby = shouldPrepareSimulation
      ? await ensureDevelopmentSimulatedPlayers(lobbyId, sessionId)
      : currentLobby;
    const shouldSimulateRoundTraffic =
      preppedLobby.players.some((player) => isSimulatedSession(player.sessionId)) &&
      canRunDevelopmentSimulationLobby(preppedLobby, sessionId);

    if (requestedSimulationRounds > 1) {
      if (currentLobby.hostSessionId !== sessionId || currentLobby.status !== "started" || currentLobby.currentRound !== null) {
        return Response.json(
          {
            error: "SIMULATION_NOT_AVAILABLE",
            message: "Ten-round simulation requires a started lobby with no active round, and only the host can run it.",
          },
          { status: 409 },
        );
      }

      const simulationLobby = await ensureDevelopmentSimulatedPlayers(lobbyId, sessionId, true);
      const result = await simulateLobbyRounds(simulationLobby.lobbyId, sessionId, config, requestedSimulationRounds, DEVELOPMENT_SIMULATION_TARGET_PLAYERS);
      await publishLobbyUpdated(result.lobby);
      return Response.json({
        lobby: summarizeLobby(result.lobby),
        completedRounds: result.completedRounds,
        serverTime: new Date().toISOString(),
      });
    }

    const startedLobby = await startGameRound(
      lobbyId,
      sessionId,
      game === "dice"
        ? {
            game,
            addMoney: config.addMoney,
            minimumBet: config.minimumBet,
            cheatersPercent: config.cheatersPercent,
            edgePercent: config.edgePercent,
          }
        : {
            game,
            addMoney: config.addMoney,
            minimumBet: config.minimumBet,
            zeroes: config.zeroes,
            betComplexity: config.betComplexity,
          },
    );
    const lobby = shouldSimulateRoundTraffic
      ? await simulateDevelopmentRoundTraffic(lobbyId, game)
      : startedLobby;

    await publishLobbyUpdated(lobby);

    return Response.json({ lobby: summarizeLobby(lobby), serverTime: new Date().toISOString() });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
