import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open as pickFolder } from "@tauri-apps/plugin-dialog"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { tags as t } from "@lezer/highlight"
import { ChevronRight, File, FilePlus, Folder, FolderOpen, RefreshCw, Sparkles, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

// A small editor for a project folder: file tree, tabs, syntax highlighting, Ctrl/Cmd+S to save, and a box that
// hands a change to an agent which then works in this same folder. Files come from list_dir/read_text/write_text in lib.rs.

type Entry = { name: string; dir: boolean }
type Cli = { name: string; path: string | null }

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "oklch(0.62 0.17 300)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "oklch(0.62 0.14 150)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "oklch(0.66 0.15 55)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "oklch(0.64 0.13 240)" },
  { tag: [t.typeName, t.className, t.tagName], color: "oklch(0.64 0.13 200)" },
  { tag: [t.attributeName, t.propertyName], color: "oklch(0.62 0.1 270)" },
  { tag: t.heading, fontWeight: "600" },
])

const label = (name: string) => <><AgentIcon name={name} />{name[0].toUpperCase() + name.slice(1)}</>

const call = async <T,>(cmd: string, args: Record<string, unknown>): Promise<T | undefined> => {
  try { return await invoke<T>(cmd, args) } catch (e) { toast.error(String(e)) }
}

