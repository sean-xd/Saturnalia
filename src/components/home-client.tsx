"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./home-client.module.css";

type LobbyResponse = {
  url: string;
};

async function getErrorMessage(response: Response) {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? "The request failed.";
}

export function HomeClient() {
  const router = useRouter();
  const [hostName, setHostName] = useState("Host");
  const [joinName, setJoinName] = useState("Player");
  const [joinCode, setJoinCode] = useState("");
  const [activeTab, setActiveTab] = useState<"create" | "join">("create");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "create" | "join">("idle");

  function handleCreateLobby(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("create");
        setError(null);

        const response = await fetch("/api/lobbies", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: hostName }),
        });

        if (!response.ok) {
          setError(await getErrorMessage(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyResponse;
        router.push(payload.url);
      })();
    });
  }

  function handleJoinLobby(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("join");
        setError(null);

        const response = await fetch("/api/lobbies/join-by-code", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code: joinCode,
            displayName: joinName,
          }),
        });

        if (!response.ok) {
          setError(await getErrorMessage(response));
          setBusy("idle");
          return;
        }

        const payload = (await response.json()) as LobbyResponse;
        router.push(payload.url);
      })();
    });
  }

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.kicker}>Saturnalia</p>
        <h1>Learn about gambling by gambling.</h1>
        <p className={styles.summary}>
          Using game simulations to understand risk and reward.
        </p>
        <div className={styles.badges}>
          <span>Probability</span>
          <span>Expected Value</span>
          <span>Manipulation</span>
        </div>
      </section>

      <section className={styles.panelGrid}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <p>{activeTab === "create" ? "Create Lobby" : "Join Lobby"}</p>
            <span>{activeTab === "create" ? "Host flow" : "Player flow"}</span>
          </div>
          <div className={styles.tabRow} role="tablist" aria-label="Lobby actions">
            <button
              aria-selected={activeTab === "create"}
              className={`${styles.tabButton} ${activeTab === "create" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("create")}
              role="tab"
              type="button"
            >
              Create
            </button>
            <button
              aria-selected={activeTab === "join"}
              className={`${styles.tabButton} ${activeTab === "join" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("join")}
              role="tab"
              type="button"
            >
              Join
            </button>
          </div>

          {activeTab === "create" ? (
            <form className={styles.form} onSubmit={handleCreateLobby}>
              <label className={styles.field}>
                <span>Host display name</span>
                <input
                  autoComplete="nickname"
                  enterKeyHint="go"
                  maxLength={24}
                  name="displayName"
                  onChange={(event) => setHostName(event.target.value)}
                  placeholder="Host"
                  value={hostName}
                />
              </label>
              <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
                {busy === "create" ? "Creating..." : "Create lobby"}
              </button>
            </form>
          ) : (
            <form className={styles.form} onSubmit={handleJoinLobby}>
              <label className={styles.field}>
                <span>Your name</span>
                <input
                  autoComplete="nickname"
                  enterKeyHint="next"
                  maxLength={24}
                  name="joinName"
                  onChange={(event) => setJoinName(event.target.value)}
                  placeholder="Player"
                  value={joinName}
                />
              </label>
              <label className={styles.field}>
                <span>Lobby code</span>
                <input
                  autoCapitalize="characters"
                  autoCorrect="off"
                  enterKeyHint="go"
                  inputMode="text"
                  maxLength={4}
                  name="code"
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  placeholder="ABCD"
                  value={joinCode}
                />
              </label>
              <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
                {busy === "join" ? "Joining..." : "Join by code"}
              </button>
            </form>
          )}
        </section>
      </section>

      {error ? <p className={styles.error}>{error}</p> : null}
    </main>
  );
}