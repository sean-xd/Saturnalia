"use client";

import { startTransition, useEffect, useState } from "react";

import { useRouter } from "next/navigation";
import Pusher from "pusher-js";
import { QRCodeSVG } from "qrcode.react";

import styles from "./lobby-client.module.css";

import type { LobbySnapshot } from "@/lib/lobby";

type LobbyClientProps = {
  initialLobby: LobbySnapshot;
  initialSessionId?: string;
  shareUrl: string;
  realtimeEnabled: boolean;
};

type LobbyPayload = {
  lobby: LobbySnapshot;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? "The request failed.";
}

export function LobbyClient({
  initialLobby,
  initialSessionId,
  shareUrl,
  realtimeEnabled,
}: LobbyClientProps) {
  const router = useRouter();
  const [lobby, setLobby] = useState(initialLobby);
  const [joinName, setJoinName] = useState("Player");
  const [busy, setBusy] = useState<"idle" | "join" | "leave" | "start">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"primary" | "share">("primary");
  const viewer = initialSessionId
    ? lobby.players.find((player) => player.sessionId === initialSessionId)
    : undefined;
  const isHost = Boolean(initialSessionId && lobby.hostSessionId === initialSessionId);
  const canShare = lobby.status === "waiting";
  const resolvedTab = canShare ? activeTab : "primary";
  const primaryTabLabel = viewer ? "Session" : "Join";

  useEffect(() => {
    if (!realtimeEnabled || !initialSessionId) {
      return undefined;
    }

    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

    if (!pusherKey || !pusherCluster) {
      return undefined;
    }

    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
      authEndpoint: "/api/realtime/auth",
    });

    const channel = pusher.subscribe(`private-lobby-${lobby.lobbyId}`);
    const handleUpdate = (payload: LobbyPayload) => {
      setLobby(payload.lobby);
    };

    channel.bind("lobby.updated", handleUpdate);

    return () => {
      channel.unbind("lobby.updated", handleUpdate);
      pusher.unsubscribe(`private-lobby-${lobby.lobbyId}`);
      pusher.disconnect();
    };
  }, [initialSessionId, lobby.lobbyId, realtimeEnabled]);

  useEffect(() => {
    if (!sidebarOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sidebarOpen]);

  function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("join");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/join`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: joinName }),
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        setLobby(payload.lobby);
        router.refresh();
        setBusy("idle");
      })();
    });
  }

  function handleLeave() {
    startTransition(() => {
      void (async () => {
        setBusy("leave");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/leave`, {
          method: "POST",
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as
          | { deleted: true; redirectUrl: string }
          | { deleted: false; lobby: LobbySnapshot };

        if (payload.deleted) {
          router.push(payload.redirectUrl);
          return;
        }

        setLobby(payload.lobby);
        router.refresh();
        setBusy("idle");
      })();
    });
  }

  function handleStart() {
    startTransition(() => {
      void (async () => {
        setBusy("start");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/start`, {
          method: "POST",
        });

        if (!response.ok) {
          setError(await readError(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyPayload;
        setLobby(payload.lobby);
        setBusy("idle");
      })();
    });
  }

  return (
    <main className={styles.page}>
      <section className={styles.header}>
        <div>
          <p className={styles.kicker}>Canonical Lobby</p>
          <h1>{lobby.code}</h1>
          <p className={styles.subtitle}>
            {lobby.players.length} player{lobby.players.length === 1 ? "" : "s"} connected.
            {" "}
            {lobby.status === "started" ? "Lobby started." : "Waiting for the host to begin."}
          </p>
        </div>

        <button
          aria-controls="lobby-sidebar"
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          className={`${styles.menuButton} ${sidebarOpen ? styles.menuButtonOpen : ""}`}
          onClick={() => setSidebarOpen((current) => !current)}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
      </section>

      <div className={styles.shell}>
        <button
          aria-hidden={!sidebarOpen}
          className={`${styles.sidebarBackdrop} ${sidebarOpen ? styles.sidebarBackdropVisible : ""}`}
          onClick={() => setSidebarOpen(false)}
          tabIndex={sidebarOpen ? 0 : -1}
          type="button"
        />

        <aside
          className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}
          id="lobby-sidebar"
        >
          <div className={styles.sidebarInner}>
            <div className={styles.sidebarTop}>
              <div>
                <p className={styles.sidebarLabel}>Players</p>
                <h2>{lobby.code}</h2>
              </div>
              <button
                aria-label="Close sidebar"
                className={styles.closeButton}
                onClick={() => setSidebarOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className={styles.sidebarStatusRow}>
              <span className={styles.statusBadge}>{lobby.status}</span>
              <span className={styles.statusMeta}>
                {lobby.players.length} player{lobby.players.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className={styles.playerList}>
              {lobby.players.map((player) => (
                <div className={styles.playerRow} key={player.sessionId}>
                  <div>
                    <strong>{player.displayName}</strong>
                    <span>{player.isHost ? "Host" : "Player"}</span>
                  </div>
                  {initialSessionId === player.sessionId ? <mark>You</mark> : null}
                </div>
              ))}
            </div>

            {!realtimeEnabled ? (
              <p className={styles.notice}>
                Live sync is disabled until the Pusher environment variables are configured.
              </p>
            ) : null}
          </div>
        </aside>

        <section className={styles.mainColumn}>
          <section className={styles.grid}>
            {viewer || canShare ? (
              <article className={styles.card}>
                {canShare ? (
                  <div className={styles.tabRow} role="tablist" aria-label="Lobby panels">
                    <button
                      aria-selected={resolvedTab === "primary"}
                      className={`${styles.tabButton} ${resolvedTab === "primary" ? styles.tabButtonActive : ""}`}
                      onClick={() => setActiveTab("primary")}
                      role="tab"
                      type="button"
                    >
                      {primaryTabLabel}
                    </button>
                    <button
                      aria-selected={resolvedTab === "share"}
                      className={`${styles.tabButton} ${resolvedTab === "share" ? styles.tabButtonActive : ""}`}
                      onClick={() => setActiveTab("share")}
                      role="tab"
                      type="button"
                    >
                      Share
                    </button>
                  </div>
                ) : null}

                {(resolvedTab === "primary") && viewer ? (
                  <>
                    <div className={styles.cardHeader}>
                      <p>Your Session</p>
                      <span>{isHost ? "Host controls" : "Participant"}</span>
                    </div>
                    <div className={styles.sessionBlock}>
                      <strong>{viewer.displayName}</strong>
                      <p>
                        Refresh keeps you attached to this participant because the lobby stores your
                        anonymous session in a cookie.
                      </p>
                    </div>

                    <div className={styles.buttonRow}>
                      {isHost && lobby.status === "waiting" ? (
                        <button
                          className={styles.primaryButton}
                          disabled={busy !== "idle"}
                          onClick={handleStart}
                          type="button"
                        >
                          {busy === "start" ? "Starting..." : "Start lobby"}
                        </button>
                      ) : null}

                      <button
                        className={styles.secondaryButton}
                        disabled={busy !== "idle"}
                        onClick={handleLeave}
                        type="button"
                      >
                        {busy === "leave" ? "Leaving..." : "Leave lobby"}
                      </button>
                    </div>
                  </>
                ) : null}

                {resolvedTab === "primary" && !viewer && canShare ? (
                  <>
                    <div className={styles.cardHeader}>
                      <p>Join This Lobby</p>
                      <span>Anonymous session</span>
                    </div>
                    <form className={styles.form} onSubmit={handleJoin}>
                      <label className={styles.field}>
                        <span>Display name</span>
                        <input
                          autoComplete="nickname"
                          enterKeyHint="go"
                          maxLength={24}
                          onChange={(event) => setJoinName(event.target.value)}
                          placeholder="Player"
                          value={joinName}
                        />
                      </label>
                      <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
                        {busy === "join" ? "Joining..." : "Join lobby"}
                      </button>
                    </form>
                  </>
                ) : null}

                {resolvedTab === "share" ? (
                  <>
                    <div className={styles.cardHeader}>
                      <p>Join Info</p>
                      <span>Scan or share</span>
                    </div>
                    <div className={styles.qrBlock}>
                      <QRCodeSVG bgColor="transparent" fgColor="#1f1f1a" size={160} value={shareUrl} />
                      <p>{shareUrl}</p>
                    </div>
                  </>
                ) : null}
              </article>
            ) : null}

            {lobby.status === "started" ? (
              <article className={styles.card}>
                <div className={styles.cardHeader}>
                  <p>Start Placeholder</p>
                  <span>Game flow deferred</span>
                </div>
                <p className={styles.startedState}>
                  The host has started the lobby. This phase stops here on purpose, so no additional
                  gameplay screens or round logic are wired yet.
                </p>
              </article>
            ) : null}
          </section>
        </section>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
    </main>
  );
}