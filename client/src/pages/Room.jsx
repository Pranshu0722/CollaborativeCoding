import { useCallback, useEffect, useRef, useState } from 'react'
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

const LANGUAGE_OPTIONS = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python',     label: 'Python'     },
  { id: 'cpp',        label: 'C++'        },
  { id: 'java',       label: 'Java'       },
  { id: 'go',         label: 'Go'         },
  { id: 'rust',       label: 'Rust'       },
]


function colorIndexForSocket(socketId) {
  let hash = 0
  for (let i = 0; i < socketId.length; i++) {
    hash = (hash * 31 + socketId.charCodeAt(i)) >>> 0
  }
  return hash % AVATAR_COLORS.length
}

function colorForSocket(socketId) {
  return AVATAR_COLORS[colorIndexForSocket(socketId)]
}


// Leading + trailing throttle. First call emits immediately; subsequent calls
// within `intervalMs` coalesce into a single trailing emit. Keeps cursor
// traffic to ~20 ev/s per user even when arrow-keying through a file.
function createCursorThrottle(emit, intervalMs = 50) {
  let lastEmitAt = 0
  let pendingPosition = null
  let timer = null

  function flush() {
    timer = null
    if (pendingPosition !== null) {
      lastEmitAt = Date.now()
      emit(pendingPosition)
      pendingPosition = null
    }
  }

  return (position) => {
    const now = Date.now()
    const elapsed = now - lastEmitAt
    if (elapsed >= intervalMs) {
      lastEmitAt = now
      emit(position)
    } else {
      pendingPosition = position
      if (!timer) timer = setTimeout(flush, intervalMs - elapsed)
    }
  }
}


