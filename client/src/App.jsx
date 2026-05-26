import { useEffect, useState } from 'react'
import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'

function App() {
  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)

  useEffect(() => {
    const socket = io(SOCKET_URL)

    socket.on('connect', () => {
      setConnected(true)
      setSocketId(socket.id)
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setSocketId(null)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-100 p-8">
      <h1 className="text-5xl font-bold tracking-tight mb-6">
        Collab Coding Platform
      </h1>

      <div className="flex items-center gap-3 mb-2">
        <span
          className={`w-3 h-3 rounded-full ${
            connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
          }`}
        />
        <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
          {connected ? 'Connected to server' : 'Connecting...'}
        </span>
      </div>

      {socketId && (
        <p className="text-sm text-slate-500 font-mono mt-1">
          socket id: {socketId}
        </p>
      )}
    </div>
  )
}

export default App
