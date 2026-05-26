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

    await Room.create({ roomId, code: '', passwordHash })
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

// Coalesce DB writes: per-room, write at most once per FLUSH_INTERVAL_MS.
// Keystrokes update the in-memory buffer; the timer flushes the latest code.
const FLUSH_INTERVAL_MS = 1000
const pendingWrites = new Map() // roomId -> { code, timer }

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

function schedulePersist(roomId, code) {
  const existing = pendingWrites.get(roomId)
  if (existing) {
    // A flush is already scheduled; just update the buffered code.
    existing.code = code
    return
  }

  const timer = setTimeout(() => flushRoom(roomId), FLUSH_INTERVAL_MS)
  pendingWrites.set(roomId, { code, timer })
}

async function flushRoom(roomId) {
  const pending = pendingWrites.get(roomId)
  if (!pending) return
  pendingWrites.delete(roomId)

  try {
    await Room.findOneAndUpdate(
      { roomId },
      { code: pending.code },
      { upsert: true }
    )
  } catch (err) {
    console.error(`  ✗ Failed to persist room "${roomId}":`, err.message)
  }
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
      const room = await Room.findOne({ roomId })
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

      socket.emit('init-code', room.code)
    } catch (err) {
      console.error(`  ✗ Failed to join room "${roomId}":`, err.message)
      socket.emit('join-error', { reason: 'internal-error' })
    }
  })

      socket.on('code-change', ({ roomId, code }) => {
    // Defend against ghost emits — if join-room rejected this socket,
    // it never entered socket.rooms and shouldn't be able to mutate the doc.
    if (!socket.rooms.has(roomId)) return
    // Broadcast first for low latency — peers don't wait for the DB write.
    socket.to(roomId).emit('code-change', code)
    schedulePersist(roomId, code)
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
