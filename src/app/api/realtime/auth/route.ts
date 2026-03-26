import { findLobbyPlayer, getLobbyById, lobbyErrorToResponse } from "@/lib/lobby";
import { authorizeLobbySubscription, getLobbyChannelName } from "@/lib/realtime";
import { getSessionId } from "@/lib/session";

function getLobbyIdFromChannel(channelName: string): string | undefined {
	const prefix = "private-lobby-";

	if (!channelName.startsWith(prefix)) {
		return undefined;
	}

	return channelName.slice(prefix.length);
}

export async function POST(request: Request) {
	try {
		const sessionId = await getSessionId();

		if (!sessionId) {
			return Response.json(
				{
					error: "UNAUTHORIZED",
					message: "Join the lobby before opening a realtime subscription.",
				},
				{ status: 401 },
			);
		}

		const formData = await request.formData();
		const socketId = formData.get("socket_id");
		const channelName = formData.get("channel_name");

		if (typeof socketId !== "string" || typeof channelName !== "string") {
			return Response.json(
				{
					error: "INVALID_REQUEST",
					message: "Pusher auth requires socket_id and channel_name.",
				},
				{ status: 400 },
			);
		}

		const lobbyId = getLobbyIdFromChannel(channelName);

		if (!lobbyId || channelName !== getLobbyChannelName(lobbyId)) {
			return Response.json(
				{
					error: "INVALID_CHANNEL",
					message: "The requested realtime channel is invalid.",
				},
				{ status: 400 },
			);
		}

		const lobby = await getLobbyById(lobbyId);
		const member = findLobbyPlayer(lobby, sessionId);

		if (!member && lobby.hostSessionId !== sessionId) {
			return Response.json(
				{
					error: "FORBIDDEN",
					message: "Only lobby members can subscribe to lobby updates.",
				},
				{ status: 403 },
			);
		}

		return Response.json(authorizeLobbySubscription(socketId, channelName));
	} catch (error) {
		return lobbyErrorToResponse(error);
	}
}