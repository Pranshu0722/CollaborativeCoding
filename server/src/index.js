import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'

const app = express()
const httpServer = http.createServer(app)

const PORT = process.env.PORT || 5000
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173'

// ----- Express middleware -----
app.use(cors({ origin: CLIENT_URL }))
app.use(express.json())

// ----- HTTP routes -----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// ----- Socket.IO -----
const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL },
})

io.on('connection', (socket) => {
  console.log(`✓ Client connected:    ${socket.id}`)

  socket.on('disconnect', (reason) => {
    console.log(`✗ Client disconnected: ${socket.id} (${reason})`)
  })
})

// ----- Boot -----
httpServer.listen(PORT, () => {
  console.log(`✓ Server listening on http://localhost:${PORT}`)
  console.log(`  CORS allowed origin: ${CLIENT_URL}`)
})
