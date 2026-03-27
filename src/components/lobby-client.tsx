"use client";

import { startTransition, useEffect, useState } from "react";

import { useRouter } from "next/navigation";
import Pusher from "pusher-js";
import { QRCodeSVG } from "qrcode.react";

import styles from "./lobby-client.module.css";

import type { DiceResult, DiceRound, GameType, LobbySnapshot, RouletteRound } from "@/lib/lobby";

type LobbyClientProps = {
  initialLobby: LobbySnapshot;
  initialSessionId?: string;
  shareUrl: string;
  realtimeEnabled: boolean;
};

type LobbyPayload = {
  lobby: LobbySnapshot;
};

type RoundStageId = "setup" | "bet" | "roll" | "results";

type RoundStageSummary = {
  activeStage: RoundStageId;
  detail: string;
  timerLabel?: string;
  title: string;
};

type RoundSettingsState = Record<
  GameType,
  {
    addMoney: string;
    minimumBet: string;
    cheatersPercent: string;
    edgePercent: string;
  }
>;

const DICE_STAGE_DURATION_MS = 15_000;
const DICE_REVEAL_MILESTONES_MS = [900, 2_800, 4_900, 7_000, 9_200];

const currencyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
  maximumFractionDigits: 2,
});

const diceFaces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const roundStages: Array<{ id: RoundStageId; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "bet", label: "Bet" },
  { id: "roll", label: "Roll" },
  { id: "results", label: "Results" },
];

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ?? "The request failed.";
}

function formatMoney(value: number) {
  return currencyFormatter.format(value);
}

function secondsRemaining(target: string, now: number) {
  return Math.max(0, Math.ceil((new Date(target).getTime() - now) / 1000));
}

function secondsRemainingAt(targetTime: number, now: number) {
  return Math.max(0, Math.ceil((targetTime - now) / 1000));
}

