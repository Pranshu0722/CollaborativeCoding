# Collaborative Coding Platform

A real-time, web-based collaborative code editor. Multiple users join a room and edit the same file together — like Google Docs, but for code.

**🟢 Live demo:** https://collaborative-coding-jade.vercel.app

## Tech Stack

**Frontend:** React (Vite) · Tailwind CSS · Monaco Editor · Socket.IO Client
**Backend:** Node.js · Express.js · Socket.IO
**Database:** MongoDB Atlas
**Hosting:** Vercel (frontend) · Render (backend)

## Architecture

```
Browser ──HTTPS──► Vercel (static React bundle)
   │
   └── WSS ──────► Render (Node + Express + Socket.IO)
                      │
                      └── MongoDB Atlas: Room { roomId, code, timestamps }

```

Room state is persisted to MongoDB Atlas, so a room's code survives server restarts and free-tier sleep cycles. Real-time edits are broadcast to all sockets in the room (excluding the sender) over WebSocket; DB writes are debounced at 1 write per second per room to avoid hammering the cluster on every keystroke. Late joiners get the current code via a `findOne` lookup on `join-room`.

Active users (presence) are tracked in-memory per room and broadcast to all sockets on join/leave — deliberately not persisted, since presence is ephemeral by definition. Names are prompted on the landing page and stored in `localStorage`; per-user avatar colors are derived deterministically from each socket's ID via a string hash, so every client agrees on who's which color without server coordination.

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

> Requires Node.js 20+, npm, and a MongoDB connection string (free Atlas cluster works fine).

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
- **Backend → Render** — configured via `render.yaml`. Set `CLIENT_URL` as a comma-separated list of allowed origins (the Vercel domain + `http://localhost:5173` for local dev against prod). Also set `MONGODB_URI` to your Atlas connection string.
- **Database → MongoDB Atlas** — free M0 cluster. Allowlist `0.0.0.0/0` in Network Access since Render's outbound IPs are dynamic; authentication via database user/password is the primary security layer.

The free tier on Render sleeps after 15 minutes of inactivity; the first request after a cold start takes ~30 seconds to wake the service.

## Status

- ✅ **Phase 1 (complete):** Real-time code sync between connected clients via Socket.IO rooms.
- ✅ **Phase 2 (complete):** Public deployment to Vercel + Render with multi-origin CORS, SPA routing, and infrastructure-as-code.
- ✅ **Phase 3 (complete):** MongoDB persistence with debounced writes; rooms survive server restarts and free-tier sleep cycles.
- ✅ **Phase 4 (complete):** Presence indicators — required name prompt on the landing page, live "in this room" list, and deterministic per-user avatar colors.
- 🔜 **Phase 5 (planned):** Password-protected rooms, conflict-free editing (Yjs CRDT), and code execution sandbox.


## License

MIT

## Known Issues

- `npm audit` reports 2 moderate-severity transitive vulnerabilities in `dompurify` via `monaco-editor`. DOMPurify is patched upstream but `monaco-editor` has not yet bumped its pinned version. Exploits require attacker-controlled HTML/Markdown to reach DOMPurify; our app does not feed external content into Monaco's display layer, so real-world exposure is negligible. Will resolve automatically when `monaco-editor` ships an update.
