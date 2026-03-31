import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { LobbyClient } from "@/components/lobby-client";
import { getConfiguredBaseUrl } from "@/lib/env";
import { LobbyError, getLobbySummaryById } from "@/lib/lobby";
import { isRealtimeEnabled } from "@/lib/realtime";
import { getSessionId } from "@/lib/session";

type LobbyPageProps = {
  params: Promise<{
    lobbyId: string;
  }>;
};

function buildOrigin(host: string | null, forwardedProto: string | null): string | undefined {
  if (!host) {
    return undefined;
  }

  const protocol = forwardedProto ?? (host.includes("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

export default async function LobbyPage({ params }: LobbyPageProps) {
  const { lobbyId } = await params;
  const [sessionId, headerStore] = await Promise.all([getSessionId(), headers()]);
  let lobby;

  try {
    lobby = await getLobbySummaryById(lobbyId);
  } catch (error) {
    if (error instanceof LobbyError && error.code === "LOBBY_NOT_FOUND") {
      notFound();
    }

    throw error;
  }

  const origin =
    getConfiguredBaseUrl() ??
    buildOrigin(
      headerStore.get("x-forwarded-host") ?? headerStore.get("host"),
      headerStore.get("x-forwarded-proto"),
    ) ??
    "http://localhost:3000";

  return (
    <LobbyClient
      initialLobby={lobby}
      initialServerTime={new Date().toISOString()}
      initialSessionId={sessionId}
      realtimeEnabled={isRealtimeEnabled()}
      shareUrl={`${origin}/lobby/${lobby.lobbyId}`}
    />
  );
}
