# Collaborative Coding Platform

A real-time, web-based collaborative code editor. Multiple users join a room and edit the same file together — like Google Docs, but for code.

## Tech Stack

**Frontend:** React (Vite) · Tailwind CSS · Monaco Editor · Socket.IO Client
**Backend:** Node.js · Express.js · Socket.IO
**Database:** MongoDB *(planned)*
**Deployment:** Vercel (frontend) · Render / Railway (backend) *(planned)*

## Repository Layout

```
.
├── client/   # React + Vite frontend
├── server/   # Express + Socket.IO backend
└── README.md
```

## Local Development

> Requires Node.js 18+ and npm.

```bash
# 1. Install backend dependencies
cd server
npm install
npm run dev          # starts API on http://localhost:5000

# 2. In a separate terminal, install frontend dependencies
cd client
npm install
npm run dev          # opens app on http://localhost:5173
```

## Status

Currently in **Phase 1**: real-time code sync between connected clients.

## License

MIT


## Known Issues

- `npm audit` reports 2 moderate-severity transitive vulnerabilities in `dompurify` via `monaco-editor`. DOMPurify is patched upstream but `monaco-editor` has not yet bumped its pinned version. Exploits require attacker-controlled HTML/Markdown to reach DOMPurify; our app does not feed external content into Monaco's display layer, so real-world exposure is negligible. Will resolve automatically when `monaco-editor` ships an update.

