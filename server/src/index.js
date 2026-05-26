import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'

const app = express()
const httpServer = http.createServer(app)

const PORT = process.env.PORT || 5000
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173'

app.use(cors({ origin: CLIENT_URL }))
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL },
})

// In-memory store: latest code per room (roomId -> string).
// For production we'd replace this with Redis or MongoDB so the data
// survives server restarts and works across multiple Node processes.
const roomCode = new Map()

io.on('connection', (socket) => {
  console.log(`✓ Client connected:    ${socket.id}`)

  socket.on('join-room', (roomId) => {
    socket.join(roomId)
    console.log(`  → ${socket.id} joined room "${roomId}"`)

    // If this room already has code, sync the joiner up to it.
    const current = roomCode.get(roomId)
    if (current !== undefined) {
      socket.emit('init-code', current)
    }
  })

  socket.on('code-change', ({ roomId, code }) => {
    roomCode.set(roomId, code)
    // socket.to(roomId) = everyone in the room EXCEPT the sender.
    // io.to(roomId) would include the sender too — that's the echo bug.
    socket.to(roomId).emit('code-change', code)
  })

  socket.on('disconnecting', () => {
    // socket.rooms still contains the rooms at this point.
    // After this handler returns, Socket.IO removes the socket from them.
    socket.rooms.forEach((roomId) => {
      // Socket.IO auto-creates a personal room named after socket.id.
      // Ignore that — it's not a collab room.
      if (roomId === socket.id) return

      const room = io.sockets.adapter.rooms.get(roomId)
      if (room && room.size === 1) {
        // This socket is the last member; the room will be empty after we leave.
        roomCode.delete(roomId)
        console.log(`  ↳ Room "${roomId}" emptied; code cleared`)
      }
    })
  })

  socket.on('disconnect', (reason) => {
    console.log(`✗ Client disconnected: ${socket.id} (${reason})`)
  })
})

httpServer.listen(PORT, () => {
  console.log(`✓ Server listening on http://localhost:${PORT}`)
  console.log(`  CORS allowed origin: ${CLIENT_URL}`)
})
