import { getLobbyById, lobbyErrorToResponse, syncLobbyRoundState } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";

type RouteContext = {
  params: Promise<{
    lobbyId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const result = await syncLobbyRoundState(lobbyId);

    if (result.changed) {
      await publishLobbyUpdated(result.lobby);
      return Response.json({ lobby: result.lobby, serverTime: new Date().toISOString(), synchronized: true });
    }

    const lobby = await getLobbyById(lobbyId);
    return Response.json({ lobby, serverTime: new Date().toISOString(), synchronized: false });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
