import { lobbyErrorToResponse, startGameRound } from "@/lib/lobby";
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
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as StartRoundBody;
    const lobby = await startGameRound(lobbyId, sessionId, {
      game: body.game ?? "dice",
      addMoney: body.addMoney ?? 0,
      minimumBet: body.minimumBet ?? 0,
      cheatersPercent: body.cheatersPercent ?? 0,
      edgePercent: body.edgePercent ?? 0,
    });

    await publishLobbyUpdated(lobby);

    return Response.json({ lobby, serverTime: new Date().toISOString() });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
