import { lobbyErrorToResponse, placeRoundBet, summarizeLobby, syncLobbyRoundState } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";

type RouteContext = {
  params: Promise<{
    lobbyId: string;
  }>;
};

type BetRoundBody = {
  game?: "dice" | "roulette";
  placementKeys?: string[];
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as BetRoundBody;
    const isRouletteBet = body.game === "roulette";

    if (!isRouletteBet) {
      const synchronized = await syncLobbyRoundState(lobbyId);

      if (synchronized.changed) {
        await publishLobbyUpdated(synchronized.lobby);
      }
    }

    const lobby = await placeRoundBet(
      lobbyId,
      sessionId,
      isRouletteBet
        ? {
            game: "roulette",
            placementKeys: body.placementKeys ?? [],
          }
        : { game: "dice" },
    );
    await publishLobbyUpdated(lobby);

    return Response.json({ lobby: summarizeLobby(lobby), serverTime: new Date().toISOString() });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
