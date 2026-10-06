import { useEffect, useMemo, useRef, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import {
  ArrowUpRight, Bell, Bot, CalendarDays, Check, CircleCheck, Columns3, Copy, CornerDownLeft, Download, Ellipsis, FileText, Hash,
  LayoutDashboard, ListTodo, MessageSquareText, Minus, Pencil, Plus, Rows3, Search, Sparkles, Square, Star, Tag, Trash2,
  TriangleAlert, Wrench, X,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"
import { Toaster } from "@/components/ui/sonner"
import { AgentIcon } from "@/components/agent-icon"
import { MdEditor, MdView, plain } from "@/components/md-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command"
import {
  ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInput, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarRail, SidebarTrigger,
} from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

type List = { id: number; name: string }
type Task = {
  id: number; title: string; notes: string; due: string | null; list_id: number | null; status: string
  agent: string | null; session_id: string | null; tags: string; kind: string; model: string; effort: string; verdict: string
}
type Ev = { task_id: number; kind: string; text: string }
type Cli = { name: string; path: string | null; cap: string }
type Mode = "task" | "note"
type Layout = "list" | "board"
type Pick = { agent: string; model: string; effort: string }
type View = "home" | "tasks" | "notes" | number | `#${string}`
type Notif = { id: number; task_id: number | null; title: string; text: string; tone: Tone; at: number; read: boolean }
type Tone = "work" | "review" | "warn" | "done" | "idle"
type Ctx = {
  clis: Cli[]; lists: List[]; tags: string[]; running: number[]; sel: number | null
  open: (t: Task) => void; toggle: (t: Task) => void; save: (t: Task) => void
  remove: (t: Task) => void; delegate: (t: Task, p: Pick) => void; fresh: number | null
}
type Party = { title: string; text: string }

const win = getCurrentWindow()
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const today = () => ymd(new Date())
const inDays = (n: number) => ymd(new Date(Date.now() + n * 864e5))
const title = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
// Tags live in one comma-separated column.
const tagList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)
const withTag = (t: Task, tag: string): Task => {
  const ts = tagList(t.tags)
  return { ...t, tags: (ts.includes(tag) ? ts.filter((x) => x !== tag) : [...ts, tag]).join(",") }
}
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const dot = (g: string) => `oklch(0.72 0.14 ${hue(g)})`
const TEMPLATE_TAGS = ["Work", "Personal", "Urgent", "Errand", "Idea"]
// Model names each CLI accepts; "default" leaves the CLI's own choice.
const MODELS: Record<string, string[]> = {
  claude: ["fable", "opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.5"],
}
const EFFORTS: Record<string, string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh"] }
const noPick: Pick = { agent: "", model: "", effort: "" }
// Each fires once, the first time it happens.
const MILESTONES: Record<string, Party> = {
  "first-task": { title: "Yay! You made your first task!", text: "Orlo's got it. Press Space to check it off, or hand it to an agent." },
  "first-done": { title: "Woohoo, first one done!", text: "That felt good, right? Keep the streak going." },
  "first-agent": { title: "Your first agent is on it!", text: "Sit back. Orlo will ping you when it's ready for review." },
  "first-note": { title: "Your very first note!", text: "Ideas are safe here. Tag them to find them fast." },
}

// Per-device conveniences only (notification list, last reminder day); losing them is harmless.
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

// Errors from commands surface as toasts; the promise resolves undefined so callers keep going.
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    toast.error(String(e))
  }
}

