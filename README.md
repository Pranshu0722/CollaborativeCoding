# Collaborative Coding Platform

A real-time, web-based collaborative code editor. Multiple users join a room and edit the same file together — like Google Docs, but for code.

**🟢 Live demo:** https://collaborative-coding-jade.vercel.app

## Tech Stack

**Frontend:** React (Vite) · Tailwind CSS · Monaco Editor · Socket.IO Client
**Backend:** Node.js · Express.js · Socket.IO
**Database:** MongoDB *(planned)*
**Hosting:** Vercel (frontend) · Render (backend)

## Architecture

```
Browser ──HTTPS──► Vercel (static React bundle)
   │
   └── WSS ──────► Render (Node + Express + Socket.IO)
                      │
                      └── In-memory room state: Map<roomId, latestCode>
```

The backend keeps a per-room snapshot of the latest code so late joiners sync to current state. Real-time edits are broadcast to all sockets in the room (excluding the sender) over WebSocket. Empty rooms are garbage-collected when the last member disconnects.

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

> Requires Node.js 20+ and npm.

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
- **Backend → Render** — configured via `render.yaml`. Set `CLIENT_URL` as a comma-separated list of allowed origins (the Vercel domain + `http://localhost:5173` for local dev against prod).

The free tier on Render sleeps after 15 minutes of inactivity; the first request after a cold start takes ~30 seconds to wake the service.

## Status

- ✅ **Phase 1 (complete):** Real-time code sync between connected clients via Socket.IO rooms.
- ✅ **Phase 2 (complete):** Public deployment to Vercel + Render with multi-origin CORS, SPA routing, and infrastructure-as-code.
- 🔜 **Phase 3 (planned):** Persistence layer (MongoDB), presence indicators, conflict-free editing (Yjs CRDT), code execution sandbox.

## License

MIT

## Known Issues

- `npm audit` reports 2 moderate-severity transitive vulnerabilities in `dompurify` via `monaco-editor`. DOMPurify is patched upstream but `monaco-editor` has not yet bumped its pinned version. Exploits require attacker-controlled HTML/Markdown to reach DOMPurify; our app does not feed external content into Monaco's display layer, so real-world exposure is negligible. Will resolve automatically when `monaco-editor` ships an update.
