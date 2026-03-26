import { createLobby, lobbyErrorToResponse } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";
import { getBaseUrlFromRequest } from "@/lib/env";

export async function POST(request: Request) {
  try {
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as { displayName?: string };
    const lobby = await createLobby(sessionId, body.displayName);

    await publishLobbyUpdated(lobby);

    return Response.json({
      lobbyId: lobby.lobbyId,
      code: lobby.code,
      url: `${getBaseUrlFromRequest(request)}/lobby/${lobby.lobbyId}`,
    });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}