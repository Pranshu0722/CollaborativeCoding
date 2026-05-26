import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { io } from 'socket.io-client'
import Editor from '@monaco-editor/react'

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'
const NAME_STORAGE_KEY = 'collab:userName'

const AVATAR_COLORS = [
  'bg-indigo-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-pink-400',
  'bg-cyan-400',
  'bg-violet-400',
  'bg-orange-400',
  'bg-rose-400',
]

function colorForSocket(socketId) {
  let hash = 0
  for (let i = 0; i < socketId.length; i++) {
    hash = (hash * 31 + socketId.charCodeAt(i)) >>> 0
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}


function Room() {
  const { roomId } = useParams()
  const socketRef = useRef(null)

  // Flag flipped to true right before we apply a remote update.
  // The next onChange triggered by that setCode is suppressed (won't re-emit).
  const applyingRemote = useRef(false)

  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)
  const [users, setUsers] = useState([])
  const [code, setCode] = useState(
    '// Welcome to your collab room\n// Open this URL in another tab and watch the sync happen\n\nfunction hello(name) {\n  return `Hello, ${name}!`\n}\n'
  )

  useEffect(() => {
    const socket = io(SOCKET_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setSocketId(socket.id)
      const name = localStorage.getItem(NAME_STORAGE_KEY) || 'Anonymous'
      socket.emit('join-room', { roomId, name })
    })

        socket.on('init-code', (initialCode) => {
      setCode((current) => {
        if (current === initialCode) return current
        applyingRemote.current = true
        return initialCode
      })
    })

    socket.on('code-change', (newCode) => {
      setCode((current) => {
        if (current === newCode) return current
        applyingRemote.current = true
        return newCode
      })
    })

    socket.on('room-users', (list) => {
      setUsers(list)
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setSocketId(null)
      setUsers([])
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
      <header className="flex flex-col gap-2 px-6 py-3 border-b border-slate-800">
        <div className="flex items-center justify-between">
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
          </div>
        </div>

        {users.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="shrink-0">In this room:</span>
            <div className="flex items-center gap-2 flex-wrap">
                            {users.map((u) => {
                const isYou = u.socketId === socketId
                return (
                  <span
                    key={u.socketId}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 ${
                      isYou ? 'ring-1 ring-indigo-400' : ''
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${colorForSocket(u.socketId)}`}
                      aria-hidden="true"
                    />
                    {u.name}
                    {isYou && <span className="text-slate-500"> (you)</span>}
                  </span>
                )
              })}
            </div>
            <span className="text-slate-500 shrink-0">({users.length})</span>
          </div>
        )}
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
