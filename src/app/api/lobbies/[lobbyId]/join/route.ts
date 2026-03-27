import { joinLobby, lobbyErrorToResponse } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";

type RouteContext = {
  params: Promise<{
    lobbyId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { lobbyId } = await context.params;
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as { displayName?: string };
    const lobby = await joinLobby(lobbyId, sessionId, body.displayName);

    await publishLobbyUpdated(lobby);

    return Response.json({ lobby, serverTime: new Date().toISOString() });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}