function Room() {
  const { roomId } = useParams()
  const socketRef = useRef(null)
  const editorRef = useRef(null)
  const applyingRemote = useRef(false)
  // socketId -> { lineNumber, column }. Imperative state — we don't want
  // React re-rendering on every remote keystroke; Monaco's decoration API
  // handles the DOM directly.
  const remoteCursorsRef = useRef(new Map())
  // Monaco's decorations collection. Created once on editor mount, then
  // .set([...]) replaces the visible set atomically on each update.
  const decorationsRef = useRef(null)
  // The monaco namespace itself — captured from onMount because
  // @monaco-editor/react doesn't expose it globally.
  const monacoRef = useRef(null)
  // Password we'll submit on the next connection attempt. Held in a ref
  // so that mutating it doesn't itself trigger a re-render / reconnect.
  const passwordRef = useRef(null)
  // The socket listeners in the connection useEffect close over `language` at
  // the time the socket was created. To filter incoming code-changes by the
  // current language, we read through a ref that always points at the latest.
  const languageRef = useRef('javascript')


  // Cursor position captured right before a remote code-change lands.
  // Restored in handleChange to undo the cursor drag Monaco does when its
  // controlled `value` prop is updated.
  const savedCursorPositionRef = useRef(null)


  // 'probing' | 'password-required' | 'connecting' | 'connected' | 'not-found' | 'error'
  const [status, setStatus] = useState('probing')
  const [errorMessage, setErrorMessage] = useState(null)
  // Incrementing this is the explicit signal to (re)connect the socket.
  const [connectKey, setConnectKey] = useState(0)
  const [passwordInput, setPasswordInput] = useState('')

  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)
  const [users, setUsers] = useState([])
  const [language, setLanguage] = useState('javascript')
  const [code, setCode] = useState(
    '// Loading…\n'
  )

  const [executing, setExecuting] = useState(false)
  const [stdin, setStdin] = useState('')
  const [result, setResult] = useState(null)
  const [runError, setRunError] = useState(null)
  const [activeTab, setActiveTab] = useState('output') // 'output' | 'stdin'

  useEffect(() => {
    languageRef.current = language
  }, [language])

  const renderCursors = useCallback(() => {
    const editor = editorRef.current
    const collection = decorationsRef.current
    const monaco = monacoRef.current
    if (!editor || !collection || !monaco) return

    const decorations = []

    for (const [remoteId, pos] of remoteCursorsRef.current.entries()) {
      const colorIndex = colorIndexForSocket(remoteId)
      decorations.push({
        range: new monaco.Range(
          pos.lineNumber,
          pos.column,
          pos.lineNumber,
          pos.column
        ),
        options: {
          beforeContentClassName: `remote-cursor remote-cursor-${colorIndex}`,
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })
    }
    collection.set(decorations)
  }, [])

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
      } catch {
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

    socket.on('init-room', ({ code: initialCode, language: initialLanguage }) => {
      setStatus('connected')
      setLanguage(initialLanguage)
      setCode((current) => {
        if (current === initialCode) return current
        applyingRemote.current = true
        return initialCode
      })
    })

    socket.on('code-change', ({ code: newCode, language: incomingLang }) => {
      // A peer who hasn't yet received our language-change may still be
      // broadcasting edits authored in the old language. Ignore those.
      if (incomingLang !== languageRef.current) return

      const editor = editorRef.current
      if (editor) {
        savedCursorPositionRef.current = editor.getPosition()
      }
      setCode((current) => {
        if (current === newCode) return current
        applyingRemote.current = true
        return newCode
      })
    })

    socket.on('language-change', ({ language: newLang, code: newCode }) => {
      // Capture cursor before the buffer swaps — same dance as code-change.
      const editor = editorRef.current
      if (editor) {
        savedCursorPositionRef.current = editor.getPosition()
      }

      setLanguage(newLang)
      setResult(null)         // ← add
      setRunError(null)       // ← add
      setCode((prev) => {
        if (prev === newCode) return prev
        applyingRemote.current = true
        return newCode
      })

      // Cursor positions captured under the old language's code don't make sense
      // in the new language's buffer. Drop them; remotes will re-emit on next move.
      remoteCursorsRef.current.clear()
      renderCursors()
    })


    socket.on('room-users', (list) => {
      setUsers(list)
      // Prune cursors for users no longer in the room.
      const presentIds = new Set(list.map((u) => u.socketId))
      let changed = false
      for (const id of remoteCursorsRef.current.keys()) {
        if (!presentIds.has(id)) {
          remoteCursorsRef.current.delete(id)
          changed = true
        }
      }
      if (changed) renderCursors()
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

    socket.on('cursor-move', ({ socketId: remoteId, position }) => {
      if (
        !position ||
        typeof position.lineNumber !== 'number' ||
        typeof position.column !== 'number' ||
        position.lineNumber < 1 ||
        position.column < 1
      ) {
        return
      }
      remoteCursorsRef.current.set(remoteId, position)
      renderCursors()
    })

    socket.on('execution-result', (data) => {
      setResult(data)
      setRunError(null)
      setActiveTab('output')
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setSocketId(null)
      setUsers([])
      remoteCursorsRef.current.clear()
      renderCursors()
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [connectKey, roomId, renderCursors])

  const handleChange = (value) => {
    const newCode = value ?? ''
    setCode(newCode)

    if (applyingRemote.current) {
      // Undo the cursor drag Monaco does when executeEdits replaces the model.
      // We keep applyingRemote=true across setPosition so the cursor listener
      // doesn't emit the shifted-then-restored intermediate position.
      const editor = editorRef.current
      if (editor && savedCursorPositionRef.current) {
        editor.setPosition(savedCursorPositionRef.current)
        savedCursorPositionRef.current = null
      }
      applyingRemote.current = false
      return
    }

    socketRef.current?.emit('code-change', { roomId, code: newCode, language: languageRef.current })
  }

  const handleRun = async () => {
    if (executing || !connected || !socketId) return

    setExecuting(true)
    setRunError(null)

    try {
      const res = await fetch(`${SERVER_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          language: languageRef.current,
          code,
          stdin,
          socketId,
        }),
      })

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}))
        const wait = Math.ceil((data.waitMs ?? 1000) / 100) / 10
        setRunError(`Cooldown — try again in ${wait}s.`)
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (data.error === 'daily-limit-reached') {
          setRunError("Daily execution limit reached. Try again tomorrow.")
        } else {
          setRunError(data.error || `Run failed (${res.status})`)
        }
      }else {
        const data = await res.json()
        setResult(data)
        setActiveTab('output')
      }
    } catch {
      setRunError('Network error — could not reach server.')
    } finally {
      setExecuting(false)
    }
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

          <div className="flex items-center gap-3 text-sm">
            <select
              value={language}
              onChange={(e) => {
                socketRef.current?.emit('language-change', {
                  roomId,
                  language: e.target.value,
                })
              }}
              disabled={status !== 'connected'}
              className="bg-slate-800 text-slate-100 text-sm rounded px-2 py-1 border border-slate-700 focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Programming language"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>

            <button
              onClick={handleRun}
              disabled={executing || !connected}
              className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition text-white font-medium text-sm"
            >
              {executing ? 'Running…' : 'Run'}
            </button>

            <div className="flex items-center gap-2">
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

      <main className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-0">
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={code}
            onChange={handleChange}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              monacoRef.current = monaco
              decorationsRef.current = editor.createDecorationsCollection([])

              const emitCursor = createCursorThrottle((position) => {
                socketRef.current?.emit('cursor-move', { roomId, position })
              }, 50)

              editor.onDidChangeCursorPosition((e) => {
                if (applyingRemote.current) return
                emitCursor({
                  lineNumber: e.position.lineNumber,
                  column: e.position.column,
                })
              })

              editor.onDidChangeModelContent(() => {
                renderCursors()
              })

              renderCursors()
            }}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12 },
              readOnly: status !== 'connected',
            }}
          />
        </div>

        <div className="h-72 border-t border-slate-800 flex flex-col bg-slate-900">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveTab('output')}
                className={`px-3 py-1 rounded text-sm font-medium transition ${
                  activeTab === 'output'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Output
              </button>
              <button
                onClick={() => setActiveTab('stdin')}
                className={`px-3 py-1 rounded text-sm font-medium transition ${
                  activeTab === 'stdin'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Stdin{stdin ? ` (${stdin.length})` : ''}
              </button>
            </div>

            {result && activeTab === 'output' && (
              <div className="text-xs text-slate-400">
                <span>Run by </span>
                <span className="text-slate-200 font-medium">{result.runBy.name}</span>
                <span> · {result.executionTimeMs}ms · exit {result.exitCode}</span>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            {activeTab === 'output' ? (
              runError ? (
                <div className="p-4 text-rose-400 font-mono text-sm">{runError}</div>
              ) : !result ? (
                <div className="p-4 text-slate-500 italic text-sm">
                  No runs yet. Hit Run to execute.
                </div>
              ) : (
                <div className="p-3 font-mono text-sm">
                  {result.stdout && (
                    <pre className="text-slate-100 whitespace-pre-wrap">
                      {result.stdout}
                    </pre>
                  )}
                  {result.stderr && (
                    <pre className="text-rose-400 whitespace-pre-wrap mt-2">
                      {result.stderr}
                    </pre>
                  )}
                  {!result.stdout && !result.stderr && (
                    <div className="text-slate-500 italic">(empty output)</div>
                  )}
                </div>
              )
            ) : (
              <textarea
                value={stdin}
                onChange={(e) => setStdin(e.target.value)}
                placeholder="Input piped to your program on stdin. Local to your tab — not synced."
                className="w-full h-full p-3 bg-slate-900 text-slate-100 font-mono text-sm focus:outline-none resize-none"
              />
            )}
          </div>
        </div>
      </main>

    </div>
  )
}

export default Room
