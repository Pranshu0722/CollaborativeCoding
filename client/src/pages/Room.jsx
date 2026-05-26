import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { io } from 'socket.io-client'
import Editor from '@monaco-editor/react'

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'

function Room() {
  const { roomId } = useParams()
  const socketRef = useRef(null)

  // Flag flipped to true right before we apply a remote update.
  // The next onChange triggered by that setCode is suppressed (won't re-emit).
  const applyingRemote = useRef(false)

  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)
  const [code, setCode] = useState(
    '// Welcome to your collab room\n// Open this URL in another tab and watch the sync happen\n\nfunction hello(name) {\n  return `Hello, ${name}!`\n}\n'
  )

  useEffect(() => {
    const socket = io(SOCKET_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setSocketId(socket.id)
      socket.emit('join-room', roomId)
    })

    socket.on('init-code', (initialCode) => {
      applyingRemote.current = true
      setCode(initialCode)
    })

    socket.on('code-change', (newCode) => {
      applyingRemote.current = true
      setCode(newCode)
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setSocketId(null)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [roomId])

  const handleChange = (value) => {
    const newCode = value ?? ''
    setCode(newCode)

    if (applyingRemote.current) {
      // This change came from a server push, not the local user.
      // Reset the flag and skip the emit — otherwise we'd ping-pong.
      applyingRemote.current = false
      return
    }

    socketRef.current?.emit('code-change', { roomId, code: newCode })
  }

  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-slate-400 hover:text-slate-100 transition">
            ← Home
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">
            Room <span className="font-mono text-indigo-400">{roomId}</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
            }`}
          />
          <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
            {connected ? 'Connected' : 'Connecting…'}
          </span>
          {socketId && (
            <span className="text-slate-500 font-mono">
              · {socketId.slice(0, 8)}
            </span>
          )}
        </div>
      </header>

      <main className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme="vs-dark"
          value={code}
          onChange={handleChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 12 },
          }}
        />
      </main>
    </div>
  )
}

export default Room
