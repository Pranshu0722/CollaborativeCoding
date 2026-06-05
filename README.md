# Collaborative Coding Platform

A real-time, web-based collaborative code editor. Multiple users join a room and edit the same file together — like Google Docs, but for code.

**🟢 Live demo:** https://collaborative-coding-jade.vercel.app

## Tech Stack

**Frontend:** React (Vite) · Tailwind CSS · Monaco Editor · Socket.IO Client · Yjs CRDT
**Backend:** Node.js · Express.js · Socket.IO · Yjs CRDT
**Database:** MongoDB Atlas
**Code execution:** JDoodle compiler API (6 languages)
**Hosting:** Vercel (frontend) · Render (backend)

## Architecture

```
Browser ──HTTPS──► Vercel (static React bundle)
   │
   └── WSS ──────► Render (Node + Express + Socket.IO) ──HTTPS──► JDoodle API
                      │
                      └── MongoDB Atlas: Room { roomId, codeByLanguage, language, passwordHash, timestamps }

```

Room state is persisted to MongoDB Atlas, so a room's code survives server restarts and free-tier sleep cycles.

### Real-time collaboration (Yjs CRDT)

Instead of sending full text snapshots on every keystroke, the editor uses **Yjs**, a CRDT (Conflict-free Replicated Data Type) library. Each room has an in-memory `Y.Doc` on the server containing one `Y.Text` per supported language. Edits produce small binary patches that are broadcast via a dedicated `yjs-update` Socket.IO event; applying these patches on every client's local `Y.Doc` keeps the document in sync automatically, with **no lost edits** even when multiple users type at the exact same position.

The `Y.Doc` is bound to Monaco Editor via `y-monaco/MonacoBinding`, which wires the editor's content model directly to the Y.Text type — the editor is uncontrolled and reacts to CRDT state changes. A lightweight custom `SocketIOProvider` transports Yjs updates over the existing Socket.IO connection, eliminating the need for a separate WebSocket server.

For persistence, all language texts are read from the in-memory `Y.Doc` and written to MongoDB as plain text 2 seconds after the last update. When the last user leaves a room, the doc is persisted immediately and freed from memory, so rooms hydrate fresh from the database on the next join.

### Room lifecycle

Each room supports six languages (JavaScript, Python, C++, Java, Go, Rust) with **per-language code storage** — every language has its own independent draft, so switching language never destroys work (LeetCode model). The schema stores code as `codeByLanguage: Map<string, string>`. Legacy rooms from before the multi-language schema are lazily migrated into the new shape on first read.

### Code execution

Code execution runs through the [JDoodle compiler API](https://www.jdoodle.com/compiler-api). Clients POST `/api/execute` with `{ roomId, language, code, stdin, socketId }`; the server authorizes the caller's socket via Socket.IO's room membership map, enforces a 2-second per-room cooldown, calls JDoodle, and broadcasts the result via `execution-result` to other peers (the caller gets their copy through the HTTP response, so there's no double-fire). Stdin is local-only per tab — by design, not synced — letting different users test the same code against different inputs simultaneously. JDoodle merges stdout and stderr into one stream, so the output panel doesn't visually distinguish them. The free tier is 200 executions per day per `clientId`; on quota exhaustion the server returns HTTP 429 and the UI shows "Daily execution limit reached."

### Live cursors

Live cursor positions are broadcast over a separate `cursor-move` socket event (distinct from Yjs), throttled client-side to ~20 events per second to keep traffic bounded. Each remote caret renders as a thin colored line at the peer's exact line/column in the editor, in the same color as their avatar chip — derived from a deterministic hash of the socket ID, so cursor and chip always match without any server coordination. Cursor positions are never persisted and prune automatically when a peer leaves.

## Repository Layout

```
.
├── client/        # React + Vite frontend
│   └── vercel.json    # SPA fallback for client-side routing
├── server/        # Express + Socket.IO backend
├── render.yaml    # Render Blueprint (backend infra-as-code)
└── README.md
```

## Local Development

> Requires Node.js 20+, npm, a MongoDB connection string (free Atlas cluster works fine), and a free JDoodle API key (200 executions/day).

```bash
# 1. Install backend dependencies
cd server
cp .env.example .env       # then edit values if needed
npm install
npm run dev                # API on http://localhost:5000

# 2. In a separate terminal, install frontend dependencies
cd client
cp .env.example .env       # then edit values if needed
npm install
npm run dev                # app on http://localhost:5173
```

## Deployment

Both halves auto-deploy on push to `main`:

- **Frontend → Vercel** — configured via `client/vercel.json`. Set `VITE_SERVER_URL` in the Vercel dashboard to point at the production backend.
- **Backend → Render** — configured via `render.yaml`. Set `CLIENT_URL` as a comma-separated list of allowed origins (the Vercel domain + `http://localhost:5173` for local dev against prod), `MONGODB_URI` to your Atlas connection string, and `JDOODLE_CLIENT_ID` + `JDOODLE_CLIENT_SECRET` for code execution. The server refuses to start without all of these set.
- **Database → MongoDB Atlas** — free M0 cluster. Allowlist `0.0.0.0/0` in Network Access since Render's outbound IPs are dynamic; authentication via database user/password is the primary security layer.
- **Code execution → JDoodle** — sign up at [jdoodle.com/compiler-api](https://www.jdoodle.com/compiler-api), grab a `clientId` and `clientSecret` from the API Credentials tab. Free tier is 200 executions/day per credential pair.

The free tier on Render sleeps after 15 minutes of inactivity; the first request after a cold start takes ~30 seconds to wake the service.

## Status

- ✅ **Phase 1 (complete):** Real-time code sync between connected clients via Socket.IO rooms.
- ✅ **Phase 2 (complete):** Public deployment to Vercel + Render with multi-origin CORS, SPA routing, and infrastructure-as-code.
- ✅ **Phase 3 (complete):** MongoDB persistence with debounced writes; rooms survive server restarts and free-tier sleep cycles.
- ✅ **Phase 4 (complete):** Presence indicators — required name prompt on the landing page, live "in this room" list, and deterministic per-user avatar colors.
- ✅ **Phase 5 (complete):** Password-protected rooms — optional bcrypt-hashed password at creation, REST endpoints for explicit room lifecycle, client probes before connecting.
- ✅ **Phase 6 (complete):** Live cursor positions — each peer's caret renders in their avatar color, throttled to ~20 events per second, ephemeral (never persisted), prunes automatically on disconnect.
- ✅ **Phase 7 (complete):** Multi-language support and code execution — per-language code storage (LeetCode model), Run button + stdin + shared output panel, six languages (JavaScript, Python, C++, Java, Go, Rust) via JDoodle.
- ✅ **Phase 8 (complete):** Conflict-free editing via Yjs CRDT — in-memory `Y.Doc` per room, `MonacoBinding` for editor sync, custom `SocketIOProvider` over existing Socket.IO, debounced persistence from Y.Text to MongoDB.

## License

MIT

## Known Issues

- `npm audit` reports 2 moderate-severity transitive vulnerabilities in `dompurify` via `monaco-editor`. DOMPurify is patched upstream but `monaco-editor` has not yet bumped its pinned version. Exploits require attacker-controlled HTML/Markdown to reach DOMPurify; our app does not feed external content into Monaco's display layer, so real-world exposure is negligible. Will resolve automatically when `monaco-editor` ships an update.
