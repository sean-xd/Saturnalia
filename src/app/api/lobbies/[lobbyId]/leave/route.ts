import { leaveLobby, lobbyErrorToResponse, summarizeLobby } from "@/lib/lobby";
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
    const result = await leaveLobby(lobbyId, sessionId);

    if (result.deleted) {
      return Response.json({
        deleted: true,
        redirectUrl: "/",
      });
    }

    await publishLobbyUpdated(result.lobby);

    return Response.json({
      deleted: false,
      lobby: summarizeLobby(result.lobby),
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