export function CodeView({ root, setRoot, clis, onAsk, tick }: {
  root: string | null; setRoot: (r: string | null) => void; clis: Cli[]
  onAsk: (prompt: string, agent: string) => void
  /** Bumped when an agent run ends, so the tree and untouched files reload from disk. */
  tick: number
}) {
  const sep = root?.includes("\\") ? "\\" : "/"
  const join = (a: string, b: string) => (a.endsWith(sep) ? a + b : a + sep + b)
  const rel = (p: string) => (root && p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p)

  const [dirs, setDirs] = useState<Record<string, Entry[]>>({})
  const [openDirs, setOpenDirs] = useState<string[]>([])
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dirty, setDirty] = useState<string[]>([])
  const [ask, setAsk] = useState("")
  const installed = clis.filter((c) => c.path)
  const [picked, setAgent] = useState("")
  const agent = installed.some((c) => c.name === picked) ? picked : installed[0]?.name ?? ""
  const [naming, setNaming] = useState(false)

  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const states = useRef(new Map<string, EditorState>())
  const saved = useRef(new Map<string, string>())
  const activeRef = useRef(active)
  activeRef.current = active

  const load = async (dir: string) => {
    const es = await call<Entry[]>("list_dir", { path: dir })
    if (es) setDirs((d) => ({ ...d, [dir]: es }))
  }
  const save = async (path: string) => {
    const s = states.current.get(path)
    if (!s) return
    const text = s.doc.toString()
    // Resolves null once written; undefined means it failed and a toast already said why.
    if ((await call("write_text", { path, text })) === undefined) return
    saved.current.set(path, text)
    setDirty((d) => d.filter((x) => x !== path))
  }

  const makeState = (path: string, text: string) => {
    const c = new Compartment()
    const s = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), indentOnInput(), bracketMatching(),
        syntaxHighlighting(highlight),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { save(path); return true } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
        c.of([]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          states.current.set(path, u.state)
          const isDirty = u.state.doc.toString() !== saved.current.get(path)
          setDirty((d) => (isDirty ? (d.includes(path) ? d : [...d, path]) : d.filter((x) => x !== path)))
        }),
      ],
    })
    LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop() ?? "")?.load().then((l) => {
      const cur = states.current.get(path)
      if (!cur) return
      const next = cur.update({ effects: c.reconfigure(l) }).state
      states.current.set(path, next)
      if (activeRef.current === path) view.current?.setState(next)
    })
    return s
  }

  const openFile = async (path: string) => {
    if (!states.current.has(path)) {
      const text = await call<string>("read_text", { path })
      if (text === undefined) return
      saved.current.set(path, text)
      states.current.set(path, makeState(path, text))
    }
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    setActive(path)
  }
  const closeTab = (path: string) => {
    if (dirty.includes(path) && !confirm(`Close ${rel(path)} without saving?`)) return
    states.current.delete(path)
    setDirty((d) => d.filter((x) => x !== path))
    const rest = tabs.filter((x) => x !== path)
    setTabs(rest)
    if (active === path) setActive(rest[rest.length - 1] ?? null)
  }

  // One EditorView; switching tabs swaps in that file's state, so undo history and cursor stay per file.
  useEffect(() => {
    if (!host.current) return
    if (!view.current) view.current = new EditorView({ parent: host.current })
    const s = active ? states.current.get(active) : undefined
    if (s) view.current.setState(s)
  }, [active, root])
  useEffect(() => () => { view.current?.destroy(); view.current = null }, [root])

  // New folder: start over.
  useEffect(() => {
    states.current.clear(); saved.current.clear()
    setTabs([]); setActive(null); setDirty([]); setDirs({}); setOpenDirs([])
    if (root) load(root)
  }, [root])

  // An agent finished: reread what's on disk, but never throw away unsaved edits.
  useEffect(() => {
    if (!tick || !root) return
    for (const d of [root, ...openDirs]) load(d)
    for (const path of tabs) {
      if (dirty.includes(path)) continue
      invoke<string>("read_text", { path }).then((text) => {
        if (text === saved.current.get(path)) return
        saved.current.set(path, text)
        const s = makeState(path, text)
        states.current.set(path, s)
        if (activeRef.current === path) view.current?.setState(s)
      }).catch(() => closeTab(path))
    }
  }, [tick])

  const choose = async () => {
    if (dirty.length && !confirm(`Open another folder and lose unsaved changes in ${dirty.map(rel).join(", ")}?`)) return
    const dir = await pickFolder({ directory: true, title: "Open a project folder" })
    if (typeof dir === "string") setRoot(dir)
  }
  const send = () => {
    if (!ask.trim() || !agent) return
    const where = active ? `\n\nThe file open in the editor is ${rel(active)}.` : ""
    onAsk(ask.trim() + where, agent)
    setAsk("")
  }
  const newFile = async (name: string) => {
    setNaming(false)
    if (!root || !name.trim()) return
    const path = join(root, name.trim())
    if ((await call("write_text", { path, text: "" })) === undefined) return
    await load(root)
    openFile(path)
  }

  if (!root) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia><img src="/mascot.png" alt="" className="size-20" draggable={false} /></EmptyMedia>
          <EmptyTitle>Code in Orlo</EmptyTitle>
          <EmptyDescription>Open a project folder to browse and edit its files, then ask any of your agents to work on it right here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button size="sm" onClick={choose}><FolderOpen />Open folder</Button></EmptyContent>
      </Empty>
    )
  }

  const tree = (dir: string, depth: number): React.ReactNode =>
    (dirs[dir] ?? []).map((en) => {
      const path = join(dir, en.name)
      const isOpen = openDirs.includes(path)
      return (
        <div key={path}>
          <button
            className={cn("flex w-full items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left text-sm hover:bg-muted", active === path && "bg-muted font-medium")}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              if (!en.dir) return void openFile(path)
              setOpenDirs((o) => (isOpen ? o.filter((x) => x !== path) : [...o, path]))
              if (!isOpen && !dirs[path]) load(path)
            }}
          >
            {en.dir ? <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} /> : <span className="w-3.5 shrink-0" />}
            {en.dir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{en.name}</span>
          </button>
          {en.dir && isOpen && tree(path, depth + 1)}
        </div>
      )
    })

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex h-9 items-center gap-1 border-b pr-1 pl-3">
          <span className="truncate text-xs font-medium" title={root}>{root.split(/[\\/]/).filter(Boolean).pop()}</span>
          <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="New file" onClick={() => setNaming(true)}><FilePlus /></Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Reload files" onClick={() => [root, ...openDirs].forEach(load)}><RefreshCw /></Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Open another folder" onClick={choose}><FolderOpen /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {naming && (
            <input
              autoFocus placeholder="file name, e.g. src/app.ts" className="mb-1 w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
              onBlur={(e) => newFile(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); setNaming(false) } }}
            />
          )}
          {tree(root, 0)}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b">
          {tabs.map((p) => (
            <div key={p} className={cn("group flex shrink-0 items-center gap-1 border-r pr-1 pl-3 text-xs", p === active ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground")}>
              <button className="max-w-48 truncate" title={rel(p)} onClick={() => setActive(p)}>{p.split(/[\\/]/).pop()}</button>
              <button className="grid size-4 place-items-center rounded hover:bg-muted" aria-label={`Close ${rel(p)}`} onClick={() => closeTab(p)}>
                {dirty.includes(p) ? <span className="size-1.5 rounded-full bg-foreground group-hover:hidden" /> : null}
                <X className={cn("size-3", dirty.includes(p) && "hidden group-hover:block")} />
              </button>
            </div>
          ))}
          {active && dirty.includes(active) && (
            <Button variant="ghost" size="xs" className="my-auto mr-2 ml-auto shrink-0" onClick={() => save(active)}>Save</Button>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={host} className={cn("orlo-code absolute inset-0", !active && "invisible")} />
          {!active && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Pick a file on the left. Ctrl/⌘+S saves.</p>}
        </div>
        <div className="shrink-0 border-t p-3">
          <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
            <Textarea
              value={ask} onChange={(e) => setAsk(e.target.value)} rows={1}
              placeholder={installed.length ? "Ask an agent to change this project… (Enter to send)" : "Install an agent CLI (claude, codex, grok, hermes or gemini) to ask for changes"}
              className="max-h-32 min-h-8 w-full resize-none border-0 p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }}
            />
            <Select value={agent} onValueChange={(v) => setAgent(String(v))} items={installed.map((c) => ({ value: c.name, label: label(c.name) }))}>
              <SelectTrigger size="sm" className="w-32"><SelectValue placeholder="Agent" /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {installed.map((c) => <SelectItem key={c.name} value={c.name}>{label(c.name)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={!ask.trim() || !agent} onClick={send}><Sparkles />Ask</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
