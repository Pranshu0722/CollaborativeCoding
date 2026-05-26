import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-slate-100">
      <h1 className="text-5xl font-bold tracking-tight mb-4">
        Collab Coding Platform
      </h1>
      <p className="text-slate-400 mb-8">
        Tailwind is alive if this text is grey on a dark background.
      </p>
      <button
        onClick={() => setCount((c) => c + 1)}
        className="px-6 py-3 rounded-lg bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 transition font-medium shadow-lg"
      >
        Count is {count}
      </button>
    </div>
  )
}

export default App
