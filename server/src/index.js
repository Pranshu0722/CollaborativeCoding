import 'dotenv/config'
import express from 'express'
import cors from 'cors'

const app = express()

const PORT = process.env.PORT || 5000
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173'

// ----- Middleware -----
app.use(cors({ origin: CLIENT_URL }))
app.use(express.json())

// ----- Routes -----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// ----- Boot -----
app.listen(PORT, () => {
  console.log(`✓ Server listening on http://localhost:${PORT}`)
  console.log(`  CORS allowed origin: ${CLIENT_URL}`)
})
