import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'
import mongoose from 'mongoose'
import dns from 'node:dns'
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

app.use(cors({ origin: ALLOWED_ORIGINS }))
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS },
})

// Coalesce DB writes: per-room, write at most once per FLUSH_INTERVAL_MS.
// Keystrokes update the in-memory buffer; the timer flushes the latest code.
const FLUSH_INTERVAL_MS = 1000
const pendingWrites = new Map() // roomId -> { code, timer }

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

  socket.on('join-room', async (roomId) => {
    socket.join(roomId)
    console.log(`  → ${socket.id} joined room "${roomId}"`)

    try {
      const room = await Room.findOne({ roomId })
      if (room) {
        socket.emit('init-code', room.code)
      }
    } catch (err) {
      console.error(`  ✗ Failed to load room "${roomId}":`, err.message)
    }
  })

    socket.on('code-change', ({ roomId, code }) => {
    // Broadcast first for low latency — peers don't wait for the DB write.
    socket.to(roomId).emit('code-change', code)
    schedulePersist(roomId, code)
  })


  socket.on('disconnect', (reason) => {
    console.log(`✗ Client disconnected: ${socket.id} (${reason})`)
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
