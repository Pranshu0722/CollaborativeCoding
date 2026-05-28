import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'
import mongoose from 'mongoose'
import dns from 'node:dns'
import bcrypt from 'bcryptjs'
import Room from './models/Room.js'

// Use public DNS resolvers for MongoDB Atlas SRV lookups.
// On some networks (Windows + certain ISPs/VPNs), the system DNS refuses
// SRV record queries, causing `querySrv ECONNREFUSED`. Forcing Google +
// Cloudflare DNS bypasses the issue.
dns.setServers(['8.8.8.8', '1.1.1.1'])

const app = express()
const httpServer = http.createServer(app)

const PORT = process.env.PORT || 5000

// CLIENT_URL accepts a comma-separated list so we can allow dev + production
// origins simultaneously (e.g. "http://localhost:5173,https://app.vercel.app").
const ALLOWED_ORIGINS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI is not set. Refusing to start.')
  process.exit(1)
}

// Permissive but bounded — alphanumeric + dash/underscore, 1–40 chars.
// Constrains both URL paths and what we'll accept into Mongoose queries.
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/

// bcrypt cost factor. 10 is the de-facto default; ~80ms per compare on
// commodity hardware — slow enough to deter brute force, fast enough not
// to noticeably block the event loop at our scale.
const BCRYPT_COST = 10

// Languages we accept for new rooms, language-change events, and execute.
// Keys are Monaco language IDs; PISTON_LANGUAGE maps them to whatever
// names the Piston API expects (only "cpp" → "c++" actually differs).
const SUPPORTED_LANGUAGES = ['javascript', 'python', 'cpp', 'java', 'go', 'rust']

const PISTON_LANGUAGE = {
  javascript: 'javascript',
  python: 'python',
  cpp: 'c++',
  java: 'java',
  go: 'go',
  rust: 'rust',
}

// Initial buffer for newly-created rooms, one per supported language.
// Each snippet defines and calls a small function so a fresh room produces
// visible output when the user hits Run.
const DEFAULT_CODE_BY_LANGUAGE = {
  javascript: `// Welcome to your collab room
// Hit Run to execute, or share the URL to code together
function hello(name) {
  return \`Hello, \${name}!\`
}
console.log(hello("world"))
`,
  python: `# Welcome to your collab room
# Hit Run to execute, or share the URL to code together
def hello(name):
    return f"Hello, {name}!"

print(hello("world"))
`,
  cpp: `// Welcome to your collab room
// Hit Run to execute, or share the URL to code together
#include <iostream>
#include <string>

std::string hello(const std::string& name) {
  return "Hello, " + name + "!";
}

int main() {
  std::cout << hello("world") << std::endl;
  return 0;
}
`,
  java: `// Welcome to your collab room
// Hit Run to execute, or share the URL to code together
public class Main {
  static String hello(String name) {
    return "Hello, " + name + "!";
  }

  public static void main(String[] args) {
    System.out.println(hello("world"));
  }
}
`,
  go: `// Welcome to your collab room
// Hit Run to execute, or share the URL to code together
package main

import "fmt"

func hello(name string) string {
  return "Hello, " + name + "!"
}

func main() {
  fmt.Println(hello("world"))
}
`,
  rust: `// Welcome to your collab room
// Hit Run to execute, or share the URL to code together
fn hello(name: &str) -> String {
  format!("Hello, {}!", name)
}

fn main() {
  println!("{}", hello("world"));
}
`,
}

app.use(cors({ origin: ALLOWED_ORIGINS }))
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// POST /api/rooms — create a room, optionally password-protected.
// Password is hashed with bcrypt before storage; plaintext is never logged.
app.post('/api/rooms', async (req, res) => {
  const { roomId, password } = req.body || {}

  if (!roomId || typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    return res.status(400).json({ error: 'invalid-room-id' })
  }

  try {
    const existing = await Room.findOne({ roomId })
    if (existing) {
      return res.status(409).json({ error: 'room-already-exists' })
    }

    let passwordHash = null
    if (typeof password === 'string' && password.length > 0) {
      passwordHash = await bcrypt.hash(password, BCRYPT_COST)
    }
    await Room.create({
      roomId,
      codeByLanguage: new Map([
        ['javascript', DEFAULT_CODE_BY_LANGUAGE.javascript],
      ]),
      language: 'javascript',
      passwordHash,
    })
    res.status(201).json({ roomId, requiresPassword: Boolean(passwordHash) })
  } catch (err) {
    console.error(`  ✗ Failed to create room "${roomId}":`, err.message)
    res.status(500).json({ error: 'internal-error' })
  }
})

// GET /api/rooms/:roomId — public probe used by the client before connecting.
// Reveals existence and whether a password is required, NEVER the hash itself.
app.get('/api/rooms/:roomId', async (req, res) => {
  const { roomId } = req.params

  if (!ROOM_ID_PATTERN.test(roomId)) {
    return res.status(400).json({ error: 'invalid-room-id' })
  }

  try {
    const room = await Room.findOne({ roomId }).select('passwordHash')
    if (!room) {
      return res.json({ exists: false, requiresPassword: false })
    }
    res.json({ exists: true, requiresPassword: Boolean(room.passwordHash) })
  } catch (err) {
    console.error(`  ✗ Failed to check room "${roomId}":`, err.message)
    res.status(500).json({ error: 'internal-error' })
  }
})

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS },
})

// Coalesce DB writes per (roomId, language). Keystrokes mutate the in-memory
// buffer; a single timer per (roomId, language) flushes the latest code.
const FLUSH_INTERVAL_MS = 1000
const pendingWrites = new Map() // key -> { code, timer }

function pendingKey(roomId, language) {
  return `${roomId}::${language}`
}

