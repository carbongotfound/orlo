export type LineChange = "a" | "m" | "d"

// Which lines of `now` differ from `head`, for the editor's change gutter: added, modified, or
// "d" on the line just after some deleted ones. Lines are 1-based. Check: node scripts/check-linediff.mjs
export function lineChanges(head: string, now: string): [line: number, kind: LineChange][] {
  const a = head.split("\n"), b = now.split("\n")
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const n = ea - s, m = eb - s
  const out: [number, LineChange][] = []
  // ponytail: plain LCS table over the changed middle; past ~2M cells it just marks the middle modified.
  if (n * m > 2_000_000) {
    for (let j = s; j < eb; j++) out.push([j + 1, "m"])
    return out
  }
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
  let i = 0, j = 0, del = 0
  let ins: number[] = []
  // Deleted lines next to inserted ones count as modified.
  const flush = () => {
    ins.forEach((line, k) => out.push([line, k < del ? "m" : "a"]))
    if (del > ins.length) out.push([Math.min(s + j + 1, b.length), "d"])
    del = 0
    ins = []
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) { flush(); i++; j++ }
    else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { ins.push(s + j + 1); j++ }
    else { del++; i++ }
  }
  flush()
  return out
}
