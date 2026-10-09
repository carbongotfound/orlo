import { useState } from "react"

const read = (key: string) => { try { return localStorage.getItem(key) ?? "" } catch { return "" } }

// A text box's contents that survive closing the panel or Orlo itself; cleared when set to "".
export function useDraft(key: string): [string, (next: string | ((cur: string) => string)) => void] {
  const [s, setS] = useState(() => ({ key, v: read(key) }))
  const set = (next: string | ((cur: string) => string)) => setS((cur) => {
    const v = typeof next === "function" ? next(cur.key === key ? cur.v : read(key)) : next
    try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key) } catch { /* private mode */ }
    return { key, v }
  })
  // A new key (another task) starts from that key's own draft.
  return [s.key === key ? s.v : read(key), set]
}