// Presence: roomId -> Map<socketId, { name }>. Ephemeral; never persisted.
// Lives only as long as sockets are connected.
const presence = new Map()

function getRoomUsers(roomId) {
  const roomPresence = presence.get(roomId)
  if (!roomPresence) return []
  return Array.from(roomPresence.entries())
    .map(([socketId, user]) => ({ socketId, name: user.name }))
    .sort((a, b) => a.socketId.localeCompare(b.socketId))
}

function broadcastUsers(roomId) {
  io.to(roomId).emit('room-users', getRoomUsers(roomId))
}

function schedulePersist(roomId, language, code) {
  const key = pendingKey(roomId, language)
  const existing = pendingWrites.get(key)
  if (existing) {
    existing.code = code
    return
  }
  const timer = setTimeout(() => flushWrite(roomId, language), FLUSH_INTERVAL_MS)
  pendingWrites.set(key, { code, timer })
}

async function flushWrite(roomId, language) {
  const key = pendingKey(roomId, language)
  const pending = pendingWrites.get(key)
  if (!pending) return
  pendingWrites.delete(key)

  try {
    await Room.findOneAndUpdate(
      { roomId },
      { $set: { [`codeByLanguage.${language}`]: pending.code } }
    )
  } catch (err) {
    console.error(
      `  ✗ Failed to persist ${language} code for "${roomId}":`,
      err.message
    )
  }
}

// Load a room, migrating pre-7.2.5 docs in place: if codeByLanguage is empty
// but the legacy `code` field has content, seed codeByLanguage[language] from
// it and clear the legacy field. Idempotent — already-migrated rooms are a no-op.
async function loadRoom(roomId) {
  const room = await Room.findOne({ roomId })
  if (!room) return null

  const hasNewData = room.codeByLanguage && room.codeByLanguage.size > 0
  if (!hasNewData && typeof room.code === 'string' && room.code.length > 0) {
    room.codeByLanguage = new Map([[room.language, room.code]])
    room.code = undefined
    await room.save()
  }
  return room
}

function getRoomCode(room, language) {
  return (
    room.codeByLanguage?.get(language) ??
    DEFAULT_CODE_BY_LANGUAGE[language] ??
    ''
  )
}

io.on('connection', (socket) => {
  console.log(`✓ Client connected:    ${socket.id}`)

  socket.on('join-room', async ({ roomId, name, password } = {}) => {
    if (!roomId || typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
      socket.emit('join-error', { reason: 'invalid-room-id' })
      return
    }
    const userName = String(name || '').trim().slice(0, 40) || 'Anonymous'

    try {
      const room = await loadRoom(roomId)
      if (!room) {
        socket.emit('join-error', { reason: 'not-found' })
        return
      }

      if (room.passwordHash) {
        if (typeof password !== 'string' || password.length === 0) {
          socket.emit('join-error', { reason: 'password-required' })
          return
        }
        const ok = await bcrypt.compare(password, room.passwordHash)
        if (!ok) {
          socket.emit('join-error', { reason: 'wrong-password' })
          return
        }
      }

      socket.join(roomId)
      console.log(`  → ${socket.id} joined room "${roomId}" as "${userName}"`)

      if (!presence.has(roomId)) presence.set(roomId, new Map())
      presence.get(roomId).set(socket.id, { name: userName })
      broadcastUsers(roomId)

      socket.emit('init-room', {
        code: getRoomCode(room, room.language),
        language: room.language,
      })
    } catch (err) {
      console.error(`  ✗ Failed to join room "${roomId}":`, err.message)
      socket.emit('join-error', { reason: 'internal-error' })
    }
  })

  socket.on('code-change', ({ roomId, code, language } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return
    if (typeof code !== 'string') return
    if (!SUPPORTED_LANGUAGES.includes(language)) return

    // Broadcast first for low latency. Include the language so peers can
    // filter out edits authored under a now-stale language (race condition
    // when someone switches language mid-typing).
    socket.to(roomId).emit('code-change', { code, language })
    schedulePersist(roomId, language, code)
  })

  socket.on('language-change', async ({ roomId, language } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return
    if (!SUPPORTED_LANGUAGES.includes(language)) return

    try {
      const room = await loadRoom(roomId)
      if (!room) return
      if (room.language === language) return // no-op

      room.language = language
      await room.save()

      io.to(roomId).emit('language-change', {
        language,
        code: getRoomCode(room, language),
      })
    } catch (err) {
      console.error(`  ✗ language-change failed for "${roomId}":`, err.message)
    }
  })

  socket.on('cursor-move', ({ roomId, position } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return
    if (
      !position ||
      typeof position.lineNumber !== 'number' ||
      typeof position.column !== 'number' ||
      !Number.isFinite(position.lineNumber) ||
      !Number.isFinite(position.column) ||
      position.lineNumber < 1 ||
      position.column < 1
    ) {
      return
    }

    socket.to(roomId).emit('cursor-move', {
      socketId: socket.id,
      position: {
        lineNumber: position.lineNumber,
        column: position.column,
      },
    })
  })

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue
      const roomPresence = presence.get(roomId)
      if (!roomPresence) continue
      roomPresence.delete(socket.id)
      if (roomPresence.size === 0) {
        presence.delete(roomId)
      } else {
        broadcastUsers(roomId)
      }
    }
  })
})

async function start() {
  try {
    await mongoose.connect(MONGODB_URI)
    console.log('✓ Connected to MongoDB')
  } catch (err) {
    console.error('✗ MongoDB connection failed:', err.message)
    process.exit(1)
  }

  httpServer.listen(PORT, () => {
    console.log(`✓ Server listening on http://localhost:${PORT}`)
    console.log(`  CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`)
  })
}

start()
