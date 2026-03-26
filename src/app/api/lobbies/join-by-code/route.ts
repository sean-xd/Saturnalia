import { getBaseUrlFromRequest } from "@/lib/env";
import { getLobbyByCode, joinLobby, lobbyErrorToResponse } from "@/lib/lobby";
import { publishLobbyUpdated } from "@/lib/realtime";
import { ensureSessionId } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const sessionId = await ensureSessionId();
    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      displayName?: string;
    };

    const lobby = await getLobbyByCode(body.code ?? "");
    const updatedLobby = await joinLobby(lobby.lobbyId, sessionId, body.displayName);

    await publishLobbyUpdated(updatedLobby);

    return Response.json({
      lobbyId: updatedLobby.lobbyId,
      code: updatedLobby.code,
      url: `${getBaseUrlFromRequest(request)}/lobby/${updatedLobby.lobbyId}`,
    });
  } catch (error) {
    return lobbyErrorToResponse(error);
  }
}