import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const NAME_STORAGE_KEY = 'collab:userName'
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'

// Per-room password is stashed in sessionStorage so the immediate navigate
// to /room/<id> can join without re-prompting. Tab-scoped on purpose:
// not leaked to other tabs, gone when the tab closes.
function passwordSessionKey(roomId) {
  return `collab:roomPassword:${roomId}`
}

function Landing() {
  const navigate = useNavigate()
  const [name, setName] = useState(
    () => localStorage.getItem(NAME_STORAGE_KEY) || ''
  )
  const [password, setPassword] = useState('')
  const [joinId, setJoinId] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    localStorage.setItem(NAME_STORAGE_KEY, name)
  }, [name])

  const canProceed = name.trim().length > 0

  const handleCreate = async () => {
    if (!canProceed || creating) return
    setError(null)
    setCreating(true)
    const newId = crypto.randomUUID().slice(0, 8)
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: newId,
          ...(password.length > 0 ? { password } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `request failed (${res.status})`)
      }
      if (password.length > 0) {
        sessionStorage.setItem(passwordSessionKey(newId), password)
      }
      navigate(`/room/${newId}`)
    } catch (err) {
      setError(err.message || 'Failed to create room')
      setCreating(false)
    }
  }

  const handleJoin = (e) => {
    e.preventDefault()
    if (!canProceed) return
    const trimmed = joinId.trim()
    if (trimmed) navigate(`/room/${trimmed}`)
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-100 p-8">
      <h1 className="text-5xl font-bold tracking-tight mb-2">
        Collab Coding Platform
      </h1>
      <p className="text-slate-400 mb-10">
        Spin up a room and code together in real time.
      </p>

      <div className="w-full max-w-md space-y-6">
        <div>
          <label htmlFor="name" className="block text-sm text-slate-400 mb-2">
            Your name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Pranshu"
            className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="p-4 rounded-lg bg-slate-800/40 border border-slate-800 space-y-3">
          <div>
            <label htmlFor="password" className="block text-sm text-slate-400 mb-2">
              Room password{' '}
              <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank for a public room"
              className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              autoComplete="new-password"
            />
            <p className="text-xs text-slate-500 mt-1.5">
              If set, others will need this to join the room.
            </p>
          </div>

          <button
            onClick={handleCreate}
            disabled={!canProceed || creating}
            className="w-full px-6 py-3 rounded-lg bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium shadow-lg"
          >
            {creating ? 'Creating…' : 'Create new room'}
          </button>

          {error && (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 text-slate-500 text-sm">
          <div className="flex-1 h-px bg-slate-800" />
          <span>or join an existing one</span>
          <div className="flex-1 h-px bg-slate-800" />
        </div>

        <form onSubmit={handleJoin} className="flex gap-2">
          <input
            type="text"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            placeholder="Enter room id"
            className="flex-1 px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!canProceed || !joinId.trim()}
            className="px-6 py-3 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium"
          >
            Join
          </button>
        </form>
      </div>
    </div>
  )
}

export default Landing
