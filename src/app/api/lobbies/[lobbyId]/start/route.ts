import { lobbyErrorToResponse, startLobby, summarizeLobby } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";

type RouteContext = {
  params: Promise<{
    lobbyId: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const sessionId = await ensureSessionId();
    const lobby = await startLobby(lobbyId, sessionId);

    await publishLobbyUpdated(lobby);

    return Response.json({ lobby: summarizeLobby(lobby), serverTime: new Date().toISOString() });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
