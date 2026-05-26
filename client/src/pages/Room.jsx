import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { io } from 'socket.io-client'
import Editor from '@monaco-editor/react'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'
const NAME_STORAGE_KEY = 'collab:userName'

function passwordSessionKey(roomId) {
  return `collab:roomPassword:${roomId}`
}

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
  const applyingRemote = useRef(false)
  // Password we'll submit on the next connection attempt. Held in a ref
  // so that mutating it doesn't itself trigger a re-render / reconnect.
  const passwordRef = useRef(null)

  // 'probing' | 'password-required' | 'connecting' | 'connected' | 'not-found' | 'error'
  const [status, setStatus] = useState('probing')
  const [errorMessage, setErrorMessage] = useState(null)
  // Incrementing this is the explicit signal to (re)connect the socket.
  const [connectKey, setConnectKey] = useState(0)
  const [passwordInput, setPasswordInput] = useState('')

  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)
  const [users, setUsers] = useState([])
  const [code, setCode] = useState(
    '// Welcome to your collab room\n// Open this URL in another tab and watch the sync happen\n\nfunction hello(name) {\n  return `Hello, ${name}!`\n}\n'
  )

  // Probe the room before connecting. Determines whether to connect
  // immediately (public / cached password) or show a password prompt first.
  useEffect(() => {
    let cancelled = false

    setStatus('probing')
    setErrorMessage(null)
    setUsers([])
    setConnected(false)
    setSocketId(null)
    setPasswordInput('')
    passwordRef.current = null

    async function probe() {
      try {
        const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}`)
        if (!res.ok) throw new Error(`probe failed (${res.status})`)
        const data = await res.json()
        if (cancelled) return

        if (!data.exists) {
          setStatus('not-found')
          return
        }

        if (data.requiresPassword) {
          const cached = sessionStorage.getItem(passwordSessionKey(roomId))
          if (cached) {
            passwordRef.current = cached
            setStatus('connecting')
            setConnectKey((k) => k + 1)
          } else {
            setStatus('password-required')
          }
        } else {
          passwordRef.current = null
          setStatus('connecting')
          setConnectKey((k) => k + 1)
        }
      } catch (err) {
        if (cancelled) return
        setErrorMessage('Failed to load room')
        setStatus('error')
      }
    }

    probe()
    return () => {
      cancelled = true
    }
  }, [roomId])

  // Actual socket connection. Runs only after connectKey > 0, and re-runs
  // whenever connectKey increments (e.g. after submitting a password).
  useEffect(() => {
    if (connectKey === 0) return

    const socket = io(SERVER_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setSocketId(socket.id)
      const name = localStorage.getItem(NAME_STORAGE_KEY) || 'Anonymous'
      socket.emit('join-room', {
        roomId,
        name,
        ...(passwordRef.current ? { password: passwordRef.current } : {}),
      })
    })

    socket.on('init-code', (initialCode) => {
      setStatus('connected')
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

    socket.on('join-error', ({ reason }) => {
      // Server rejected our join. Tear down the socket and route the user
      // to whichever state matches the rejection reason.
      socket.disconnect()

      if (reason === 'wrong-password' || reason === 'password-required') {
        sessionStorage.removeItem(passwordSessionKey(roomId))
        passwordRef.current = null
        setPasswordInput('')
        setErrorMessage(
          reason === 'wrong-password' ? 'Incorrect password' : null
        )
        setStatus('password-required')
      } else if (reason === 'not-found') {
        setStatus('not-found')
      } else {
        setErrorMessage('Could not join room')
        setStatus('error')
      }
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
  }, [connectKey, roomId])

  const handleChange = (value) => {
    const newCode = value ?? ''
    setCode(newCode)

    if (applyingRemote.current) {
      applyingRemote.current = false
      return
    }

    socketRef.current?.emit('code-change', { roomId, code: newCode })
  }

  const handlePasswordSubmit = (e) => {
    e.preventDefault()
    const pw = passwordInput
    if (!pw) return
    passwordRef.current = pw
    sessionStorage.setItem(passwordSessionKey(roomId), pw)
    setErrorMessage(null)
    setStatus('connecting')
    setConnectKey((k) => k + 1)
  }

  // ---------- Render branches ----------

  if (status === 'probing') {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-900 text-slate-400">
        Loading room…
      </div>
    )
  }

  if (status === 'not-found') {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-slate-900 text-slate-100 p-8">
        <h1 className="text-2xl font-semibold">Room not found</h1>
        <p className="text-slate-400">
          The room{' '}
          <span className="font-mono text-indigo-400">{roomId}</span>{' '}
          doesn't exist.
        </p>
        <Link
          to="/"
          className="text-indigo-400 hover:text-indigo-300 transition"
        >
          ← Back to home
        </Link>
      </div>
    )
  }

  if (status === 'password-required') {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-100 p-8">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-semibold mb-2">Password required</h1>
            <p className="text-slate-400 text-sm">
              Room{' '}
              <span className="font-mono text-indigo-400">{roomId}</span>{' '}
              is private.
            </p>
          </div>

          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter room password"
              autoFocus
              autoComplete="current-password"
              className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={!passwordInput}
              className="w-full px-6 py-3 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium"
            >
              Join room
            </button>
            {errorMessage && (
              <p
                className="text-sm text-rose-400 text-center"
                role="alert"
              >
                {errorMessage}
              </p>
            )}
          </form>

          <div className="text-center">
            <Link
              to="/"
              className="text-slate-500 hover:text-slate-300 transition text-sm"
            >
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-slate-900 text-slate-100 p-8">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-slate-400">{errorMessage || 'Please try again.'}</p>
        <Link
          to="/"
          className="text-indigo-400 hover:text-indigo-300 transition"
        >
          ← Back to home
        </Link>
      </div>
    )
  }

  // status === 'connecting' or 'connected'
  return (
    <div className="h-screen flex flex-col bg-slate-900 text-slate-100">
      <header className="flex flex-col gap-2 px-6 py-3 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="text-slate-400 hover:text-slate-100 transition"
            >
              ← Home
            </Link>
            <h1 className="text-lg font-semibold tracking-tight">
              Room{' '}
              <span className="font-mono text-indigo-400">{roomId}</span>
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
            readOnly: status !== 'connected',
          }}
        />
      </main>
    </div>
  )
}

export default Room