function renderDie(value: number) {
  return diceFaces[value] ?? String(value);
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
  const [busy, setBusy] = useState<"idle" | "join" | "leave" | "start" | "start-round" | "bet">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"primary" | "share">("primary");
  const [gameTab, setGameTab] = useState<GameType>("dice");
  const [settings, setSettings] = useState<RoundSettingsState>({
    dice: {
      addMoney: "100",
      minimumBet: "25",
      cheatersPercent: "0",
      edgePercent: "0",
    },
    roulette: {
      addMoney: "100",
      minimumBet: "25",
      cheatersPercent: "0",
      edgePercent: "0",
    },
  });
  const [now, setNow] = useState(() => Date.now());
  const viewer = initialSessionId
    ? lobby.players.find((player) => player.sessionId === initialSessionId)
    : undefined;
  const isHost = Boolean(initialSessionId && lobby.hostSessionId === initialSessionId);
  const canShare = lobby.status === "waiting";
  const resolvedTab = canShare ? activeTab : "primary";
  const primaryTabLabel = viewer ? "Session" : "Join";
  const activeRound = lobby.currentRound;
  const totalMoney = lobby.players.reduce((total, player) => total + player.balance, 0);
  const bettingCountdown =
    activeRound?.game === "dice" && activeRound.phase === "betting"
      ? secondsRemaining(activeRound.bettingEndsAt, now)
      : 0;
  const resultsCountdown =
    activeRound?.game === "dice" && activeRound.phase === "results" && activeRound.resultsEndsAt
      ? secondsRemaining(activeRound.resultsEndsAt, now)
      : activeRound?.game === "roulette"
        ? secondsRemaining(activeRound.resultsEndsAt, now)
        : 0;
  const viewerHasBet =
    activeRound?.game === "dice" && activeRound.phase === "betting" && initialSessionId
      ? activeRound.bets.some((bet) => bet.sessionId === initialSessionId)
      : false;
  const viewerResult =
    activeRound?.game === "dice" && activeRound.phase === "results" && initialSessionId
      ? activeRound.results.find((result) => result.sessionId === initialSessionId)
      : undefined;
  const diceStageEndsAt =
    activeRound?.game === "dice" && activeRound.phase === "results"
      ? new Date(activeRound.bettingEndsAt).getTime() + DICE_STAGE_DURATION_MS
      : null;
  const diceStageCountdown = diceStageEndsAt ? secondsRemainingAt(diceStageEndsAt, now) : 0;
  const resultRevealStep =
    activeRound?.game === "dice" && activeRound.phase === "results"
      ? DICE_REVEAL_MILESTONES_MS.reduce(
          (step, milestone, index) =>
            now >= new Date(activeRound.bettingEndsAt).getTime() + milestone ? index + 1 : step,
          0,
        )
      : 5;
  const resultsVisible =
    activeRound?.game === "dice" && activeRound.phase === "results" ? diceStageCountdown === 0 : false;
  const roundStageSummary = getRoundStageSummary({
    activeRound,
    bettingCountdown,
    diceStageCountdown,
    initialSessionId,
    isHost,
    resultsCountdown,
    resultRevealStep,
    viewer,
    viewerHasBet,
  });

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

  useEffect(() => {
    if (lobby.status !== "started") {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [lobby.status]);

  useEffect(() => {
    if (!activeRound) {
      return undefined;
    }

    let cancelled = false;

    const syncLobby = async () => {
      const response = await fetch(`/api/lobbies/${lobby.lobbyId}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as LobbyPayload;

      if (!cancelled) {
        setLobby(payload.lobby);
      }
    };

    void syncLobby();

    const intervalId = window.setInterval(() => {
      void syncLobby();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRound, lobby.lobbyId]);

  function updateSettings(
    game: GameType,
    field: "addMoney" | "minimumBet" | "cheatersPercent" | "edgePercent",
    value: string,
  ) {
    setSettings((current) => ({
      ...current,
      [game]: {
        ...current[game],
        [field]: value,
      },
    }));
  }

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

  function handleStartRound(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(() => {
      void (async () => {
        setBusy("start-round");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            game: gameTab,
            addMoney: Number(settings[gameTab].addMoney),
            minimumBet: Number(settings[gameTab].minimumBet),
            cheatersPercent: Number(settings[gameTab].cheatersPercent),
            edgePercent: Number(settings[gameTab].edgePercent),
          }),
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

  function handlePlaceBet() {
    startTransition(() => {
      void (async () => {
        setBusy("bet");
        setError(null);

        const response = await fetch(`/api/lobbies/${lobby.lobbyId}/rounds/bet`, {
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

  function renderDiceFaces(dice: number[], keyPrefix: string, compact = false, revealCount = 4) {
    return (
      <div className={compact ? styles.diceStrip : styles.diceGrid}>
        {dice.map((die, index) => (
          <div
            className={`${compact ? styles.dieFaceSmall : styles.dieFace} ${index >= revealCount ? styles.dieFaceHidden : ""}`}
            key={`${keyPrefix}-${die}-${index}`}
            style={{ animationDelay: `${index * 140}ms` }}
          >
            {index < revealCount ? renderDie(die) : "?"}
          </div>
        ))}
      </div>
    );
  }

  function renderRoundStageDisplay() {
    if (!roundStageSummary) {
      return null;
    }

    const activeIndex = roundStages.findIndex((stage) => stage.id === roundStageSummary.activeStage);

    return (
      <article className={styles.stageDisplay}>
        <div className={styles.stageHeader}>
          <div>
            <p className={styles.stageLabel}>Round Stage</p>
            <h2>{roundStageSummary.title}</h2>
          </div>
          <p className={styles.stageDetail}>{roundStageSummary.detail}</p>
        </div>

        <div className={styles.stageTrack} role="list" aria-label="Round flow">
          {roundStages.map((stage, index) => {
            const stateClassName =
              index < activeIndex
                ? styles.stageStepComplete
                : index === activeIndex
                  ? styles.stageStepActive
                  : styles.stageStepPending;

            return (
              <div
                aria-current={index === activeIndex ? "step" : undefined}
                className={`${styles.stageStep} ${stateClassName}`}
                key={stage.id}
                role="listitem"
              >
                <span className={styles.stageStepTop}>
                  <span className={styles.stageDot} />
                  <span className={styles.stageState}>
                      {index < activeIndex
                        ? "Done"
                        : index === activeIndex
                          ? roundStageSummary.timerLabel ?? "Now"
                          : "Next"}
                  </span>
                </span>
                <strong>{stage.label}</strong>
              </div>
            );
          })}
        </div>
      </article>
    );
  }

  function renderWaitingLobbyCard() {
    if (!(viewer || canShare)) {
      return null;
    }

    return (
      <article className={`${styles.card} ${styles.cardWide}`}>
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

        {resolvedTab === "primary" && viewer ? (
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
              {isHost ? (
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
    );
  }

  function renderSettingsCard() {
    if (!viewer) {
      return null;
    }

    if (!isHost) {
      return (
        <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
          <div className={styles.cardHeader}>
            <p>Waiting for Next Round</p>
            <span>Host controls round setup</span>
          </div>
          <p className={styles.waitingState}>
            The host is choosing the next game. Your current bankroll is {formatMoney(viewer.balance)}.
          </p>
        </article>
      );
    }

    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <div className={styles.cardHeader}>
          <p>Game Settings</p>
          <span>Host only</span>
        </div>
        <div className={styles.tabRow} role="tablist" aria-label="Game selection">
          <button
            aria-selected={gameTab === "dice"}
            className={`${styles.tabButton} ${gameTab === "dice" ? styles.tabButtonActive : ""}`}
            onClick={() => setGameTab("dice")}
            role="tab"
            type="button"
          >
            Dice
          </button>
          <button
            aria-selected={gameTab === "roulette"}
            className={`${styles.tabButton} ${gameTab === "roulette" ? styles.tabButtonActive : ""}`}
            onClick={() => setGameTab("roulette")}
            role="tab"
            type="button"
          >
            Roulette
          </button>
        </div>

        <form className={styles.form} onSubmit={handleStartRound}>
          <div className={styles.settingsGrid}>
            <label className={styles.field}>
              <span>Add money</span>
              <input
                inputMode="numeric"
                min="0"
                name="addMoney"
                onChange={(event) => updateSettings(gameTab, "addMoney", event.target.value)}
                step="1"
                type="number"
                value={settings[gameTab].addMoney}
              />
            </label>

            <label className={styles.field}>
              <span>Minimum bet</span>
              <input
                inputMode="numeric"
                min="0"
                name="minimumBet"
                onChange={(event) => updateSettings(gameTab, "minimumBet", event.target.value)}
                step="1"
                type="number"
                value={settings[gameTab].minimumBet}
              />
            </label>

            <label className={styles.field}>
              <span>Cheaters (%)</span>
              <input
                inputMode="decimal"
                min="0"
                name="cheatersPercent"
                onChange={(event) => updateSettings(gameTab, "cheatersPercent", event.target.value)}
                step="0.01"
                type="number"
                value={settings[gameTab].cheatersPercent}
              />
            </label>

            <label className={styles.field}>
              <span>Edge (%)</span>
              <input
                inputMode="decimal"
                min="0"
                name="edgePercent"
                onChange={(event) => updateSettings(gameTab, "edgePercent", event.target.value)}
                step="0.01"
                type="number"
                value={settings[gameTab].edgePercent}
              />
            </label>
          </div>

          <button className={styles.primaryButton} disabled={busy !== "idle"} type="submit">
            {busy === "start-round" ? "Starting round..." : "Start Round"}
          </button>
        </form>
      </article>
    );
  }

  function renderDiceBettingCard(round: DiceRound) {
    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <div className={styles.cardHeader}>
          <p>Dice Round</p>
          <span>Place your bet</span>
        </div>

        <div className={styles.chipRow}>
          <span className={styles.infoChip}>Minimum bet: {formatMoney(round.minimumBet)}</span>
          <span className={styles.infoChip}>Current pot: {formatMoney(round.bets.length * round.minimumBet)}</span>
        </div>

        <p className={styles.rules}>{round.rules}</p>

        {viewer ? (
          viewerHasBet ? (
            <p className={styles.waitingState}>
              You are in this round for {formatMoney(round.minimumBet)}. Sit tight while betting finishes.
            </p>
          ) : (
            <div className={styles.actionPanel}>
              <p className={styles.waitingState}>
                Place the minimum bet of {formatMoney(round.minimumBet)} within 30 seconds to play.
              </p>
              <button
                className={styles.primaryButton}
                disabled={busy !== "idle" || viewer.balance < round.minimumBet}
                onClick={handlePlaceBet}
                type="button"
              >
                {busy === "bet" ? "Placing bet..." : "Place Bet"}
              </button>
            </div>
          )
        ) : null}
      </article>
    );
  }

  function renderViewerResult(result: DiceResult | undefined) {
    if (!result) {
      return (
        <div className={styles.viewerResult}>
          <h3>You sat out this round</h3>
          <p className={styles.waitingState}>No bet was placed before the timer expired.</p>
        </div>
      );
    }

    return (
      <div className={styles.viewerResult}>
        <div className={styles.viewerResultHeader}>
          <h3>Your Roll</h3>
          <span className={styles.scoreValue}>{resultsVisible ? result.score : "..."}</span>
        </div>
        {renderDiceFaces(result.dice, result.sessionId, false, Math.max(0, Math.min(resultRevealStep - 1, 4)))}
        {resultRevealStep <= 1 ? <p className={styles.rollingHint}>Dice are rolling...</p> : null}
        {resultRevealStep > 1 && resultRevealStep < 5 ? (
          <p className={styles.rollingHint}>Rolling one die at a time...</p>
        ) : null}
        {resultRevealStep >= 5 && !resultsVisible ? (
          <p className={styles.rollingHint}>Calculating winners...</p>
        ) : null}
      </div>
    );
  }

  function renderDiceResultsCard(round: DiceRound) {
    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <div className={styles.cardHeader}>
          <p>Dice Results</p>
          <span>Round complete</span>
        </div>

        <div className={styles.chipRow}>
          <span className={styles.infoChip}>Prize pool: {formatMoney(round.pot)}</span>
          <span className={styles.infoChip}>Winning split: {formatMoney(round.winningsPerWinner)}</span>
        </div>

        {renderViewerResult(viewerResult)}

        {!resultsVisible ? (
          <div className={styles.resultsInterstitial}>
            <div className={styles.resultsPulse} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h3>Calculating winners</h3>
            <p className={styles.waitingState}>
              Totals are locked in. Ranking the table and splitting the pot now.
            </p>
          </div>
        ) : round.results.length > 0 ? (
          <div className={styles.rankingList}>
            {round.results.map((result, index) => (
              <div
                className={`${styles.resultRow} ${result.isWinner ? styles.resultWinner : ""} ${result.isCheater ? styles.resultCheater : ""}`}
                key={result.sessionId}
              >
                <div className={styles.resultPlacement}>#{index + 1}</div>
                <div className={styles.resultIdentity}>
                  <strong>{result.displayName}</strong>
                  <div className={styles.resultMetaRow}>
                    {renderDiceFaces(result.dice, result.sessionId, true, Math.max(0, Math.min(resultRevealStep - 1, 4)))}
                  </div>
                </div>
                <div className={styles.resultTotals}>
                  <strong>{resultsVisible ? result.score : "..."}</strong>
                  <span className={styles.balanceDelta}>
                    {result.payout > 0 ? `+${formatMoney(result.payout)}` : formatMoney(0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.waitingState}>No bets were placed, so this round had no entrants.</p>
        )}
      </article>
    );
  }

  function renderRouletteCard(round: RouletteRound) {
    return (
      <article className={`${styles.card} ${styles.cardWide} ${styles.stageCard}`}>
        <div className={styles.cardHeader}>
          <p>Roulette</p>
          <span>Spin in progress</span>
        </div>
        <div className={styles.chipRow}>
          <span className={styles.infoChip}>Minimum bet: {formatMoney(round.minimumBet)}</span>
        </div>
        <p className={styles.waitingState}>{round.message}</p>
      </article>
    );
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
              <div className={styles.statusMeta}>
                <span>{lobby.players.length} player{lobby.players.length === 1 ? "" : "s"}</span>
                <span>Total: {formatMoney(totalMoney)}</span>
              </div>
            </div>

            <div className={styles.playerList}>
              {lobby.players.map((player) => (
                <div className={styles.playerRow} key={player.sessionId}>
                  <span className={styles.playerFunds}>{formatMoney(player.balance)}</span>
                  <div className={styles.playerIdentity}>
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
          {renderRoundStageDisplay()}
          <section className={styles.grid}>
            {lobby.status === "waiting" ? renderWaitingLobbyCard() : null}
            {lobby.status === "started" && !activeRound ? renderSettingsCard() : null}
            {activeRound?.game === "dice" && activeRound.phase === "betting"
              ? renderDiceBettingCard(activeRound)
              : null}
            {activeRound?.game === "dice" && activeRound.phase === "results"
              ? renderDiceResultsCard(activeRound)
              : null}
            {activeRound?.game === "roulette" ? renderRouletteCard(activeRound) : null}
          </section>
        </section>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
    </main>
  );
}

function getRoundStageSummary({
  activeRound,
  bettingCountdown,
  diceStageCountdown,
  initialSessionId,
  isHost,
  resultsCountdown,
  resultRevealStep,
  viewer,
  viewerHasBet,
}: {
  activeRound: LobbySnapshot["currentRound"];
  bettingCountdown: number;
  diceStageCountdown: number;
  initialSessionId?: string;
  isHost: boolean;
  resultsCountdown: number;
  resultRevealStep: number;
  viewer?: LobbySnapshot["players"][number];
  viewerHasBet: boolean;
}): RoundStageSummary | null {
  if (!viewer && !initialSessionId) {
    return null;
  }

  if (!activeRound) {
    return {
      activeStage: "setup",
      detail: isHost
        ? "Choose a game, tune the rules, and launch the next round."
        : "The host is setting the table for the next round.",
      title: "Round Setup",
    };
  }

  if (activeRound.game === "dice" && activeRound.phase === "betting") {
    return {
      activeStage: "bet",
      detail: viewerHasBet
        ? "You're locked in while the rest of the table decides whether to join."
        : "Betting is live now. Join before the timer closes.",
      timerLabel: `${bettingCountdown}s left`,
      title: "Betting Open",
    };
  }

  if (activeRound.game === "dice" && activeRound.phase === "results") {
    if (diceStageCountdown > 0) {
      return {
        activeStage: "roll",
        detail:
          resultRevealStep <= 1
            ? "Dice are tumbling now. The reveal starts in a beat."
            : resultRevealStep >= 5
              ? "The table is being ranked before the results board opens."
              : "Dice are being revealed one by one.",
        timerLabel: `${diceStageCountdown}s left`,
        title: "Rolling Dice",
      };
    }

    return {
      activeStage: "results",
      detail: "Scores and payouts are on screen before the lobby resets for the next round.",
      timerLabel: `${resultsCountdown}s left`,
      title: "Results Live",
    };
  }

  if (activeRound.game === "roulette") {
    return {
      activeStage: "roll",
      detail: activeRound.message,
      timerLabel: `${resultsCountdown}s left`,
      title: "Roulette Spin",
    };
  }

  return {
    activeStage: "setup",
    detail: "The host is setting the table for the next round.",
    title: "Round Setup",
  };
}