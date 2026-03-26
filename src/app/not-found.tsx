import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        width: "min(720px, calc(100vw - 32px))",
        margin: "0 auto",
        padding: "80px 0",
      }}
    >
      <p
        style={{
          color: "var(--accent-strong)",
          fontSize: "0.82rem",
          fontWeight: 700,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
        }}
      >
        Lobby Not Found
      </p>
      <h1 style={{ marginTop: 10, fontSize: "clamp(3rem, 8vw, 5rem)", lineHeight: 0.92 }}>
        That room is gone.
      </h1>
      <p style={{ marginTop: 18, color: "var(--muted)", lineHeight: 1.7 }}>
        The code may be wrong, the lobby may have expired, or the last player already left.
      </p>
      <Link
        href="/"
        style={{
          display: "inline-flex",
          marginTop: 28,
          padding: "13px 18px",
          borderRadius: 16,
          background: "linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)",
          color: "#fff8f3",
          fontWeight: 700,
        }}
      >
        Return home
      </Link>
    </main>
  );
}