# Saturnalia

Anonymous Jackbox-style lobby prototype built with Next.js, Upstash Redis, and Pusher.

## Current Scope

- Create a lobby with a host session and short 4-character room code.
- Join a lobby by code or canonical lobby URL.
- Keep host and player views in sync through Pusher lobby update events.
- Preserve anonymous sessions in cookies so refreshes reattach to the same participant.
- Expose a host-only start action that flips the lobby into a placeholder started state.

Actual game flow, rounds, prompts, and scoring are intentionally out of scope for this phase.

## Environment

Copy `.env.example` to `.env.local` and fill in the values.

```bash
APP_BASE_URL=http://localhost:3000
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
PUSHER_APP_ID=
PUSHER_KEY=
PUSHER_SECRET=
PUSHER_CLUSTER=
NEXT_PUBLIC_PUSHER_KEY=
NEXT_PUBLIC_PUSHER_CLUSTER=
```

Notes:

- `APP_BASE_URL` should match the public origin for QR codes and share links.
- `PUSHER_KEY` and `NEXT_PUBLIC_PUSHER_KEY` are usually the same value.
- Without Redis or Pusher configured, the relevant routes will return configuration errors instead of silently falling back to in-memory state.

## Scripts

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
```

## Implemented Routes

- `/` landing page with create and join flows.
- `/lobby/[lobbyId]` canonical lobby page.
- `/api/lobbies` create lobby.
- `/api/lobbies/join-by-code` join by 4-character code and resolve the canonical URL.
- `/api/lobbies/[lobbyId]/join` join by canonical lobby URL.
- `/api/lobbies/[lobbyId]/leave` leave lobby.
- `/api/lobbies/[lobbyId]/start` host-only start placeholder.
- `/api/realtime/auth` authorize private Pusher subscriptions for lobby members.
