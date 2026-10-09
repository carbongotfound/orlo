import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { ask as askDialog, open as pickFolder } from "@tauri-apps/plugin-dialog"
import { Compartment, EditorState } from "@codemirror/state"
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting,
} from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { tags as t } from "@lezer/highlight"
import {
  ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, MessageSquarePlus, PanelBottom, PanelLeft, PanelRight,
  Pencil, Play, Plus, RefreshCw, Search, Send, Square, SquareTerminal, Trash2, Undo2, X,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"
import { ACCESS, AGENT_COMMANDS, BUILTIN, EFFORTS, MAC, MOD, MODELS, noPick, type Pick } from "@/agents"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import { Command, CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The Code view: project folders with a file tree, an editor, a terminal and an agent chat that works in the folder.
// Files go through list_dir/read_text/write_text/... in lib.rs, which refuse the agents' sign-in folders.
// Chats are rows with kind "chat", so runs, resume, stop and notifications reuse the task machinery,
// but they never show up as tasks.

type Entry = { name: string; dir: boolean }
type Cli = { name: string; path: string | null }
type Ev = { task_id: number; kind: string; text: string }
type Chat = { id: number; title: string; agent: string | null; session_id: string | null; cwd: string | null; model: string; effort: string; access: string }
type Shared = {
  clis: Cli[]; chats: Chat[]; running: number[]; refresh: () => void
  activity: (ev: Ev, agent: string) => React.ReactNode
  picker: (v: Pick, set: (p: Pick) => void) => React.ReactNode
}

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

const title = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const parent = (p: string) => p.replace(/[\\/][^\\/]+[\\/]?$/, "")
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g

const call = async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T | undefined> => {
  try { return await invoke<T>(cmd, args) } catch (e) { toast.error(String(e)) }
}
const sure = (msg: string) => askDialog(msg, { title: "Orlo", kind: "warning" })

// Per-device conveniences (open projects, last picks); losing them is harmless.
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

// Unsaved files across every open project; closing the window asks first.
const unsaved = new Map<string, number>()
getCurrentWindow().onCloseRequested(async (e) => {
  const n = [...unsaved.values()].reduce((a, b) => a + b, 0)
  if (n && !(await sure(`${n} file${n > 1 ? "s have" : " has"} unsaved changes in the Code view. Quit anyway?`))) e.preventDefault()
})

// The backend runs one terminal command at a time; this is the project that owns its output.
let termOwner: string | null = null

// Task bookkeeping (verdicts, a clean exit) means nothing in a conversation.
const chatEvent = (ev: Ev) => ev.kind !== "verdict" && !(ev.kind === "end" && ev.text === "Exited with code 0.")

export function CodeWorkspace({ visible, focus, ...shared }: Shared & { visible: boolean; focus: { cwd: string; id: number; n: number } | null }) {
  const [projects, setProjects] = useState<string[]>(() => {
    const old = store.get<string | null>("orlo.codeRoot", null)
    return store.get("orlo.codeProjects", old ? [old] : [])
  })
  const [active, setActive] = useState<string | null>(() => store.get("orlo.codeActive", projects[0] ?? null))
  useEffect(() => store.set("orlo.codeProjects", projects), [projects])
  useEffect(() => store.set("orlo.codeActive", active), [active])
  const current = active && projects.includes(active) ? active : projects[0] ?? null

  const add = (dir: string) => { setProjects((ps) => (ps.includes(dir) ? ps : [...ps, dir])); setActive(dir) }
  const choose = async () => {
    const dir = await pickFolder({ directory: true, title: "Open a project folder" })
    if (typeof dir === "string") add(dir)
  }
  const close = async (dir: string) => {
    if (unsaved.get(dir) && !(await sure(`${base(dir)} has unsaved changes. Close it anyway?`))) return
    unsaved.delete(dir)
    setProjects((ps) => ps.filter((p) => p !== dir))
  }
  useEffect(() => { if (focus) add(focus.cwd) }, [focus])

  if (!projects.length) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia><img src="/mascot.png" alt="" className="size-20" draggable={false} /></EmptyMedia>
          <EmptyTitle>Code in Orlo</EmptyTitle>
          <EmptyDescription>Open a project folder to edit its files, run commands, and chat with any of your agents while they work on it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button size="sm" onClick={choose}><FolderOpen />Open folder</Button></EmptyContent>
      </Empty>
    )
  }

  const strip = (
    <div className="flex min-w-0 items-stretch overflow-x-auto">
      {projects.map((p) => (
        <div key={p} className={cn("group flex shrink-0 items-center gap-1 border-r pr-1 pl-3 text-xs", p === current ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          <button className="flex items-center gap-1.5" title={p} onClick={() => setActive(p)}><FolderOpen className="size-3.5" />{base(p)}</button>
          <button className="grid size-4 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted" aria-label={`Close ${base(p)}`} onClick={() => close(p)}><X className="size-3" /></button>
        </div>
      ))}
      <Tip label="Open another project">
        <Button variant="ghost" size="icon-xs" className="mx-1 my-auto text-muted-foreground" aria-label="Open another project" onClick={choose}><Plus /></Button>
      </Tip>
    </div>
  )

  // Every project stays mounted, so switching keeps its tabs, unsaved edits, terminal and chat.
  return (
    <>
      {projects.map((p) => (
        <Project key={p} root={p} shown={p === current} visible={visible && p === current} strip={strip} {...shared}
          focusChat={focus?.cwd === p ? focus : null} />
      ))}
    </>
  )
}

function Tip({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Project({ root, shown, visible, strip, clis, chats, running, refresh, activity, picker, focusChat }: Shared & {
  root: string; shown: boolean; visible: boolean; strip: React.ReactNode; focusChat: { id: number; n: number } | null
}) {
  const sep = root.includes("\\") ? "\\" : "/"
  const join = (a: string, b: string) => (a.endsWith(sep) ? a + b : a + sep + b)
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p)

  // ---- files and editor ----
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({})
  const [openDirs, setOpenDirs] = useState<string[]>([])
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [dirty, setDirty] = useState<string[]>([])
  const [naming, setNaming] = useState<{ dir: string; folder: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 })
  const [langs, setLangs] = useState<Record<string, string>>({})
  const [panels, setPanels] = useState(() => store.get("orlo.codePanels", { tree: true, term: false, chat: true }))
  useEffect(() => store.set("orlo.codePanels", panels), [panels])
  const [quick, setQuick] = useState(false)
  const [files, setFiles] = useState<string[]>([])

  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const states = useRef(new Map<string, EditorState>())
  const saved = useRef(new Map<string, string>())
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => { unsaved.set(root, dirty.length) }, [dirty, root])

  const load = async (dir: string) => {
    const es = await call<Entry[]>("list_dir", { path: dir })
    if (es) setDirs((d) => ({ ...d, [dir]: es }))
  }
  const reloadTree = () => [root, ...openDirs].forEach(load)
  const indexFiles = async () => setFiles((await call<string[]>("list_files", { root })) ?? [])

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
    const lang = new Compartment()
    const s = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
        syntaxHighlighting(highlight), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // Words already in the file complete everywhere, on top of whatever the language offers.
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { save(path); return true } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
        ]),
        lang.of([]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            const m = u.state.selection.main, line = u.state.doc.lineAt(m.head)
            setCursor({ line: line.number, col: m.head - line.from + 1, sel: m.to - m.from })
          }
          if (!u.docChanged) return
          states.current.set(path, u.state)
          const isDirty = u.state.doc.toString() !== saved.current.get(path)
          setDirty((d) => (isDirty ? (d.includes(path) ? d : [...d, path]) : d.filter((x) => x !== path)))
        }),
      ],
    })
    const desc = LanguageDescription.matchFilename(languages, base(path))
    setLangs((l) => ({ ...l, [path]: desc?.name ?? "Plain text" }))
    desc?.load().then((l) => {
      const cur = states.current.get(path)
      if (!cur) return
      const next = cur.update({ effects: lang.reconfigure(l) }).state
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
  const dropTab = (path: string) => {
    states.current.delete(path)
    setDirty((d) => d.filter((x) => x !== path))
    setTabs((ts) => {
      const rest = ts.filter((x) => x !== path)
      if (activeRef.current === path) setActive(rest[rest.length - 1] ?? null)
      return rest
    })
  }
  const closeTab = async (path: string) => {
    if (dirty.includes(path) && !(await sure(`Close ${rel(path)} without saving?`))) return
    dropTab(path)
  }

  // One EditorView; switching tabs swaps in that file's state, so undo history and cursor stay per file.
  useEffect(() => {
    if (!host.current) return
    if (!view.current) view.current = new EditorView({ parent: host.current })
    const s = active ? states.current.get(active) : undefined
    if (s) {
      view.current.setState(s)
      const m = s.selection.main, line = s.doc.lineAt(m.head)
      setCursor({ line: line.number, col: m.head - line.from + 1, sel: m.to - m.from })
      if (visible) view.current.focus()
    }
  }, [active])
  useEffect(() => () => { view.current?.destroy(); view.current = null; unsaved.delete(root) }, [])
  useEffect(() => { load(root) }, [root])

  // After an agent run or a terminal command: reread what's on disk, but never throw away unsaved edits.
  const syncFromDisk = () => {
    reloadTree()
    loadChanges()
    for (const path of tabs) {
      if (dirty.includes(path)) continue
      invoke<string>("read_text", { path }).then((text) => {
        if (text === saved.current.get(path)) return
        saved.current.set(path, text)
        const s = makeState(path, text)
        states.current.set(path, s)
        if (activeRef.current === path) view.current?.setState(s)
      }).catch(() => dropTab(path))
    }
  }
  const syncRef = useRef(syncFromDisk)
  syncRef.current = syncFromDisk

  // ---- git changes: what the agent (or you) changed since the last commit ----
  const [side, setSide] = useState<"files" | "changes">("files")
  const [changes, setChanges] = useState<[status: string, path: string][] | null>(null)
  const [diff, setDiff] = useState<{ path: string; status: string; text: string } | null>(null)
  const loadChanges = async () => {
    try {
      const out = await invoke<string>("git", { root, op: "status" })
      setChanges(out.split("\n").filter(Boolean).map((l) => [l.slice(0, 2), l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")]))
    } catch { setChanges(null) }
  }
  useEffect(() => { loadChanges() }, [root])
  const showDiff = async (status: string, path: string) => {
    const text = await call<string>("git", { root, op: status === "??" ? "diff-new" : "diff", path })
    if (text !== undefined) setDiff({ path, status, text })
  }
  const discard = async (status: string, path: string) => {
    if (!(await sure(`Discard all changes to ${path}? This can't be undone.`))) return
    const full = join(root, path.split("/").join(sep))
    const ok = status === "??" ? await call("delete_path", { path: full }) : await call("git", { root, op: "discard", path })
    if (ok === undefined) return
    setDiff(null)
    syncFromDisk()
  }

  // ---- file operations ----
  const create = async (dir: string, name: string, folder: boolean) => {
    setNaming(null)
    if (!name.trim()) return
    const path = join(dir, name.trim().replace(/[\\/]+/g, sep))
    const ok = folder ? await call("make_dir", { path }) : await call("write_text", { path, text: "" })
    if (ok === undefined) return
    if (dir !== root && !openDirs.includes(dir)) setOpenDirs((o) => [...o, dir])
    await load(dir)
    if (!folder) openFile(path)
  }
  const rename = async (from: string, name: string) => {
    setRenaming(null)
    if (!name.trim() || name === base(from)) return
    const to = join(parent(from), name.trim())
    if ((await call("rename_path", { from, to })) === undefined) return
    if (tabs.includes(from)) { dropTab(from); openFile(to) }
    load(parent(from))
  }
  const remove = async (path: string, dir: boolean) => {
    if (!(await sure(`Delete ${rel(path)}? This can't be undone.`))) return
    if ((await call("delete_path", { path })) === undefined) return
    if (!dir) dropTab(path)
    load(parent(path))
  }

  // ---- terminal ----
  const [term, setTerm] = useState<string[]>([])
  const [termLine, setTermLine] = useState("")
  const [termBusy, setTermBusy] = useState(false)
  const [termHist, setTermHist] = useState<string[]>([])
  const [histAt, setHistAt] = useState(-1)
  const termEnd = useRef<HTMLDivElement>(null)
  const termInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const un = listen<{ text: string; code: number | null; done: boolean }>("term", ({ payload }) => {
      if (termOwner !== root) return
      if (payload.done) {
        setTermBusy(false)
        setTerm((t) => [...t, payload.code === 0 ? "" : `[exited with code ${payload.code ?? "?"}]`, ""])
        syncRef.current()
        return
      }
      setTerm((t) => [...t, payload.text.replace(ansi, "").replace(/\r?\n$/, "")].slice(-2000))
    })
    return () => { un.then((f) => f()) }
  }, [root])
  useEffect(() => { termEnd.current?.scrollIntoView({ block: "end" }) }, [term])
  const runCmd = async (typed = termLine) => {
    const line = typed.trim()
    if (!line || termBusy) return
    if (typed === termLine) setTermLine("")
    setHistAt(-1)
    setTermHist((h) => [line, ...h.filter((x) => x !== line)].slice(0, 50))
    if (line === "clear" || line === "cls") return setTerm([])
    termOwner = root
    setTerm((t) => [...t, `${sep === "\\" ? ">" : "$"} ${line}`])
    setTermBusy(true)
    if ((await call("run_cmd", { cwd: root, line })) === undefined) setTermBusy(false)
  }

  // Run button: save, then run the open file with the usual tool for its extension, in the terminal.
  const runner = (path: string) => {
    const f = `"${rel(path)}"`, ext = path.split(".").pop()?.toLowerCase() ?? ""
    const r: Record<string, string> = {
      py: `${MAC ? "python3" : "python"} ${f}`, js: `node ${f}`, mjs: `node ${f}`, cjs: `node ${f}`, ts: `npx --yes tsx ${f}`,
      sh: `bash ${f}`, ps1: `powershell -ExecutionPolicy Bypass -File ${f}`, bat: f, cmd: f, rb: `ruby ${f}`, go: `go run ${f}`,
      php: `php ${f}`, lua: `lua ${f}`, pl: `perl ${f}`, rs: "cargo run", java: `java ${f}`, html: MAC ? `open ${f}` : `start "" ${f}`,
    }
    return r[ext]
  }
  const runFile = async () => {
    if (!active) return
    const line = runner(active)
    if (!line) return void toast.error(`Orlo doesn't know how to run .${active.split(".").pop()} files. Use the terminal.`)
    if (dirty.includes(active)) await save(active)
    setPanels((p) => ({ ...p, term: true }))
    runCmd(line)
  }

  const runRef = useRef(runFile)
  runRef.current = runFile

  // ---- agent chat ----
  const installed = clis.filter((c) => c.path)
  const mine = chats.filter((c) => c.cwd === root).sort((a, b) => b.id - a.id)
  const [chatId, setChatId] = useState<number | null>(() => mine[0]?.id ?? null)
  const chat = mine.find((c) => c.id === chatId) ?? null
  const [pick, setPickRaw] = useState<Pick>(() => store.get("orlo.codePick", noPick))
  const setPick = (p: Pick) => { setPickRaw(p); store.set("orlo.codePick", p) }
  const agent = installed.some((c) => c.name === pick.agent) ? pick.agent : installed[0]?.name ?? ""
  const cur: Pick = agent === pick.agent ? pick : { ...noPick, agent }
  const [events, setEvents] = useState<Ev[]>([])
  const [live, setLive] = useState("")
  const [prompt, setPrompt] = useState("")
  const [cmds, setCmds] = useState<Record<string, string[]>>(() => store.get("orlo.agentCommands", AGENT_COMMANDS))
  const [menuAt, setMenuAt] = useState(0)
  const [caret, setCaret] = useState(0)
  const busy = chat != null && running.includes(chat.id)
  const chatRef = useRef(chatId)
  chatRef.current = chatId
  const box = useRef<HTMLTextAreaElement>(null)
  const chatEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLive("")
    if (chatId == null) return setEvents([])
    call<Ev[]>("events", { taskId: chatId }).then((es) => setEvents(es ?? []))
  }, [chatId])
  useEffect(() => { if (focusChat) { setChatId(focusChat.id); setPanels((p) => ({ ...p, chat: true })) } }, [focusChat])
  // A chat picks its own agent and settings back up when you reopen it.
  useEffect(() => { if (chat?.agent) setPick({ agent: chat.agent, model: chat.model, effort: chat.effort, access: chat.access }) }, [chat?.id])
  useEffect(() => {
    const un = listen<Ev>("agent", ({ payload: ev }) => {
      if (ev.task_id !== chatRef.current) return
      if (ev.kind === "commands") {
        const a = chats.find((c) => c.id === ev.task_id)?.agent ?? cur.agent
        setCmds((m) => { const next = { ...m, [a]: ev.text.split(",").filter(Boolean) }; store.set("orlo.agentCommands", next); return next })
        return
      }
      if (ev.kind === "delta") return setLive((l) => l + ev.text)
      setLive("")
      setEvents((es) => [...es, ev])
      if (ev.kind === "end") syncRef.current()
    })
    return () => { un.then((f) => f()) }
  }, [chats, cur.agent])
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }) }, [events, live])

  // Suggestions under the prompt: "/" commands at the start, "@" files anywhere.
  const before = prompt.slice(0, caret)
  const slash = /^\/(\S*)(?:\s+(\S*))?$/.exec(before)
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
  const menu: [insert: string, label: string, hint: string][] = useMemo(() => {
    if (slash && slash[2] === undefined) {
      const q = slash[1].toLowerCase()
      const own = (cmds[agent] ?? []).map((c): [string, string, string] => [`/${c} `, `/${c}`, `${title(agent)} command`])
      return [...BUILTIN.map(([n, h]): [string, string, string] => [`/${n} `, `/${n}`, h]), ...own].filter(([, l]) => l.slice(1).toLowerCase().startsWith(q)).slice(0, 12)
    }
    if (slash) {
      const q = slash[2].toLowerCase()
      const opts = slash[1] === "model" ? MODELS[agent] ?? [] : slash[1] === "effort" ? EFFORTS[agent] ?? [] : slash[1] === "access" ? (ACCESS[agent] ?? []).map(([v]) => v || "default") : []
      return opts.filter((o) => o.startsWith(q)).map((o): [string, string, string] => [`/${slash[1]} ${o}`, o, ""])
    }
    if (at) {
      const q = at[1].toLowerCase()
      return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 10).map((f): [string, string, string] => [`@${f} `, f, ""])
    }
    return []
  }, [prompt, caret, cmds, agent, files])
  useEffect(() => setMenuAt(0), [menu.length])
  useEffect(() => { if (at && !files.length) indexFiles() }, [!!at])

  const accept = (insert: string) => {
    const start = slash ? 0 : before.length - (at?.[1].length ?? 0) - 1
    const next = prompt.slice(0, start) + insert + prompt.slice(caret)
    setPrompt(next)
    const pos = start + insert.length
    requestAnimationFrame(() => { box.current?.setSelectionRange(pos, pos); setCaret(pos); box.current?.focus() })
  }

  const send = async () => {
    const text = prompt.trim()
    if (!text || !agent) return
    const [, name, arg] = /^\/(\S+)\s*(.*)$/.exec(text) ?? []
    if (name === "clear") { setPrompt(""); setChatId(null); return }
    if (name === "stop") { setPrompt(""); if (chat) call("stop", { taskId: chat.id }); return }
    if (name === "model" || name === "effort" || name === "access") {
      const v = arg.trim() === "default" ? "" : arg.trim()
      const ok = name === "model" ? true : name === "effort" ? !v || (EFFORTS[agent] ?? []).includes(v) : (ACCESS[agent] ?? []).some(([x]) => x === v)
      if (!ok) return void toast.error(`${title(agent)} doesn't support ${name} "${arg}".`)
      setPick({ ...cur, [name]: v })
      setPrompt("")
      return void toast.success(`${title(name)}: ${v || "default"}`)
    }
    if (busy) return
    // The CLI's own slash commands go through untouched, without the editor context.
    const where = !name && active ? `\n\n(Open in the editor: ${rel(active)})` : ""
    setPrompt("")
    if (chat && chat.agent === agent && chat.session_id) {
      await call("reply", { taskId: chat.id, text: text + where, model: cur.model, effort: cur.effort, access: cur.access })
      return refresh()
    }
    if (name) return void toast.error(`Start a conversation with ${title(agent)} before using /${name}.`)
    if (chat && chat.agent !== agent) toast(`Started a new conversation with ${title(agent)}.`)
    const first = text.split("\n")[0]
    const c = await call<Chat & { notes: string }>("add_task", { title: first, kind: "chat", listId: null, due: null, cwd: root })
    if (!c) return
    // The run prompt is title + notes.
    const rest = text.slice(first.length).trim() + where
    if (rest.trim()) await call("save_task", { task: { ...c, notes: rest.trim() } })
    setChatId(c.id)
    await call("delegate", { taskId: c.id, agent, model: cur.model, effort: cur.effort, access: cur.access })
    refresh()
  }

  // ---- shortcuts while this project is on screen ----
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === "p") { e.preventDefault(); indexFiles(); setQuick(true) }
      else if (k === "`" || k === "j") { e.preventDefault(); setPanels((p) => ({ ...p, term: !p.term })); requestAnimationFrame(() => termInput.current?.focus()) }
      else if (k === "l") {
        e.preventDefault()
        // Toggles, except it first focuses an open chat that doesn't have focus yet.
        if (panels.chat && document.activeElement !== box.current) box.current?.focus()
        else { setPanels((p) => ({ ...p, chat: !p.chat })); requestAnimationFrame(() => box.current?.focus()) }
      }
    }
    const onF5 = (e: KeyboardEvent) => { if (e.key === "F5") { e.preventDefault(); runRef.current() } }
    window.addEventListener("keydown", onKey)
    window.addEventListener("keydown", onF5)
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keydown", onF5) }
  }, [visible, panels.chat])

  // ---- render ----
  const nameInput = (initial: string, done: (v: string) => void, cancel: () => void, depth: number) => (
    <input
      autoFocus defaultValue={initial} spellCheck={false}
      className="my-0.5 w-[calc(100%-8px)] rounded-md border bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
      style={{ marginLeft: 4 + depth * 12 }}
      onFocus={(e) => e.currentTarget.setSelectionRange(0, initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length)}
      onBlur={(e) => done(e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); cancel() } }}
    />
  )
  const tree = (dir: string, depth: number): React.ReactNode => (
    <>
      {naming?.dir === dir && nameInput("", (v) => create(dir, v, naming.folder), () => setNaming(null), depth)}
      {(dirs[dir] ?? []).map((en) => {
        const path = join(dir, en.name)
        const isOpen = openDirs.includes(path)
        if (renaming === path) return <div key={path}>{nameInput(en.name, (v) => rename(path, v), () => setRenaming(null), depth)}</div>
        return (
          <div key={path}>
            <ContextMenu>
              <ContextMenuTrigger
                className={cn("flex w-full cursor-default items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left text-sm hover:bg-muted", active === path && "bg-muted font-medium")}
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => {
                  if (!en.dir) return void openFile(path)
                  setOpenDirs((o) => (isOpen ? o.filter((x) => x !== path) : [...o, path]))
                  if (!isOpen) load(path)
                }}
              >
                {en.dir ? <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} /> : <span className="w-3.5 shrink-0" />}
                {en.dir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                <span className={cn("truncate", dirty.includes(path) && "italic")}>{en.name}</span>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-44">
                {en.dir && <>
                  <ContextMenuItem onClick={() => { setOpenDirs((o) => (o.includes(path) ? o : [...o, path])); load(path); setNaming({ dir: path, folder: false }) }}><FilePlus />New file</ContextMenuItem>
                  <ContextMenuItem onClick={() => { setOpenDirs((o) => (o.includes(path) ? o : [...o, path])); load(path); setNaming({ dir: path, folder: true }) }}><FolderPlus />New folder</ContextMenuItem>
                  <ContextMenuSeparator />
                </>}
                <ContextMenuItem onClick={() => { setPanels((p) => ({ ...p, chat: true })); setPrompt((x) => `${x}${x && !x.endsWith(" ") ? " " : ""}@${rel(path).split("\\").join("/")} `); requestAnimationFrame(() => box.current?.focus()) }}>
                  <MessageSquarePlus />Mention in chat
                </ContextMenuItem>
                <ContextMenuItem onClick={() => navigator.clipboard.writeText(path).then(() => toast.success("Path copied"))}><File />Copy path</ContextMenuItem>
                <ContextMenuItem onClick={() => setRenaming(path)}><Pencil />Rename</ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => remove(path, en.dir)}><Trash2 />Delete</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {en.dir && isOpen && tree(path, depth + 1)}
          </div>
        )
      })}
    </>
  )

  const toggle = (k: keyof typeof panels) => setPanels((p) => ({ ...p, [k]: !p[k] }))
  const [quickQ, setQuickQ] = useState("")
  const quickHits = useMemo(() => {
    const s = quickQ.toLowerCase().replace(/\s+/g, "")
    if (!s) return files.slice(0, 50)
    // Letters in order, like most editors' quick open; shorter paths first.
    const hits = files.filter((f) => { let i = 0; for (const ch of f.toLowerCase()) if (ch === s[i]) i++; return i === s.length })
    return hits.sort((a, b) => (b.toLowerCase().includes(s) ? 1 : 0) - (a.toLowerCase().includes(s) ? 1 : 0) || a.length - b.length).slice(0, 50)
  }, [quickQ, files])

  return (
    <div className={cn("flex h-full min-h-0 flex-col", !shown && "hidden")}>
      <div className="flex h-9 shrink-0 items-stretch border-b bg-muted/30">
        {strip}
        <div className="ml-auto flex items-center gap-0.5 px-1">
          <Tip label={<>Go to file <Kbd>{MOD}P</Kbd></>}>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Go to file" onClick={() => { indexFiles(); setQuick(true) }}><Search /></Button>
          </Tip>
          <Tip label="Files"><Button variant="ghost" size="icon-xs" className={cn("text-muted-foreground", panels.tree && "text-foreground")} aria-label="Toggle files" onClick={() => toggle("tree")}><PanelLeft /></Button></Tip>
          <Tip label={<>Terminal <Kbd>{MOD}J</Kbd></>}><Button variant="ghost" size="icon-xs" className={cn("text-muted-foreground", panels.term && "text-foreground")} aria-label="Toggle terminal" onClick={() => toggle("term")}><PanelBottom /></Button></Tip>
          <Tip label={<>Agent chat <Kbd>{MOD}L</Kbd></>}><Button variant="ghost" size="icon-xs" className={cn("text-muted-foreground", panels.chat && "text-foreground")} aria-label="Toggle agent chat" onClick={() => toggle("chat")}><PanelRight /></Button></Tip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {panels.tree && (
          <aside className="flex w-[min(14rem,24%)] shrink-0 flex-col border-r">
            <div className="flex h-8 items-center gap-0.5 pr-1 pl-2">
              {(["files", "changes"] as const).map((k) => (
                <button key={k} onClick={() => { setSide(k); if (k === "changes") loadChanges() }}
                  className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase", side === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {k === "files" ? "Files" : <>Changes{changes?.length ? <span className="ml-1 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{changes.length}</span> : null}</>}
                </button>
              ))}
              {side === "files" && <>
              <Tip label="New file"><Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="New file" onClick={() => setNaming({ dir: root, folder: false })}><FilePlus /></Button></Tip>
              <Tip label="New folder"><Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="New folder" onClick={() => setNaming({ dir: root, folder: true })}><FolderPlus /></Button></Tip>
              <Tip label="Reload"><Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Reload files" onClick={reloadTree}><RefreshCw /></Button></Tip>
              </>}
            </div>
            {side === "files" ? <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{tree(root, 0)}</div> : (
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
                {changes === null ? <p className="px-2 py-3 text-xs text-muted-foreground">This folder isn't a git repository, so there's nothing to compare against.</p>
                  : !changes.length ? <p className="px-2 py-3 text-xs text-muted-foreground">No changes since the last commit.</p>
                  : changes.map(([st, path]) => (
                    <div key={path} className={cn("group flex items-center gap-1.5 rounded-md py-1 pr-1 pl-2 hover:bg-muted", diff?.path === path && "bg-muted")}>
                      <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={path} onClick={() => showDiff(st, path)}>
                        <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", st.includes("D") ? "text-destructive" : st === "??" || st.includes("A") ? "text-emerald-500" : "text-amber-500")}>{st === "??" ? "U" : st.trim()[0]}</span>
                        <span className="truncate">{base(path)}</span>
                        <span className="truncate text-[11px] text-muted-foreground">{path.includes("/") ? parent(path) : ""}</span>
                      </button>
                      <Tip label="Discard changes"><Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" aria-label={`Discard ${path}`} onClick={() => discard(st, path)}><Undo2 /></Button></Tip>
                    </div>
                  ))}
              </div>
            )}
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b">
            {tabs.map((p) => (
              <div key={p} className={cn("group flex shrink-0 items-center gap-1 border-r pr-1 pl-3 text-xs", p === active ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground")}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(p) } }}>
                <button className="max-w-48 truncate" title={rel(p)} onClick={() => { setActive(p); setDiff(null) }}>{base(p)}</button>
                <button className="grid size-4 place-items-center rounded hover:bg-muted" aria-label={`Close ${rel(p)}`} onClick={() => closeTab(p)}>
                  {dirty.includes(p) ? <span className="size-1.5 rounded-full bg-foreground group-hover:hidden" /> : null}
                  <X className={cn("size-3", dirty.includes(p) && "hidden group-hover:block")} />
                </button>
              </div>
            ))}
            {active && runner(active) && (
              <Tip label={<>Run {base(active)} <Kbd>F5</Kbd></>}>
                <Button variant="ghost" size="icon-xs" className="sticky right-0 my-auto mr-1 ml-auto bg-background text-muted-foreground" aria-label="Run file" disabled={termBusy} onClick={runFile}><Play /></Button>
              </Tip>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            <div ref={host} className={cn("orlo-code absolute inset-0", !active && "invisible")} />
            {diff && (
              <div className="absolute inset-0 z-10 flex flex-col bg-background">
                <div className="flex h-8 shrink-0 items-center gap-1 border-b px-3 text-xs">
                  <span className="min-w-0 truncate font-medium" title="Changes since the last commit">{diff.path}</span>
                  {!diff.status.includes("D") && <Button variant="ghost" size="xs" className="ml-auto" onClick={() => { openFile(join(root, diff.path.split("/").join(sep))); setDiff(null) }}><File />Open file</Button>}
                  <Button variant="ghost" size="xs" className={cn(diff.status.includes("D") && "ml-auto")} onClick={() => discard(diff.status, diff.path)}><Undo2 />Discard</Button>
                  <Button variant="ghost" size="icon-xs" aria-label="Close diff" onClick={() => setDiff(null)}><X /></Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs leading-5">
                  {diff.text.split("\n").filter((l) => !/^(diff --git|index |new file mode|deleted file mode|--- |\+\+\+ )/.test(l)).map((l, i) => (
                    <div key={i} className={cn("px-3 whitespace-pre",
                      l.startsWith("+") ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : l.startsWith("-") ? "bg-red-500/12 text-red-700 dark:text-red-300" : l.startsWith("@@") ? "mt-2 text-sky-600 dark:text-sky-400" : "text-muted-foreground")}>{l || " "}</div>
                  ))}
                  {!diff.text.trim() && <p className="px-3 text-muted-foreground">No text changes (binary file or mode change).</p>}
                </div>
              </div>
            )}
            {!active && (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-2">
                  <span>Go to file</span><Kbd>{MOD}P</Kbd>
                  <span>Save</span><Kbd>{MOD}S</Kbd>
                  <span>Find and replace</span><Kbd>{MOD}F</Kbd>
                  <span>Terminal</span><Kbd>{MOD}J</Kbd>
                  <span>Agent chat</span><Kbd>{MOD}L</Kbd>
                  <span>Run file</span><Kbd>F5</Kbd>
                </div>
              </div>
            )}
          </div>

          {panels.term && (
            <div className="flex h-56 shrink-0 flex-col border-t">
              <div className="flex h-8 shrink-0 items-center gap-1 px-3 text-xs text-muted-foreground">
                <SquareTerminal className="size-3.5" />Terminal
                <span className="truncate font-mono text-[11px]">· {base(root)}</span>
                {termBusy && <Button variant="ghost" size="xs" className="ml-auto" onClick={() => call("stop_cmd")}><Square />Stop</Button>}
                <Button variant="ghost" size="xs" className={cn(!termBusy && "ml-auto")} onClick={() => setTerm([])}>Clear</Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 font-mono text-xs leading-relaxed whitespace-pre-wrap" onClick={() => termInput.current?.focus()}>
                {term.map((l, i) => <div key={i} className={cn(/^[$>] /.test(l) && "text-foreground", /^\[exited/.test(l) && "text-destructive")}>{l || " "}</div>)}
                <div ref={termEnd} className="flex items-center gap-2 pb-2">
                  <span className="text-muted-foreground">{sep === "\\" ? ">" : "$"}</span>
                  <input
                    ref={termInput} value={termLine} onChange={(e) => setTermLine(e.target.value)} disabled={termBusy} spellCheck={false}
                    placeholder={termBusy ? "Running…" : "Type a command and press Enter"}
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runCmd()
                      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault()
                        const i = Math.max(-1, Math.min(termHist.length - 1, histAt + (e.key === "ArrowUp" ? 1 : -1)))
                        setHistAt(i)
                        setTermLine(i < 0 ? "" : termHist[i])
                      } else if (e.key === "c" && e.ctrlKey && termBusy) call("stop_cmd")
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
            {active ? <>
              <span>Ln {cursor.line}, Col {cursor.col}{cursor.sel ? ` (${cursor.sel} selected)` : ""}</span>
              <span>{langs[active] ?? "Plain text"}</span>
              <span>UTF-8</span>
              {dirty.includes(active) && <button className="text-foreground hover:underline" onClick={() => save(active)}>Unsaved · {MOD}S to save</button>}
            </> : <span className="truncate">{root}</span>}
            {busy && <span className="ml-auto flex items-center gap-1.5"><Spinner className="size-3" />{title(chat?.agent ?? "")} is working</span>}
          </div>
        </div>

        {panels.chat && (
          <aside className="flex w-[min(24rem,36%)] shrink-0 flex-col border-l">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
              <select
                className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-1 text-xs font-medium outline-none hover:bg-muted"
                value={chatId ?? ""} onChange={(e) => setChatId(e.target.value ? Number(e.target.value) : null)} aria-label="Conversation"
              >
                <option value="">New conversation</option>
                {mine.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <Tip label="New conversation">
                <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="New conversation" onClick={() => setChatId(null)}><MessageSquarePlus /></Button>
              </Tip>
              <Tip label={<>Close chat <Kbd>{MOD}L</Kbd></>}>
                <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Close chat" onClick={() => toggle("chat")}><X /></Button>
              </Tip>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {!chat && !events.length ? (
                <div className="mt-8 flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
                  <AgentIcon name={agent} className="size-6" />
                  <p>Ask {agent ? title(agent) : "an agent"} to change, explain or fix anything in <span className="font-medium text-foreground">{base(root)}</span>.</p>
                  <p className="text-xs">Type <Kbd>/</Kbd> for commands and <Kbd>@</Kbd> to mention a file.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {events.filter(chatEvent).map((ev, i) => <div key={i}>{activity(ev, title(chat?.agent ?? agent))}</div>)}
                  {live && activity({ task_id: chatId ?? 0, kind: "text", text: live }, title(chat?.agent ?? agent))}
                  {busy && !live && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" />Thinking…</div>}
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="shrink-0 border-t p-2">
              <div className="relative rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring">
                {menu.length > 0 && (
                  <div className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
                    {menu.map(([ins, label, hint], i) => (
                      <button key={ins} className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs", i === menuAt && "bg-muted")}
                        onMouseDown={(e) => { e.preventDefault(); accept(ins) }}>
                        <span className="font-mono">{label}</span><span className="truncate text-muted-foreground">{hint}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={box} value={prompt} rows={3} spellCheck autoCorrect="on" autoCapitalize="sentences"
                  disabled={!installed.length}
                  placeholder={!installed.length ? "Install an agent CLI (claude, codex, grok, hermes or gemini) to chat" : busy ? "Working… /stop to stop it" : chat ? "Reply…" : "Ask for a change…"}
                  className="block max-h-48 min-h-16 w-full resize-none bg-transparent px-3 pt-2 text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(e) => { setPrompt(e.target.value); setCaret(e.target.selectionStart) }}
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                  onKeyDown={(e) => {
                    if (menu.length) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMenuAt((i) => (i + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length); return }
                      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && menu[menuAt][0].trim() !== prompt.trim())) { e.preventDefault(); accept(menu[menuAt][0]); return }
                      if (e.key === "Escape") { e.preventDefault(); setCaret(-1); return }
                    }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() }
                  }}
                />
                <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
                  {picker(cur, setPick)}
                  {busy ? (
                    <Button size="icon-sm" variant="secondary" className="ml-auto" aria-label="Stop" onClick={() => chat && call("stop", { taskId: chat.id })}><Square /></Button>
                  ) : (
                    <Button size="icon-sm" className="ml-auto" aria-label="Send" disabled={!prompt.trim() || !agent} onClick={send}><Send /></Button>
                  )}
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      <CommandDialog open={quick} onOpenChange={(o) => { setQuick(o); if (!o) setQuickQ("") }} title="Go to file" className="sm:max-w-xl">
        <Command shouldFilter={false}>
          <CommandInput value={quickQ} onValueChange={setQuickQ} placeholder={`Search files in ${base(root)}…`} />
          <CommandList className="max-h-96">
            <CommandEmpty>No matching files.</CommandEmpty>
            {quickHits.map((f) => (
              <CommandItem key={f} value={f} onSelect={() => { setQuick(false); setQuickQ(""); openFile(join(root, f.split("/").join(sep))) }}>
                <File /><span className="truncate">{base(f)}</span><span className="ml-auto truncate text-xs text-muted-foreground">{f}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </div>
  )
}

