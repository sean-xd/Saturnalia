import Pusher from "pusher";

import type { LobbySnapshot } from "@/lib/lobby";
import { getPusherClientConfig, getPusherServerConfig, hasRealtimeConfig } from "@/lib/env";
import { LobbyError } from "@/lib/lobby";

let pusherServer: Pusher | undefined;

export function getLobbyChannelName(lobbyId: string): string {
  return `private-lobby-${lobbyId}`;
}

export function isRealtimeEnabled(): boolean {
  return hasRealtimeConfig();
}

export function getPusherClientRuntimeConfig() {
  return getPusherClientConfig();
}

function getPusherServer() {
  if (pusherServer) {
    return pusherServer;
  }

  const config = getPusherServerConfig();

  if (!config.appId || !config.key || !config.secret || !config.cluster) {
    throw new LobbyError(
      "CONFIGURATION_REQUIRED",
      "Pusher is not configured. Set the Pusher environment variables before using realtime features.",
      500,
    );
  }

  pusherServer = new Pusher({
    appId: config.appId,
    key: config.key,
    secret: config.secret,
    cluster: config.cluster,
    useTLS: true,
  });

  return pusherServer;
}

export async function publishLobbyUpdated(lobby: LobbySnapshot) {
  if (!isRealtimeEnabled()) {
    return;
  }

  await getPusherServer().trigger(getLobbyChannelName(lobby.lobbyId), "lobby.updated", {
    lobbyId: lobby.lobbyId,
    serverTime: new Date().toISOString(),
  });
}

export function authorizeLobbySubscription(socketId: string, channelName: string) {
  return getPusherServer().authorizeChannel(socketId, channelName);
}