function dueLabel(due: string) {
  if (due === today()) return "Today"
  if (due === inDays(1)) return "Tomorrow"
  if (due === inDays(-1)) return "Yesterday"
  return new Date(due + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const needsYou = (t: Task, live: boolean) => !!t.agent && t.status !== "done" && !live && (t.verdict === "review" || t.verdict === "input" || !!t.session_id)

function agentState(t: Task, live: boolean): { label: string; tone: Tone } {
  if (live) return { label: "Working", tone: "work" }
  if (t.status === "done") return { label: t.verdict === "complete" ? "Completed" : "Done", tone: "done" }
  if (t.verdict === "input") return { label: "Needs input", tone: "warn" }
  if (t.verdict === "review" || t.session_id) return { label: "Needs review", tone: "review" }
  return { label: "Stopped", tone: "idle" }
}
const toneDot: Record<Tone, string> = {
  work: "bg-sky-400", review: "bg-violet-400", warn: "bg-amber-400", done: "bg-emerald-400", idle: "bg-muted-foreground",
}

// Linear-style sections for the list view; also the order j/k walks. Agent work floats to the top.
function sections(ts: Task[], running: number[]): [string, Task[]][] {
  const t0 = today()
  const agent = (t: Task) => t.status !== "done" && (running.includes(t.id) || needsYou(t, false))
  const open = ts.filter((t) => t.status !== "done" && !agent(t))
  const out: [string, Task[]][] = [
    ["With agents", ts.filter(agent)],
    ["Overdue", open.filter((t) => t.due != null && t.due < t0)],
    ["Today", open.filter((t) => t.due === t0)],
    ["Upcoming", open.filter((t) => t.due != null && t.due > t0).sort((a, b) => a.due!.localeCompare(b.due!))],
    ["No date", open.filter((t) => t.due == null)],
    ["Completed", ts.filter((t) => t.status === "done")],
  ]
  return out.filter(([, x]) => x.length)
}

export default function App() {
  const [lists, setLists] = useState<List[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [clis, setClis] = useState<Cli[]>([])
  const [running, setRunning] = useState<number[]>([])
  const [view, setView] = useState<View>("home")
  const [layout, setLayout] = useState<Layout>(() => store.get("orlo.layout", "list"))
  const [q, setQ] = useState("")
  const [sel, setSel] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const [thread, setThread] = useState<Ev[]>([])
  const [live, setLive] = useState("")
  const [notifs, setNotifs] = useState<Notif[]>(() => store.get("orlo.notifs", []))
  const [intro, setIntro] = useState(() => !store.get("orlo.intro", false))
  const [party, setParty] = useState<Party | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)
  const newRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selRef = useRef(sel)
  selRef.current = sel
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const mode: Mode = view === "notes" ? "note" : "task"

  const refresh = async () => {
    setTasks((await call<Task[]>("tasks")) ?? [])
    setRunning((await call<number[]>("running")) ?? [])
  }
  const loadLists = async () => setLists((await call<List[]>("lists")) ?? [])
  const notify = (n: Omit<Notif, "id" | "at" | "read">) =>
    setNotifs((ns) => [{ ...n, id: Date.now() + Math.random(), at: Date.now(), read: false }, ...ns].slice(0, 50))

  useEffect(() => store.set("orlo.notifs", notifs), [notifs])
  useEffect(() => store.set("orlo.layout", layout), [layout])

  useEffect(() => {
    loadLists()
    refresh()
    call<Cli[]>("clis").then((c) => setClis(c ?? []))
    requestAnimationFrame(() => win.show())
    const first = import.meta.env.DEV ? 0 : window.setTimeout(() => checkUpdate(false), 5000)
    const every = import.meta.env.DEV ? 0 : window.setInterval(() => checkUpdate(false), 6 * 3600_000)
    const un = listen<Ev>("agent", ({ payload: ev }) => {
      if (["prompt", "reply", "end", "verdict"].includes(ev.kind)) refresh()
      const name = tasksRef.current.find((t) => t.id === ev.task_id)?.title ?? "Task"
      if (ev.kind === "verdict") {
        const text = ev.text === "complete" ? "Finished and checked it off" : ev.text === "input" ? "Has a question for you" : "Finished — ready for your review"
        notify({ task_id: ev.task_id, title: name, text, tone: ev.text === "complete" ? "done" : ev.text === "input" ? "warn" : "review" })
      }
      if (ev.kind === "end" && /code [1-9]/.test(ev.text)) notify({ task_id: ev.task_id, title: name, text: `Stopped · ${ev.text}`, tone: "warn" })
      if (ev.task_id !== selRef.current) return
      if (ev.kind === "delta") return setLive((l) => l + ev.text)
      setLive("")
      setThread((t) => [...t, ev])
    })
    return () => { clearTimeout(first); clearInterval(every); un.then((f) => f()) }
  }, [])

  // Once a day: a reminder for what is due, in the bell and as a Windows notification.
  const reminded = useRef(false)
  useEffect(() => {
    if (reminded.current || !tasks.length) return
    reminded.current = true
    if (store.get("orlo.reminded", "") === today()) return
    store.set("orlo.reminded", today())
    const n = tasks.filter((t) => t.kind === "task" && t.status !== "done" && t.due != null && t.due <= today()).length
    if (!n) return
    const body = `${n} task${n > 1 ? "s" : ""} due today or overdue`
    notify({ task_id: null, title: "Today", text: body, tone: "idle" })
    ;(async () => {
      let ok = await isPermissionGranted()
      if (!ok) ok = (await requestPermission()) === "granted"
      if (ok) sendNotification({ title: "Orlo", body })
    })()
  }, [tasks])

  useEffect(() => {
    setLive("")
    setThread([])
    if (sel != null) call<Ev[]>("events", { taskId: sel }).then((e) => setThread(e ?? []))
  }, [sel])

  const mine = useMemo(() => tasks.filter((t) => t.kind === mode), [tasks, mode])
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => tagList(t.tags)))].sort(), [tasks])
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s) {
      // "#tag" words must all be tags on the item; the rest is plain text search.
      const words = s.split(/\s+/)
      const want = words.filter((w) => w.length > 1 && w[0] === "#").map((w) => w.slice(1))
      const text = words.filter((w) => w[0] !== "#").join(" ")
      return mine.filter((t) => {
        const has = tagList(t.tags.toLowerCase())
        return want.every((w) => has.includes(w)) && [t.title, t.notes, t.tags].join(" ").toLowerCase().includes(text)
      })
    }
    return mine.filter((t) =>
      typeof view === "number" ? t.list_id === view
        : view[0] === "#" ? tagList(t.tags).includes(view.slice(1))
        : true)
  }, [mine, view, q])
  const groups = useMemo(() => sections(visible, running), [visible, running])
  const ordered = mode === "task" ? groups.flatMap(([, ts]) => ts) : visible

  const task = tasks.find((t) => t.id === sel) ?? null
  const searching = !!q.trim()
  const home = view === "home" && !searching
  const viewName = searching ? "Search" : typeof view === "number" ? lists.find((l) => l.id === view)?.name ?? "" : view[0] === "#" ? view : title(view)

  const go = (v: View) => {
    setView(v)
    setQ("")
  }
  const save = async (t: Task) => {
    setTasks((ts) => ts.map((x) => (x.id === t.id ? t : x)))
    await call("save_task", { task: t })
  }
  // Hidden at once, deleted for real when the toast leaves without Undo.
  const remove = (t: Task) => {
    setTasks((ts) => ts.filter((x) => x.id !== t.id))
    if (selRef.current === t.id) { setOpen(false); setSel(null) }
    let undone = false, gone = false
    const commit = () => { if (!undone && !gone) { gone = true; call("delete_task", { id: t.id }) } }
    toast(`Deleted “${t.title}”`, {
      action: { label: "Undo", onClick: () => { undone = true; setTasks((ts) => [...ts, t].sort((a, b) => a.id - b.id)) } },
      onAutoClose: commit, onDismiss: commit,
    })
  }
  const celebrate = (key: string, first: boolean) => {
    const seen = store.get<string[]>("orlo.milestones", [])
    if (seen.includes(key)) return
    store.set("orlo.milestones", [...seen, key])
    if (first) setParty(MILESTONES[key])
  }
  const toggle = (t: Task) => {
    if (t.kind !== "task") return
    if (t.status !== "done") celebrate("first-done", !tasksRef.current.some((x) => x.kind === "task" && x.status === "done"))
    save({ ...t, status: t.status === "done" ? "open" : "done" })
  }
  const delegate = async (t: Task, p: Pick) => {
    celebrate("first-agent", !tasksRef.current.some((x) => x.agent))
    setSel(t.id)
    setOpen(true)
    await call("delegate", { taskId: t.id, ...p })
    refresh()
  }
  const openTask = (t: Task) => {
    if (t.kind === "note" && mode !== "note") go("notes")
    setSel(t.id)
    setOpen(true)
  }

  // "#tag" words in the title become tags too.
  const addTask = async (text: string, picked: string[], agent: Pick, kind: Mode, due: string | null) => {
    const inline = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1])
    const clean = text.replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, "").trim() || text
    const fromView = typeof view === "string" && view[0] === "#" ? [view.slice(1)] : []
    const tags = [...new Set([...fromView, ...picked, ...inline])]
    const t = await call<Task>("add_task", {
      title: clean,
      kind,
      listId: typeof view === "number" ? view : null,
      due: kind === "note" ? null : due,
    })
    if (!t) return
    if (tags.length) {
      t.tags = tags.join(",")
      await call("save_task", { task: t })
    }
    const first = !tasksRef.current.some((x) => x.kind === kind)
    setTasks((ts) => [...ts, t])
    setFresh(t.id)
    celebrate(kind === "note" ? "first-note" : "first-task", first)
    if (agent.agent && kind === "task") delegate(t, agent)
  }
  const focusNew = (v?: View) => {
    if (v != null) go(v)
    setTimeout(() => newRef.current?.focus(), 60)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (palette) return
      if (e.key === "Escape") {
        ;(document.activeElement as HTMLElement | null)?.blur()
        setOpen(false)
        return
      }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const i = ordered.findIndex((t) => t.id === sel)
      if (e.key === "n") {
        e.preventDefault()
        focusNew()
      } else if (e.key === "/") {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === "j" || e.key === "k") {
        const next = ordered[Math.min(ordered.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))]
        if (next) setSel(next.id)
      } else if (e.key === " " && task) {
        e.preventDefault()
        toggle(task)
      } else if (e.key === "Enter" && task) {
        setOpen(true)
      } else if ((e.key === "Delete" || e.key === "Backspace") && task) {
        remove(task)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // No WebView "Inspect" menu; text fields keep the native copy/paste one.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => typing(e.target) || e.preventDefault()
    window.addEventListener("contextmenu", onMenu)
    return () => window.removeEventListener("contextmenu", onMenu)
  }, [])

  const ctx: Ctx = { clis, lists, tags: allTags, running, sel, open: openTask, toggle, save, remove, delegate, fresh }
  const unread = notifs.filter((n) => !n.read).length
  const showBoard = mode === "task" && layout === "board" && !home
  const composer = <Composer key={mode} kind={mode} clis={clis} tags={allTags} inputRef={newRef} onAdd={addTask} />
  const openById = (id: number) => { const t = tasks.find((x) => x.id === id); if (t) openTask(t) }

  return (
    <TooltipProvider delay={300}>
      <SidebarProvider className="h-full min-h-0" style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
        <AppSidebar
          lists={lists} tags={allTags} clis={clis} tasks={tasks} running={running} view={searching ? null : view}
          q={q} setQ={setQ} searchRef={searchRef} go={go} reload={async () => { await loadLists(); refresh() }}
          newTask={() => focusNew(mode === "note" ? "tasks" : undefined)} openPalette={() => setPalette(true)}
        />
        <SidebarInset className="min-h-0 min-w-0">
          <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b pl-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
            <h1 className="pointer-events-none truncate text-sm font-medium">{home ? "Home" : viewName}</h1>
            {!home && <Badge variant="secondary" className="pointer-events-none tabular-nums">{visible.filter((t) => t.status !== "done").length}</Badge>}
            <div className="ml-auto flex items-center gap-1">
              {showBoard || (mode === "task" && !home) ? (
                <ToggleGroup value={[layout]} onValueChange={(v) => v[0] && setLayout(v[0] as Layout)} variant="outline" size="sm" spacing={0}>
                  <ToggleGroupItem value="list" aria-label="List"><Rows3 /> List</ToggleGroupItem>
                  <ToggleGroupItem value="board" aria-label="Board"><Columns3 /> Board</ToggleGroupItem>
                </ToggleGroup>
              ) : null}
              <Bells notifs={notifs} unread={unread} setNotifs={setNotifs} openTask={openById} />
            </div>
            <WindowControls />
          </header>

          <div className="flex min-h-0 flex-1">
            <main key={`${String(view)}-${layout}`} className="@container/main orlo-enter min-w-0 flex-1 overflow-y-auto">
              {home ? (
                <Home tasks={tasks} ctx={ctx} go={go} setLayout={setLayout} composer={composer} />
              ) : (
                <div className="flex flex-col">
                  <div className="px-6 pt-5 pb-4">{composer}</div>
                  {!visible.length ? (
                    <Nothing searching={searching} mode={mode} onAdd={() => focusNew()} />
                  ) : mode === "note" ? (
                    <div className="grid grid-cols-1 gap-3 px-6 pb-8 @xl/main:grid-cols-2 @4xl/main:grid-cols-3">
                      {visible.map((t) => <NoteCard key={t.id} t={t} ctx={ctx} />)}
                    </div>
                  ) : showBoard ? (
                    <Board tasks={visible} ctx={ctx} />
                  ) : (
                    <div className="pb-8">
                      {groups.map(([name, ts]) => (
                        <section key={name}>
                          <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-y bg-muted/40 px-6 text-xs font-medium backdrop-blur">
                            {name}<span className="text-muted-foreground tabular-nums">{ts.length}</span>
                          </div>
                          {ts.map((t) => (
                            <Row key={t.id} t={t} ctx={ctx} listName={typeof view === "number" ? undefined : lists.find((l) => l.id === t.list_id)?.name} />
                          ))}
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </main>

            {open && task && (
              <Detail
                key={task.id} task={task} ctx={ctx} thread={thread} live={live} isRunning={running.includes(task.id)}
                where={lists.find((l) => l.id === task.list_id)?.name ?? (task.kind === "note" ? "Notes" : "Tasks")}
                close={() => setOpen(false)}
                reply={async (text) => { await call("reply", { taskId: task.id, text }); refresh() }}
                stop={() => call("stop", { taskId: task.id })}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Palette
        open={palette} setOpen={setPalette} tasks={tasks} lists={lists} tags={allTags} layout={layout}
        run={{
          newTask: () => focusNew(mode === "note" ? "tasks" : undefined), newNote: () => focusNew("notes"), go,
          open: openTask, setLayout, intro: () => setIntro(true), update: () => checkUpdate(true),
        }}
      />
      <Toaster position="bottom-right" />
      {intro && (
        <Intro
          clis={clis}
          done={() => { store.set("orlo.intro", true); setIntro(false) }}
          create={(text) => { store.set("orlo.intro", true); setIntro(false); go("tasks"); addTask(text, [], noPick, "task", null) }}
        />
      )}
      {party && <Celebrate key={party.title} party={party} done={() => setParty(null)} />}
    </TooltipProvider>
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

function WindowControls() {
  const btn = "grid h-12 w-11 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
  return (
    <div className="ml-1 flex self-stretch">
      <button className={btn} onClick={() => win.minimize()} aria-label="Minimize"><Minus className="size-4" strokeWidth={1.5} /></button>
      <button className={btn} onClick={() => win.toggleMaximize()} aria-label="Maximize"><Square className="size-3.5" strokeWidth={1.5} /></button>
      <button className={cn(btn, "hover:bg-[#c42b1c] hover:text-white")} onClick={() => win.close()} aria-label="Close"><X className="size-4" strokeWidth={1.5} /></button>
    </div>
  )
}

function AppSidebar(p: {
  lists: List[]; tags: string[]; clis: Cli[]; tasks: Task[]; running: number[]; view: View | null
  q: string; setQ: (s: string) => void; searchRef: React.RefObject<HTMLInputElement | null>
  go: (v: View) => void; reload: () => void; newTask: () => void; openPalette: () => void
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null)
  const t0 = today()
  // The badge counts what wants attention now: due or overdue, or an agent waiting on you.
  const now = p.tasks.filter((t) => t.kind === "task" && t.status !== "done" && ((t.due != null && t.due <= t0) || needsYou(t, p.running.includes(t.id))))
  const nav: [View, string, React.ReactNode, number][] = [
    ["home", "Home", <LayoutDashboard />, 0],
    ["tasks", "Tasks", <ListTodo />, now.length],
    ["notes", "Notes", <FileText />, 0],
  ]
  const commit = async (v: string, id: number | "new") => {
    setEditing(null)
    if (!v.trim()) return
    if (id === "new") {
      const l = await call<List>("add_list", { name: v.trim() })
      await p.reload()
      if (l) p.go(l.id)
    } else {
      await call("rename_list", { id, name: v.trim() })
      p.reload()
    }
  }
  const field = (id: number | "new", init = "") => (
    <SidebarMenuItem key={`edit-${id}`}>
      <SidebarInput
        autoFocus defaultValue={init} placeholder="List name"
        onBlur={(e) => commit(e.currentTarget.value, id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape") { e.stopPropagation(); setEditing(null) }
        }}
      />
    </SidebarMenuItem>
  )

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader data-tauri-drag-region>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => p.go("home")}>
              <img src="/mascot.png" alt="" className="size-8 shrink-0 rounded-lg bg-sidebar-accent" draggable={false} />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">Orlo</span>
                <span className="truncate text-xs text-muted-foreground">Tasks, notes & agents</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput ref={p.searchRef} value={p.q} onChange={(e) => p.setQ(e.target.value)} placeholder="Search or #tag" className="pl-8" />
          <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-2">
            <SidebarMenu>
              <SidebarMenuItem className="flex items-center gap-2">
                <SidebarMenuButton tooltip="New task" onClick={p.newTask}
                  className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground">
                  <Plus /><span>New task</span>
                </SidebarMenuButton>
                <Tip label={<>Command menu <Kbd>Ctrl K</Kbd></>}>
                  <Button size="icon" variant="outline" className="size-8 shrink-0 group-data-[collapsible=icon]:opacity-0" onClick={p.openPalette} aria-label="Command menu">
                    <Search />
                  </Button>
                </Tip>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu>
              {nav.map(([v, label, icon, n]) => (
                <SidebarMenuItem key={String(v)}>
                  <SidebarMenuButton tooltip={label} isActive={p.view === v} onClick={() => p.go(v)}>{icon}<span>{label}</span></SidebarMenuButton>
                  {n > 0 && <SidebarMenuBadge>{n}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Lists</SidebarGroupLabel>
          <SidebarGroupAction title="New list" onClick={() => setEditing("new")}><Plus /><span className="sr-only">New list</span></SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {p.lists.map((l) => editing === l.id ? field(l.id, l.name) : (
                <SidebarMenuItem key={l.id}>
                  <SidebarMenuButton tooltip={l.name} isActive={p.view === l.id} onClick={() => p.go(l.id)} onDoubleClick={() => setEditing(l.id)}>
                    <Hash /><span>{l.name}</span>
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<SidebarMenuAction showOnHover />}><Ellipsis /><span className="sr-only">More</span></DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" className="w-40">
                      <DropdownMenuItem onClick={() => setEditing(l.id)}><Pencil />Rename</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={async () => { await call("delete_list", { id: l.id }); if (p.view === l.id) p.go("tasks"); p.reload() }}>
                        <Trash2 />Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
              {editing === "new" && field("new")}
              {!p.lists.length && editing !== "new" && (
                <SidebarMenuItem>
                  <SidebarMenuButton className="text-muted-foreground" onClick={() => setEditing("new")}><Plus /><span>New list</span></SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {p.tags.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Tags</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {p.tags.map((g) => (
                  <SidebarMenuItem key={g}>
                    <SidebarMenuButton tooltip={g} isActive={p.view === `#${g}`} onClick={() => p.go(`#${g}`)}>
                      <span className="grid size-4 place-items-center"><span className="size-2 rounded-full" style={{ background: dot(g) }} /></span>
                      <span>{g}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarGroupLabel className="h-6">Agents</SidebarGroupLabel>
        <SidebarMenu>
          {p.clis.map((c) => {
            const busy = p.tasks.filter((t) => t.agent === c.name && p.running.includes(t.id)).length
            return (
              <SidebarMenuItem key={c.name}>
                <SidebarMenuButton size="sm" tooltip={c.path ? `${title(c.name)} · ${c.cap}` : `${title(c.name)} · not installed`} onClick={() => p.go("tasks")}>
                  <AgentIcon name={c.name} className={cn(!c.path && "opacity-40")} />
                  <span>{title(c.name)}</span>
                  <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", !c.path ? "bg-muted-foreground/40" : busy ? "animate-pulse bg-sky-400" : "bg-emerald-400")} />
                </SidebarMenuButton>
                {busy > 0 && <SidebarMenuBadge className="right-5">{busy}</SidebarMenuBadge>}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function Nothing({ searching, mode, onAdd }: { searching: boolean; mode: Mode; onAdd: () => void }) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia><img src="/mascot.png" alt="" className="size-20" draggable={false} /></EmptyMedia>
        <EmptyTitle>{searching ? "No results" : mode === "note" ? "No notes yet" : "All clear"}</EmptyTitle>
        <EmptyDescription>
          {searching ? "Nothing matches that search. Try fewer words or a different #tag." : mode === "note" ? "Capture ideas, meeting notes and anything worth keeping." : "Nothing here right now. Add a task or hand one to an agent."}
        </EmptyDescription>
      </EmptyHeader>
      {!searching && <EmptyContent><Button size="sm" onClick={onAdd}><Plus />{mode === "note" ? "New note" : "New task"} <Kbd className="bg-primary-foreground/15 text-primary-foreground">N</Kbd></Button></EmptyContent>}
    </Empty>
  )
}

function TagBadge({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className="size-1.5 rounded-full" style={{ background: dot(tag) }} />{tag}
      {onRemove && <button onClick={onRemove} aria-label={`Remove ${tag}`} className="-mr-1 text-muted-foreground hover:text-foreground"><X className="size-3" /></button>}
    </Badge>
  )
}

function AgentBadge({ t, live, row }: { t: Task; live: boolean; row?: boolean }) {
  if (!t.agent) return null
  const s = agentState(t, live)
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      {live ? <Spinner className="size-3 text-sky-400" /> : <span className={cn("size-1.5 rounded-full", toneDot[s.tone])} />}
      <AgentIcon name={t.agent} className="size-3" />{title(t.agent)}<span className={cn(row && "hidden @md/row:inline")}>· {s.label}</span>
    </Badge>
  )
}

function DueText({ t }: { t: Task }) {
  if (!t.due || t.kind !== "task") return null
  const done = t.status === "done"
  const overdue = !done && t.due < today()
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs tabular-nums", overdue ? "text-destructive" : "text-muted-foreground")}>
      {overdue ? <TriangleAlert className="size-3" /> : <CalendarDays className="size-3" />}{dueLabel(t.due)}
    </span>
  )
}

// Thin wrapper around the shadcn Select so every picker looks the same.
function Choice({ value, options, onChange, icon, className }: {
  value: string; options: [string, React.ReactNode, boolean?][]; onChange: (v: string) => void; icon?: React.ReactNode; className?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(String(v))} items={options.map(([value, label]) => ({ value, label }))}>
      <SelectTrigger size="sm" className={cn("gap-1.5 border-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted", className)}>
        {icon}<SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-44">
        {options.map(([v, l, off]) => <SelectItem key={v} value={v} disabled={off}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

// CLI, model and reasoning for a delegation. Grok's model flags aren't known, so it only gets the CLI choice.
function AgentPick({ clis, v, set }: { clis: Cli[]; v: Pick; set: (p: Pick) => void }) {
  const models = MODELS[v.agent] ?? []
  return (
    <>
      <Choice
        value={v.agent || "none"} icon={v.agent ? undefined : <Bot />}
        onChange={(a) => set(a === "none" ? noPick : { ...noPick, agent: a })}
        options={[["none", "No agent"], ...clis.map((c): [string, React.ReactNode, boolean] => [c.name, <><AgentIcon name={c.name} />{title(c.name)} Agent</>, !c.path])]}
      />
      {models.length > 0 && <>
        <Choice value={v.model || "default"} onChange={(m) => set({ ...v, model: m === "default" ? "" : m })}
          options={[["default", "Default model"], ...models.map((m): [string, string] => [m, m])]} />
        <Choice value={v.effort || "default"} onChange={(x) => set({ ...v, effort: x === "default" ? "" : x })}
          options={[["default", "Default reasoning"], ...EFFORTS[v.agent].map((x): [string, string] => [x, `${title(x)} reasoning`])]} />
      </>}
    </>
  )
}

function DuePick({ due, set, className }: { due: string | null; set: (d: string | null) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const pick = (d: string | null) => { set(d); setOpen(false) }
  const overdue = due != null && due < today()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className={cn("font-normal", !due && "text-muted-foreground", overdue && "text-destructive", className)} />}>
        <CalendarDays />{due ? dueLabel(due) : "Due date"}
      </PopoverTrigger>
      <PopoverContent className="w-auto gap-0 p-0" align="start">
        <div className="flex flex-wrap gap-1 border-b p-2">
          <Button variant="outline" size="xs" onClick={() => pick(today())}>Today</Button>
          <Button variant="outline" size="xs" onClick={() => pick(inDays(1))}>Tomorrow</Button>
          <Button variant="outline" size="xs" onClick={() => pick(inDays(7))}>Next week</Button>
          {due && <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => pick(null)}>Clear</Button>}
        </div>
        <Calendar mode="single" selected={due ? new Date(due + "T00:00") : undefined} onSelect={(d) => pick(d ? ymd(d) : null)} />
      </PopoverContent>
    </Popover>
  )
}

// Find-or-create tag picker (Popover + Command); optionally also hands the task to an agent.
function TagPicker({ has, known, toggle, onDelegate, clis, trigger, align = "start", children }: {
  has: string[]; known: string[]; toggle: (g: string) => void; trigger: React.ReactElement; align?: "start" | "end"
  onDelegate?: (agent: string) => void; clis?: Cli[]; children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const all = [...new Set([...has, ...TEMPLATE_TAGS, ...known])]
  const s = q.replace(/,/g, "").trim()
  const exact = all.find((g) => g.toLowerCase() === s.toLowerCase())
  const pick = (g: string) => { toggle(g); setQ("") }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ("") }}>
      <PopoverTrigger render={trigger} onClick={(e) => e.stopPropagation()}>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-0" onClick={(e) => e.stopPropagation()}>
        <Command>
          <CommandInput value={q} onValueChange={setQ} placeholder="Find or create a tag…" />
          <CommandList>
            <CommandEmpty>No tags.</CommandEmpty>
            {s && !exact && (
              <CommandGroup>
                <CommandItem value={`create ${s}`} onSelect={() => pick(s)}><Plus />Create “{s}”</CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Tags">
              {all.map((g) => (
                <CommandItem key={g} value={g} onSelect={() => pick(g)} data-checked={has.includes(g)}>
                  <span className="size-2 rounded-full" style={{ background: dot(g) }} />{g}
                </CommandItem>
              ))}
            </CommandGroup>
            {onDelegate && clis && <>
              <CommandSeparator />
              <CommandGroup heading="Delegate to agent">
                {clis.map((c) => (
                  <CommandItem key={c.name} value={`agent ${c.name}`} disabled={!c.path} onSelect={() => { setOpen(false); onDelegate(c.name) }}>
                    <AgentIcon name={c.name} />{title(c.name)} Agent<CommandShortcut>{c.path ? c.cap : "not installed"}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Quick add in the shape of shadcn's prompt input: title on top, options in a toolbar below.
function Composer({ kind, clis, tags, inputRef, onAdd }: {
  kind: Mode; clis: Cli[]; tags: string[]; inputRef: React.RefObject<HTMLInputElement | null>
  onAdd: (text: string, tags: string[], agent: Pick, kind: Mode, due: string | null) => void
}) {
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [agent, setAgent] = useState<Pick>(noPick)
  const [due, setDue] = useState<string | null>(null)
  const submit = () => {
    if (!text.trim()) return inputRef.current?.focus()
    onAdd(text.trim(), picked, agent, kind, due)
    setText(""); setPicked([]); setAgent(noPick); setDue(null)
  }
  return (
    <InputGroup className="h-auto bg-card! shadow-xs">
      <InputGroupInput
        ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={kind === "note" ? "New note title…" : "Add a task… (type #tag to tag it)"}
        className="h-11 px-3.5 text-sm"
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") e.currentTarget.blur() }}
      />
      <InputGroupAddon align="block-end" className="flex-wrap gap-1 border-t px-2 py-1.5">
        <TagPicker
          has={picked} known={tags} toggle={(g) => setPicked(picked.includes(g) ? picked.filter((x) => x !== g) : [...picked, g])}
          trigger={<Button variant="ghost" size="sm" className={cn("font-normal", !picked.length && "text-muted-foreground")} />}
        ><Tag />{picked.length ? "" : "Tags"}</TagPicker>
        {picked.map((g) => <TagBadge key={g} tag={g} onRemove={() => setPicked(picked.filter((x) => x !== g))} />)}
        {kind === "task" && <>
          <DuePick due={due} set={setDue} />
          <AgentPick clis={clis} v={agent} set={setAgent} />
        </>}
        <InputGroupButton variant="default" size="sm" className="ml-auto" onClick={submit}>
          {agent.agent ? <><Sparkles />Add & delegate</> : "Add"}<CornerDownLeft />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

// Right-click menu shared by rows and cards.
function TaskMenu({ t, ctx, className, children, ...rest }: {
  t: Task; ctx: Ctx; className?: string; children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  const isTask = t.kind === "task"
  const done = t.status === "done"
  const canDelegate = isTask && !t.session_id && !ctx.running.includes(t.id) && !done
  const has = tagList(t.tags)
  return (
    <ContextMenu>
      <ContextMenuTrigger {...rest} onClick={() => ctx.open(t)} className={className} data-selected={ctx.sel === t.id || undefined}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => ctx.open(t)}>Open<ContextMenuShortcut>Enter</ContextMenuShortcut></ContextMenuItem>
        {isTask && <ContextMenuItem onClick={() => ctx.toggle(t)}>{done ? "Reopen" : "Complete"}<ContextMenuShortcut>Space</ContextMenuShortcut></ContextMenuItem>}
        <ContextMenuSeparator />
        {isTask && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><CalendarDays />Due date</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => ctx.save({ ...t, due: today() })}>Today</ContextMenuItem>
              <ContextMenuItem onClick={() => ctx.save({ ...t, due: inDays(1) })}>Tomorrow</ContextMenuItem>
              <ContextMenuItem onClick={() => ctx.save({ ...t, due: inDays(7) })}>Next week</ContextMenuItem>
              <ContextMenuItem disabled={!t.due} onClick={() => ctx.save({ ...t, due: null })}>No date</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger><Hash />Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem disabled={t.list_id == null} onClick={() => ctx.save({ ...t, list_id: null })}>No list</ContextMenuItem>
            {ctx.lists.map((l) => (
              <ContextMenuItem key={l.id} disabled={t.list_id === l.id} onClick={() => ctx.save({ ...t, list_id: l.id })}>{l.name}</ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger><Tag />Tags</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {[...new Set([...TEMPLATE_TAGS, ...ctx.tags])].map((g) => (
              <ContextMenuCheckboxItem key={g} checked={has.includes(g)} onCheckedChange={() => ctx.save(withTag(t, g))}>
                <span className="size-2 rounded-full" style={{ background: dot(g) }} />{g}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {canDelegate && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><Bot />Delegate</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {ctx.clis.map((c) => (
                <ContextMenuItem key={c.name} disabled={!c.path} onClick={() => ctx.delegate(t, { ...noPick, agent: c.name })}>
                  <AgentIcon name={c.name} />{title(c.name)} Agent{!c.path && <ContextMenuShortcut>not installed</ContextMenuShortcut>}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => ctx.remove(t)}><Trash2 />Delete<ContextMenuShortcut>Del</ContextMenuShortcut></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function Done({ t, ctx, className }: { t: Task; ctx: Ctx; className?: string }) {
  return (
    <Checkbox
      checked={t.status === "done"} onCheckedChange={() => ctx.toggle(t)} onClick={(e) => e.stopPropagation()}
      aria-label={t.status === "done" ? "Reopen" : "Complete"} className={cn("size-[18px] rounded-full", className)}
    />
  )
}

function Row({ t, ctx, listName, compact }: { t: Task; ctx: Ctx; listName?: string; compact?: boolean }) {
  const done = t.status === "done"
  const live = ctx.running.includes(t.id)
  const tags = tagList(t.tags)
  return (
    <TaskMenu
      t={t} ctx={ctx}
      className={cn("group/row @container/row flex h-11 cursor-default items-center gap-3 border-b border-border/60 text-sm transition-colors hover:bg-muted/40 data-selected:bg-muted/70",
        compact ? "rounded-md border-0 px-2" : "px-6", ctx.fresh === t.id && "orlo-new")}
    >
      <Done t={t} ctx={ctx} />
      <span className={cn("min-w-24 flex-1 truncate", done && "text-muted-foreground line-through")}>{t.title}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="hidden items-center gap-1.5 @xl/row:flex">
          {tags.slice(0, 2).map((g) => <TagBadge key={g} tag={g} />)}
          {tags.length > 2 && <Badge variant="outline" className="font-normal text-muted-foreground">+{tags.length - 2}</Badge>}
        </span>
        <AgentBadge t={t} live={live} row />
        {listName && <span className="hidden items-center gap-0.5 text-xs text-muted-foreground @3xl/row:inline-flex"><Hash className="size-3" />{listName}</span>}
        <DueText t={t} />
        {!compact && (
          <TagPicker
            has={tags} known={ctx.tags} toggle={(g) => ctx.save(withTag(t, g))} align="end"
            clis={ctx.clis} onDelegate={!t.session_id && !live && !done ? (a) => ctx.delegate(t, { ...noPick, agent: a }) : undefined}
            trigger={<Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 data-popup-open:opacity-100" aria-label="Tags and agents" />}
          ><Tag /></TagPicker>
        )}
      </span>
    </TaskMenu>
  )
}

function TaskCard({ t, ctx }: { t: Task; ctx: Ctx }) {
  const done = t.status === "done"
  return (
    <TaskMenu
      t={t} ctx={ctx} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", String(t.id))}
      className={cn("block cursor-grab rounded-xl outline-none active:cursor-grabbing data-selected:*:ring-ring", ctx.fresh === t.id && "orlo-enter")}
    >
      <Card size="sm" className="gap-2 transition-shadow hover:ring-foreground/20">
        <CardHeader className="flex items-start gap-2.5">
          <Done t={t} ctx={ctx} className="mt-px" />
          <CardTitle className={cn("text-sm font-normal", done && "text-muted-foreground line-through")}>{t.title}</CardTitle>
        </CardHeader>
        {(t.notes || t.tags || t.agent || t.due) && (
          <CardContent className="flex flex-col gap-2 pl-[38px]">
            {t.notes && <p className="line-clamp-2 text-xs text-muted-foreground">{plain(t.notes)}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              {tagList(t.tags).map((g) => <TagBadge key={g} tag={g} />)}
              <AgentBadge t={t} live={ctx.running.includes(t.id)} />
              <DueText t={t} />
            </div>
          </CardContent>
        )}
      </Card>
    </TaskMenu>
  )
}

function NoteCard({ t, ctx }: { t: Task; ctx: Ctx }) {
  return (
    <TaskMenu t={t} ctx={ctx} className={cn("block cursor-default rounded-xl outline-none data-selected:*:ring-ring", ctx.fresh === t.id && "orlo-enter")}>
      <Card className="h-44 transition-shadow hover:ring-foreground/20">
        <CardHeader>
          <CardTitle className="truncate">{t.title}</CardTitle>
          <CardDescription className="line-clamp-4 whitespace-pre-wrap">{plain(t.notes) || "Empty note"}</CardDescription>
        </CardHeader>
        {t.tags && <CardContent className="mt-auto flex flex-wrap gap-1">{tagList(t.tags).map((g) => <TagBadge key={g} tag={g} />)}</CardContent>}
      </Card>
    </TaskMenu>
  )
}

function Board({ tasks, ctx }: { tasks: Task[]; ctx: Ctx }) {
  const [over, setOver] = useState<string | null>(null)
  const withAgent = (t: Task) => t.status !== "done" && !!t.agent && (ctx.running.includes(t.id) || needsYou(t, false))
  const cols: { id: string; name: string; dot: string; items: Task[]; status?: string }[] = [
    { id: "todo", name: "To do", dot: "bg-muted-foreground", items: tasks.filter((t) => t.status !== "done" && !withAgent(t)), status: "open" },
    { id: "agents", name: "With agents", dot: "bg-sky-400", items: tasks.filter(withAgent) },
    { id: "done", name: "Done", dot: "bg-emerald-400", items: tasks.filter((t) => t.status === "done"), status: "done" },
  ]
  return (
    <div className="grid min-w-[600px] grid-cols-3 gap-3 px-6 pb-8">
      {cols.map((c) => (
        <div
          key={c.id}
          onDragOver={(e) => { if (c.status) { e.preventDefault(); setOver(c.id) } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            setOver(null)
            const t = tasks.find((x) => x.id === Number(e.dataTransfer.getData("text/plain")))
            if (t && c.status && t.status !== c.status) ctx.save({ ...t, status: c.status })
          }}
          className={cn("flex min-h-72 flex-col gap-2 rounded-xl bg-muted/30 p-2 ring-1 ring-transparent transition-colors", over === c.id && "bg-muted/60 ring-ring")}
        >
          <div className="flex h-7 items-center gap-2 px-1.5 text-sm font-medium">
            <span className={cn("size-2 rounded-full", c.dot)} />{c.name}
            <span className="text-muted-foreground tabular-nums">{c.items.length}</span>
          </div>
          {c.items.map((t) => <TaskCard key={t.id} t={t} ctx={ctx} />)}
          {!c.items.length && <p className="px-2 py-8 text-center text-xs text-muted-foreground">{c.status ? "Drop tasks here" : "Delegated tasks show up here"}</p>}
        </div>
      ))}
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

function Home({ tasks, ctx, go, setLayout, composer }: { tasks: Task[]; ctx: Ctx; go: (v: View) => void; setLayout: (l: Layout) => void; composer: React.ReactNode }) {
  const t0 = today()
  const open = tasks.filter((t) => t.kind === "task" && t.status !== "done")
  const overdue = open.filter((t) => t.due != null && t.due < t0)
  const dueToday = open.filter((t) => t.due === t0)
  const review = tasks.filter((t) => needsYou(t, ctx.running.includes(t.id)))
  const agentTasks = tasks.filter((t) => t.agent).sort((a, b) => Number(ctx.running.includes(b.id)) - Number(ctx.running.includes(a.id)) || b.id - a.id).slice(0, 5)
  const upNext = [...overdue, ...dueToday, ...open.filter((t) => t.due == null)].slice(0, 6)
  const notes = tasks.filter((t) => t.kind === "note").slice(-3).reverse()
  const done = tasks.filter((t) => t.kind === "task" && t.status === "done").length
  const pct = done + open.length ? Math.round((done / (done + open.length)) * 100) : 0
  const board = () => { setLayout("board"); go("tasks") }

  const stats: { label: string; n: number; icon: React.ReactNode; foot: string; sub: string; go: () => void }[] = [
    { label: "Due today", n: dueToday.length, icon: <Star />, foot: "Today", sub: dueToday.length ? "Keep the streak going" : "Nothing due today", go: () => go("tasks") },
    { label: "Overdue", n: overdue.length, icon: <TriangleAlert />, foot: "Past due", sub: overdue.length ? "Reschedule or finish these" : "You're on top of it", go: () => go("tasks") },
    { label: "Agents working", n: ctx.running.length, icon: <Sparkles />, foot: "Live", sub: ctx.running.length ? "Streaming progress now" : "No runs in progress", go: board },
    { label: "Needs you", n: review.length, icon: <MessageSquareText />, foot: "Review", sub: review.length ? "Approve or ask for changes" : "No reviews waiting", go: board },
  ]

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{greeting()}</h2>
        <p className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · {open.length} open task{open.length === 1 ? "" : "s"}
        </p>
      </div>
      {composer}

      <div className="grid grid-cols-2 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @4xl/main:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} onClick={s.go} className="cursor-pointer transition-shadow hover:ring-foreground/20">
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">{s.n}</CardTitle>
              <CardAction><Badge variant="outline" className="text-muted-foreground">{s.icon}{s.foot}</Badge></CardAction>
            </CardHeader>
            <CardFooter className="text-sm text-muted-foreground">{s.sub}</CardFooter>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 @4xl/main:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Up next</CardTitle>
            <CardDescription>{done} of {done + open.length} tasks done</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={() => go("tasks")}>View all<ArrowUpRight /></Button></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Progress value={pct} />
            <div className="-mx-2 flex flex-col">
              {upNext.length ? upNext.map((t) => <Row key={t.id} t={t} ctx={ctx} compact />) : (
                <p className="py-8 text-center text-sm text-muted-foreground">All clear. Enjoy it.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent activity</CardTitle>
            <CardDescription>Claude, Codex and Grok runs</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={board}>Board<ArrowUpRight /></Button></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {agentTasks.length ? agentTasks.map((t) => {
              const live = ctx.running.includes(t.id)
              const s = agentState(t, live)
              return (
                <Item key={t.id} size="sm" className="-mx-2 cursor-pointer hover:bg-muted/50" onClick={() => ctx.open(t)}>
                  <ItemMedia variant="icon">{live ? <Spinner className="text-sky-400" /> : <AgentIcon name={t.agent} />}</ItemMedia>
                  <ItemContent>
                    <ItemTitle className="line-clamp-1">{t.title}</ItemTitle>
                    <ItemDescription className="flex items-center gap-1.5">
                      <span className={cn("size-1.5 rounded-full", toneDot[s.tone])} />{title(t.agent!)} · {s.label}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )
            }) : (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Bot /></EmptyMedia>
                  <EmptyTitle className="text-sm">No agent runs yet</EmptyTitle>
                  <EmptyDescription className="text-xs">Pick an agent in the task bar above, or right-click a task and choose Delegate.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent notes</h3>
          <Button variant="ghost" size="sm" onClick={() => go("notes")}>All notes<ArrowUpRight /></Button>
        </div>
        <div className="grid grid-cols-2 gap-4 @4xl/main:grid-cols-4">
          {notes.map((t) => <NoteCard key={t.id} t={t} ctx={ctx} />)}
          <button onClick={() => go("notes")} className="grid h-44 place-items-center rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground">
            <span className="flex items-center gap-1.5"><Plus className="size-4" />New note</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function Bells({ notifs, unread, setNotifs, openTask }: {
  notifs: Notif[]; unread: number; setNotifs: React.Dispatch<React.SetStateAction<Notif[]>>; openTask: (id: number) => void
}) {
  const ago = (at: number) => {
    const m = Math.round((Date.now() - at) / 6e4)
    return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  }
  return (
    <Popover onOpenChange={(o) => !o && setNotifs((ns) => ns.map((n) => ({ ...n, read: true })))}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="Notifications" />}>
        <Bell />
        {unread > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-sky-400 ring-2 ring-background" />}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">Notifications</p>
          {notifs.length > 0 && <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setNotifs([])}>Clear all</Button>}
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {notifs.length ? notifs.map((n) => (
            <Item key={n.id} size="sm" className={cn("rounded-md", n.task_id != null && "cursor-pointer hover:bg-muted/50")} onClick={() => n.task_id != null && openTask(n.task_id)}>
              <ItemMedia variant="icon">
                {n.tone === "done" ? <CircleCheck className="text-emerald-400" /> : n.tone === "warn" ? <MessageSquareText className="text-amber-400" /> : n.task_id == null ? <Star /> : <Bot className="text-violet-400" />}
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="line-clamp-1">{n.title}</ItemTitle>
                <ItemDescription>{n.text}</ItemDescription>
              </ItemContent>
              <ItemActions className="flex-col items-end gap-1 self-start text-xs text-muted-foreground">
                {ago(n.at)}{!n.read && <span className="size-1.5 rounded-full bg-sky-400" />}
              </ItemActions>
            </Item>
          )) : (
            <Empty className="p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Bell /></EmptyMedia>
                <EmptyTitle className="text-sm">You're all caught up</EmptyTitle>
                <EmptyDescription className="text-xs">Agent results and reminders land here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Updates come from GitHub releases. The check runs at launch, every 6 hours and from the palette;
// "Update" downloads the new exe, checks its SHA-256 and restarts Orlo (install_update in lib.rs).
const REPO = "carbongotfound/orlo"
type Release = { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string; digest?: string }[] }

const newer = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

async function checkUpdate(manual: boolean) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) throw new Error(String(res.status))
    const r: Release = await res.json()
    const [v, mine] = [r.tag_name.replace(/^v/, ""), await getVersion()]
    if (!newer(v, mine)) return void (manual && toast.success(`Orlo ${mine} is the latest version`))
    const exe = r.assets.find((a) => a.name === `Orlo-${v}-windows-x64.exe`)
    toast(`Orlo ${v} is available`, {
      id: "update",
      duration: Infinity,
      closeButton: true,
      description: exe?.digest ? `You have ${mine}. Updating restarts Orlo and stops running agents.` : `Download it from github.com/${REPO}/releases`,
      action: exe?.digest ? {
        label: "Update",
        onClick: async () => {
          toast.loading(`Downloading Orlo ${v}…`, { id: "update", duration: Infinity, description: undefined })
          try { await invoke("install_update", { url: exe.browser_download_url, sha256: exe.digest }) }
          catch (e) { toast.error("Update failed", { id: "update", duration: 8000, description: String(e) }) }
        },
      } : undefined,
    })
  } catch {
    if (manual) toast.error("Couldn't reach GitHub to check for updates")
  }
}

function Palette({ open, setOpen, tasks, lists, tags, layout, run }: {
  open: boolean; setOpen: (b: boolean) => void; tasks: Task[]; lists: List[]; tags: string[]; layout: Layout
  run: { newTask: () => void; newNote: () => void; go: (v: View) => void; open: (t: Task) => void; setLayout: (l: Layout) => void; intro: () => void; update: () => void }
}) {
  const [q, setQ] = useState("")
  const act = (fn: () => void) => () => { setOpen(false); setQ(""); fn() }
  const views: [View, string, React.ReactNode][] = [
    ["home", "Home", <LayoutDashboard />], ["tasks", "Tasks", <ListTodo />], ["notes", "Notes", <FileText />],
  ]
  return (
    <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ("") }} className="sm:max-w-xl">
      <Command>
        <CommandInput value={q} onValueChange={setQ} placeholder="Search tasks and notes, or type a command…" />
        <CommandList className="max-h-96">
          <CommandEmpty>No results.</CommandEmpty>
          {q.trim() && (
            <CommandGroup heading="Tasks & notes">
              {tasks.slice().reverse().map((t) => (
                <CommandItem key={t.id} value={`${t.title} ${t.tags} #${t.id}`} onSelect={act(() => run.open(t))}>
                  {t.kind === "note" ? <FileText /> : <CircleCheck className={cn(t.status === "done" && "text-emerald-400")} />}
                  <span className="truncate">{t.title}</span>
                  <CommandShortcut>{t.kind === "note" ? "Note" : t.status === "done" ? "Done" : "Task"}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Create">
            <CommandItem onSelect={act(run.newTask)}><Plus />New task<CommandShortcut>N</CommandShortcut></CommandItem>
            <CommandItem onSelect={act(run.newNote)}><FileText />New note</CommandItem>
          </CommandGroup>
          <CommandGroup heading="Go to">
            {views.map(([v, label, icon]) => <CommandItem key={String(v)} value={`go ${label}`} onSelect={act(() => run.go(v))}>{icon}{label}</CommandItem>)}
            {lists.map((l) => <CommandItem key={l.id} value={`list ${l.name}`} onSelect={act(() => run.go(l.id))}><Hash />{l.name}<CommandShortcut>List</CommandShortcut></CommandItem>)}
            {tags.map((g) => (
              <CommandItem key={g} value={`tag ${g}`} onSelect={act(() => run.go(`#${g}`))}>
                <span className="mx-1 size-2 rounded-full" style={{ background: dot(g) }} />{g}<CommandShortcut>Tag</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Help">
            <CommandItem onSelect={act(run.intro)}><Sparkles />Show the Orlo introduction</CommandItem>
            <CommandItem onSelect={act(run.update)}><Download />Check for updates</CommandItem>
          </CommandGroup>
          <CommandGroup heading="View">
            <CommandItem onSelect={act(() => run.setLayout(layout === "list" ? "board" : "list"))}>
              {layout === "list" ? <Columns3 /> : <Rows3 />}{layout === "list" ? "Switch to board" : "Switch to list"}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

function Prop({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-start gap-2 text-sm">
      <span className="flex h-8 w-24 shrink-0 items-center gap-2 text-muted-foreground [&_svg]:size-4">{icon}{label}</span>
      <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

function Detail({ task, ctx, thread, live, isRunning, where, close, reply, stop }: {
  task: Task; ctx: Ctx; thread: Ev[]; live: string; isRunning: boolean; where: string
  close: () => void; reply: (text: string) => void; stop: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const latest = useRef(task)
  latest.current = task
  const [pick, setPick] = useState<Pick>(noPick)
  const [answer, setAnswer] = useState("")
  // Braced body: WebView2's scrollIntoView returns a Promise, which React would treat as a cleanup function.
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }) }, [thread.length, live])
  const isTask = task.kind === "task"
  const cli = ctx.clis.find((c) => c.name === task.agent)
  const done = task.status === "done"
  const own = tagList(task.tags)
  const save = ctx.save
  const state = agentState(task, isRunning)
  const send = () => { if (answer.trim()) { reply(answer.trim()); setAnswer("") } }

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l bg-background duration-200 animate-in fade-in-0 slide-in-from-right-4">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-4 text-sm">
        <span className="truncate text-muted-foreground">{where}</span>
        <span className="text-muted-foreground">/</span>
        <span className="truncate">{isTask ? "Task" : "Note"}</span>
        <div className="ml-auto flex gap-0.5">
          <Tip label={<>Delete <Kbd>Del</Kbd></>}>
            <Button variant="ghost" size="icon-sm" onClick={() => ctx.remove(task)} aria-label="Delete"><Trash2 /></Button>
          </Tip>
          <Tip label={<>Close <Kbd>Esc</Kbd></>}>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close"><X /></Button>
          </Tip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex items-start gap-3">
            {isTask && <Done t={task} ctx={ctx} className="mt-2" />}
            <Textarea
              defaultValue={task.title} rows={1}
              className={cn("min-h-0 resize-none rounded-none border-0 bg-transparent p-0 text-xl leading-snug font-semibold tracking-tight shadow-none focus-visible:ring-0 dark:bg-transparent", done && "text-muted-foreground line-through")}
              onBlur={(e) => e.target.value.trim() && e.target.value !== task.title && save({ ...task, title: e.target.value.trim() })}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() } }}
            />
          </div>

          <div className="flex flex-col">
            {isTask && (
              <Prop icon={<CircleCheck />} label="Status">
                <Button variant="ghost" size="sm" className="font-normal" onClick={() => ctx.toggle(task)}>
                  <span className={cn("size-2 rounded-full", done ? "bg-emerald-400" : "bg-muted-foreground")} />{done ? "Done" : "To do"}
                </Button>
              </Prop>
            )}
            {isTask && <Prop icon={<CalendarDays />} label="Due"><DuePick due={task.due} set={(d) => save({ ...task, due: d })} /></Prop>}
            <Prop icon={<Hash />} label="List">
              <Choice value={String(task.list_id ?? "none")} onChange={(v) => save({ ...task, list_id: v === "none" ? null : Number(v) })}
                options={[["none", "No list"], ...ctx.lists.map((l): [string, string] => [String(l.id), l.name])]} />
            </Prop>
            <Prop icon={<Tag />} label="Tags">
              {own.map((g) => <TagBadge key={g} tag={g} onRemove={() => save(withTag(task, g))} />)}
              <TagPicker
                has={own} known={ctx.tags} toggle={(g) => save(withTag(task, g))}
                trigger={<Button variant="ghost" size="sm" className="font-normal text-muted-foreground" />}
              ><Plus />Add tag</TagPicker>
            </Prop>
            {isTask && (
              <Prop icon={<Bot />} label="Agent">
                {task.agent ? (
                  <div className="flex flex-col gap-1 py-1.5">
                    <AgentBadge t={task} live={isRunning} />
                    <span className="text-xs text-muted-foreground">
                      {[task.model || "default model", task.effort && `${task.effort} reasoning`, cli && `cap ${cli.cap}`].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ) : !done ? (
                  <>
                    <AgentPick clis={ctx.clis} v={pick} set={setPick} />
                    {pick.agent && <Button size="sm" className="mt-1" onClick={() => ctx.delegate(task, pick)}><Sparkles />Start {title(pick.agent)} Agent</Button>}
                  </>
                ) : <span className="text-muted-foreground">—</span>}
              </Prop>
            )}
          </div>

          <Separator />

          <MdEditor
            value={task.notes} className={isTask ? "min-h-24" : "min-h-80"}
            hint={isTask ? "Add notes or context for the agent… Markdown works: # heading, - list, - [ ] checklist" : "Write something… # for a heading, - for a list, - [ ] for a checklist"}
            onChange={(notes) => save({ ...latest.current, notes })}
          />

          {(task.agent || isRunning) && <>
            <Marker variant="separator"><MarkerContent>Agent activity</MarkerContent></Marker>
            <MessageGroup className="gap-3 select-text">
              {thread.map((ev, i) => <Activity key={i} ev={ev} agent={title(task.agent ?? "agent")} />)}
              {live && (
                <Message>
                  <MessageContent>
                    <Bubble variant="ghost"><BubbleContent className="whitespace-pre-wrap">{live}<span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-foreground align-middle" /></BubbleContent></Bubble>
                  </MessageContent>
                </Message>
              )}
              {isRunning && !live && <Marker><MarkerIcon><Spinner /></MarkerIcon><MarkerContent>Thinking…</MarkerContent></Marker>}
              <div ref={end} />
            </MessageGroup>
          </>}
        </div>
      </div>

      {isRunning ? (
        <div className="flex shrink-0 items-center gap-2 border-t px-4 py-3 text-sm">
          <Spinner className="text-sky-400" />
          <AgentIcon name={task.agent} />
          <span>{title(task.agent ?? "")} Agent is working</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={stop}><Square className="size-3 fill-current" />Stop</Button>
        </div>
      ) : task.session_id && !done && (
        <div className="flex shrink-0 flex-col gap-2 border-t p-3 duration-200 animate-in fade-in-0 slide-in-from-bottom-2">
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", toneDot[state.tone])} />{title(task.agent ?? "")} Agent · {state.label}
          </div>
          <InputGroup>
            <InputGroupTextarea
              value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
              placeholder={state.tone === "warn" ? "Answer the agent…" : "Ask for changes…"}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }}
            />
            <InputGroupAddon align="block-end">
              <InputGroupButton variant="ghost" size="sm" onClick={send}>Send<CornerDownLeft /></InputGroupButton>
              <InputGroupButton variant="default" size="sm" className="ml-auto" onClick={() => save({ ...task, status: "done" })}><Check />Approve</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
    </aside>
  )
}

function Activity({ ev, agent }: { ev: Ev; agent: string }) {
  // The ORLO_STATUS line is for Orlo, not for reading.
  const text = ev.text.replace(/^\s*`?ORLO_STATUS:.*$/gim, "").trim()
  switch (ev.kind) {
    case "prompt":
    case "reply":
      return (
        <Message align="end">
          <MessageContent>
            <Bubble variant="secondary" align="end"><BubbleContent className="whitespace-pre-wrap">{ev.text.split(/\n\nDo not delete files/)[0]}</BubbleContent></Bubble>
          </MessageContent>
        </Message>
      )
    case "tool":
      return <Marker><MarkerIcon><Wrench /></MarkerIcon><MarkerContent className="truncate font-mono text-xs">{ev.text}</MarkerContent></Marker>
    case "log":
      return <p className="font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">{ev.text}</p>
    case "hint":
      return <Marker className="text-destructive"><MarkerIcon><TriangleAlert /></MarkerIcon><MarkerContent>{ev.text}</MarkerContent></Marker>
    case "verdict": {
      const [label, tone]: [string, Tone] = ev.text === "complete" ? ["Done — the task checked itself off", "done"] : ev.text === "input" ? ["Needs your input", "warn"] : ["Ready for your review", "review"]
      return <Marker><MarkerIcon><span className={cn("mx-auto block size-2 rounded-full", toneDot[tone])} /></MarkerIcon><MarkerContent className="text-foreground">{label}</MarkerContent></Marker>
    }
    case "cost":
    case "end":
      return <Marker variant="separator"><MarkerContent className="text-xs">{ev.text}</MarkerContent></Marker>
    default:
      return text ? (
        <Message>
          <MessageContent>
            <MessageHeader className="flex items-center gap-1.5 px-0"><AgentIcon name={agent.toLowerCase()} className="size-3.5" />{agent} Agent</MessageHeader>
            <Bubble variant="ghost"><BubbleContent><MdView text={text} /></BubbleContent></Bubble>
          </MessageContent>
        </Message>
      ) : null
  }
}

const CONFETTI = ["#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#f87171", "#fafafa"]

// A burst from the middle of the screen; random once per mount.
function Confetti() {
  const bits = useMemo(() => Array.from({ length: 90 }, (_, i) => {
    const a = Math.random() * Math.PI * 2
    const r = 140 + Math.random() * 260
    return {
      i, color: CONFETTI[i % CONFETTI.length], w: 6 + Math.random() * 6, round: i % 3 === 0,
      style: {
        "--dx": `${Math.cos(a) * r}px`, "--dy": `${Math.sin(a) * r - 120}px`, "--rot": `${(Math.random() - 0.5) * 900}deg`,
        animationDelay: `${Math.random() * 120}ms`,
      } as React.CSSProperties,
    }
  }), [])
  return (
    <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2">
      {bits.map((b) => (
        <span key={b.i} className={cn("orlo-confetti absolute", b.round ? "rounded-full" : "rounded-[2px]")}
          style={{ ...b.style, background: b.color, width: b.w, height: b.round ? b.w : b.w * 0.45 }} />
      ))}
    </div>
  )
}

function Celebrate({ party, done }: { party: Party; done: () => void }) {
  useEffect(() => {
    const t = setTimeout(done, 4600)
    return () => clearTimeout(t)
  }, [])
  return (
    <div role="status" onClick={done} className="fixed inset-0 z-[60] grid cursor-pointer place-items-center bg-background/50 backdrop-blur-sm duration-300 animate-in fade-in-0">
      <Confetti />
      <div className="relative flex flex-col items-center gap-5">
        <div className="relative">
          <div className="orlo-glow absolute inset-0 -z-10 rounded-full bg-sidebar-primary/40 blur-3xl" />
          {["♥", "✦", "♥", "✦", "♥"].map((c, i) => (
            <span key={i} className="orlo-rise absolute text-xl" style={{ left: `${10 + i * 20}%`, top: "30%", color: CONFETTI[i + 1], animationDelay: `${300 + i * 180}ms` }}>{c}</span>
          ))}
          <img src="/mascot.png" alt="" className="orlo-jump size-40 drop-shadow-2xl" draggable={false} />
        </div>
        <div className="flex flex-col items-center gap-1 rounded-2xl border bg-card px-6 py-4 text-center shadow-2xl delay-300 duration-500 fill-mode-both animate-in fade-in-0 zoom-in-90 slide-in-from-bottom-4">
          <p className="text-xl font-semibold tracking-tight">{party.title}</p>
          <p className="max-w-xs text-sm text-muted-foreground">{party.text}</p>
        </div>
        <p className="text-xs text-muted-foreground delay-1000 duration-500 fill-mode-both animate-in fade-in-0">Click anywhere to continue</p>
      </div>
    </div>
  )
}

// Little animated pictures of the real UI for the intro. They replay every few seconds.
const at = (ms: number, cls = "") => ({
  className: cn("duration-500 fill-mode-both animate-in fade-in-0 slide-in-from-bottom-2", cls),
  style: { animationDelay: `${ms}ms` },
})

function Scene({ kind }: { kind: "capture" | "delegate" | "review" | "notes" }) {
  const [loop, setLoop] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setLoop((n) => n + 1), 6000)
    return () => clearInterval(t)
  }, [])
  const circle = "size-[16px] shrink-0 rounded-full border border-input"
  return (
    <div key={loop} aria-hidden className="relative w-full max-w-md overflow-hidden rounded-xl border bg-card text-left text-sm shadow-2xl ring-1 ring-foreground/5">
      <div className="flex h-7 items-center gap-1.5 border-b bg-muted/40 px-3">
        <span className="size-2 rounded-full bg-muted-foreground/30" /><span className="size-2 rounded-full bg-muted-foreground/30" /><span className="size-2 rounded-full bg-muted-foreground/30" />
      </div>
      <div className="flex h-52 flex-col gap-2 p-4">
        {kind === "capture" && <>
          <div className="rounded-lg border bg-background">
            <div className="flex h-10 items-center px-3">
              <span className="orlo-type" style={{ "--steps": 20 } as React.CSSProperties}>Buy oat milk <span className="text-sky-400">#errand</span></span>
              <span className="orlo-caret ml-px" />
            </div>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Tag className="size-3" />Tags</span>
              <span {...at(1300, "flex items-center gap-1 text-foreground")}><CalendarDays className="size-3" />Today</span>
              <span className="ml-auto rounded-md bg-primary px-2 py-0.5 text-primary-foreground">Add</span>
            </div>
          </div>
          <div className="flex h-9 items-center gap-2.5 border-b border-border/60 px-1 text-muted-foreground">
            <span className={circle} />Call the dentist
          </div>
          <div className="orlo-new flex h-9 items-center gap-2.5 rounded-md px-1" style={{ animationDelay: "1900ms" }}>
            <span className={circle} />Buy oat milk
            <span className="ml-auto flex items-center gap-2"><TagBadge tag="errand" /><span className="text-xs text-muted-foreground">Today</span></span>
          </div>
        </>}

        {kind === "delegate" && <>
          <div className="flex h-9 items-center gap-2.5 rounded-md bg-muted/60 px-2">
            <span className={circle} /><span className="flex-1 truncate">Fix the login redirect</span>
            <Badge variant="outline" {...at(1200, "gap-1.5 font-normal")}><Spinner className="size-3 text-sky-400" /><AgentIcon name="claude" className="size-3" />Working</Badge>
          </div>
          <div className="flex gap-1.5">
            {["claude", "codex", "grok"].map((a, i) => (
              <span key={a} {...at(150 + i * 120, cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", a === "claude" && "orlo-pick"))}>
                <AgentIcon name={a} className="size-3.5" />{title(a)}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-1.5 pt-1 font-mono text-xs text-muted-foreground">
            <span {...at(1700, "flex items-center gap-2")}><Wrench className="size-3" />Read src/auth.ts</span>
            <span {...at(2300, "flex items-center gap-2")}><Wrench className="size-3" />Edit src/auth.ts</span>
            <span {...at(2900, "flex items-center gap-2")}><Wrench className="size-3" />Bash pnpm test</span>
          </div>
          <div {...at(3500, "mt-auto flex flex-col gap-1.5")}>
            <span className="orlo-bar h-2 w-4/5 rounded-full bg-muted" /><span className="orlo-bar h-2 w-3/5 rounded-full bg-muted" style={{ animationDelay: "200ms" }} />
          </div>
        </>}

        {kind === "review" && <>
          <div {...at(100, "flex flex-col gap-1")}>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><AgentIcon name="claude" className="size-3.5" />Claude Agent</span>
            <p>Fixed the redirect loop: the session check ran before the cookie was set. Added a test for it.</p>
          </div>
          <span {...at(700, "flex items-center gap-2 text-xs")}><span className="size-2 rounded-full bg-violet-400" />Ready for your review</span>
          <div {...at(1100, "mt-auto flex items-center gap-2 rounded-lg border bg-background p-2")}>
            <span className="flex-1 px-1 text-xs text-muted-foreground">Ask for changes…</span>
            <span className="orlo-press flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground" style={{ animationDelay: "2000ms" }}>
              <Check className="size-3" />Approve
            </span>
          </div>
          <span {...at(2500, "flex items-center gap-2 text-xs text-emerald-400")}><CircleCheck className="size-3.5" />Task checked off</span>
        </>}

        {kind === "notes" && (
          <div className="orlo-md flex flex-col">
            <div {...at(100, "md-h1 cm-line")}>Trip ideas</div>
            <div {...at(500, "cm-line")}><span className="md-bullet">•</span>Kyoto in <span className="md-strong">spring</span></div>
            <div {...at(900, "cm-line md-done")}><span className="md-check" data-on="" />Book flights</div>
            <div {...at(1300, "cm-line")}><span className="md-check" />Find a ryokan</div>
            <div {...at(1700, "cm-line md-quote")}>Pack light. Seriously.</div>
            <Badge variant="outline" {...at(2600, "mt-auto self-end gap-1.5 font-mono font-normal")}><Copy className="size-3" />copies as “# Trip ideas”</Badge>
          </div>
        )}
      </div>
    </div>
  )
}

// First launch: meet the mascot, see how Orlo works, make the first task right there.
function Intro({ clis, done, create }: { clis: Cli[]; done: () => void; create: (text: string) => void }) {
  const [step, setStep] = useState(0)
  const [text, setText] = useState("")
  const found = clis.filter((c) => c.path).map((c) => title(c.name))
  const names = found.length ? found : ["Claude", "Codex", "Grok"]
  const agents = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
  const tour: [Parameters<typeof Scene>[0]["kind"], string, string][] = [
    ["capture", "Capture anything", "Type a task, add #tags and a due date. Press N from anywhere to start one."],
    ["delegate", "Hand it to an agent", `Pick ${agents}. It works in its own folder while you keep going.`],
    ["review", "Review, then approve", "Read what it did, ask for changes, or approve. Approved tasks check themselves off."],
    ["notes", "Notes that speak Markdown", "Type # for a heading, - for a list, - [ ] for a checklist. Copying gives you the raw Markdown."],
  ]
  const last = tour.length + 1
  const next = () => setStep((s) => s + 1)
  const scene = tour[step - 1]
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background duration-500 animate-in fade-in-0">
      <div aria-hidden className="orlo-glow pointer-events-none absolute top-[12%] left-1/2 size-[520px] -translate-x-1/2 rounded-full bg-sidebar-primary/20 blur-[120px]" />
      <div data-tauri-drag-region className="relative flex h-12 shrink-0 items-center justify-end">
        <Button variant="ghost" size="sm" className="mr-1 text-muted-foreground" onClick={done}>Skip intro</Button>
        <WindowControls />
      </div>
      <div className="relative flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-16">
        <img src="/mascot.png" alt="" draggable={false} className={cn("drop-shadow-2xl transition-all duration-500", step === 0 ? "orlo-drop size-40" : scene ? "orlo-float size-14" : "orlo-float size-24")} />
        <div key={step} className="flex w-full max-w-lg flex-col items-center gap-5 text-center">
          {step === 0 && <>
            <div {...at(300)}>
              <h1 className="text-4xl font-semibold tracking-tight">Hi, I'm Orlo</h1>
              <p className="mt-2 text-muted-foreground">Your tasks, notes and AI agents, in one calm place.</p>
            </div>
            <div {...at(550)}><Button size="lg" onClick={next}>Show me around<ArrowUpRight /></Button></div>
          </>}
          {scene && <>
            <div {...at(0)}>
              <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{step} of {tour.length}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight">{scene[1]}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{scene[2]}</p>
            </div>
            <div {...at(150, "w-full flex justify-center")}><Scene kind={scene[0]} /></div>
            <div {...at(300, "flex gap-2")}>
              <Button variant="ghost" size="lg" onClick={() => setStep((s) => s - 1)}>Back</Button>
              <Button size="lg" onClick={next}>{step === tour.length ? "Let's start" : "Next"}<ArrowUpRight /></Button>
            </div>
          </>}
          {step === last && <>
            <div {...at(0)}>
              <h2 className="text-2xl font-semibold tracking-tight">What's first on your list?</h2>
              <p className="mt-2 text-sm text-muted-foreground">Anything works. You can tag it or hand it to an agent later.</p>
            </div>
            <form {...at(200, "flex w-full gap-2")} onSubmit={(e) => { e.preventDefault(); if (text.trim()) create(text.trim()) }}>
              <InputGroup className="h-10 bg-card!">
                <InputGroupInput autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Reply to Sarah's email" />
              </InputGroup>
              <Button type="submit" size="lg" disabled={!text.trim()}>Create task<CornerDownLeft /></Button>
            </form>
            <Button variant="link" {...at(400, "text-muted-foreground")} onClick={done}>I'll do it later</Button>
          </>}
        </div>
        <div className="absolute bottom-8 flex gap-1.5">
          {Array.from({ length: last + 1 }, (_, i) => (
            <button key={i} aria-label={`Step ${i + 1}`} onClick={() => setStep(i)}
              className={cn("h-1.5 rounded-full transition-all duration-300", i === step ? "w-6 bg-foreground" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground")} />
          ))}
        </div>
      </div>
    </div>
  )
}
