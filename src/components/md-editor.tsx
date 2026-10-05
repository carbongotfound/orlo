import { useEffect, useRef } from "react"
import { EditorSelection, EditorState, Prec, type Range, type Transaction } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { syntaxTree } from "@codemirror/language"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import {
  Bold, Code, Copy, Heading1, Heading2, Italic, Link, List, ListChecks, ListOrdered, Quote, SquareCode, Strikethrough,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The document is always plain Markdown: that is what gets saved, sent to agents and copied.
// Only the view changes. "# ", "- ", "> " and "- [ ] " turn into a heading, bullet, quote or checkbox
// the moment the space is typed. **bold**-style marks hide whenever the cursor is outside them.

// Block markup at the start of a line that is always hidden. The cursor never sits inside it.
// Groups: indent, quote markers ("> > "), then one heading / checklist / bullet marker.
const LEAD = /^(\s*)((?:> ?)*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] )?/
const inCode = (s: EditorState, pos: number) => {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(s).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true
  return false
}
function lead(s: EditorState, pos: number) {
  const line = s.doc.lineAt(pos)
  const m = LEAD.exec(line.text)!
  if (!m[2] && !m[3]) return null
  if (inCode(s, line.from)) return null
  const start = line.from + m[1].length
  return { line, start, mid: start + m[2].length, end: line.from + m[0].length, marker: m[3] ?? "" }
}

class Bullet extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement("span")
    s.className = "md-bullet"
    s.textContent = "•"
    return s
  }
}

class Check extends WidgetType {
  constructor(readonly on: boolean) { super() }
  eq(o: Check) { return o.on === this.on }
  toDOM(view: EditorView) {
    const s = document.createElement("span")
    s.className = "md-check"
    s.setAttribute("role", "checkbox")
    s.setAttribute("aria-checked", String(this.on))
    if (this.on) s.dataset.on = ""
    s.onmousedown = (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(view.posAtDOM(s))
      const i = line.text.search(/\[[ xX]\]/)
      if (i >= 0) view.dispatch({ changes: { from: line.from + i + 1, to: line.from + i + 2, insert: this.on ? " " : "x" } })
    }
    return s
  }
  ignoreEvent() { return true }
}

class Rule extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement("span")
    s.className = "md-hr"
    return s
  }
}

const hide = Decoration.replace({})
const mark = (cls: string) => Decoration.mark({ class: cls })
const line = (cls: string) => Decoration.line({ class: cls })
const INLINE: Record<string, string> = { Emphasis: "md-em", StrongEmphasis: "md-strong", Strikethrough: "md-strike", InlineCode: "md-code", Link: "md-link" }

function decorate(view: EditorView) {
  const { state } = view
  const out: Range<Decoration>[] = []
  const near = (from: number, to: number) => state.selection.ranges.some((r) => r.from <= to && r.to >= from)
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (n) => {
        const name = n.name
        const h = /^ATXHeading(\d)$/.exec(name)
        if (h) out.push(line(`md-h${h[1]}`).range(state.doc.lineAt(n.from).from))
        else if (INLINE[name]) out.push(mark(INLINE[name]).range(n.from, n.to))
        else if (name === "Blockquote") {
          for (let p = n.from; p <= n.to;) {
            const l = state.doc.lineAt(p)
            out.push(line("md-quote").range(l.from))
            p = l.to + 1
          }
        } else if (name === "FencedCode") {
          for (let p = n.from; p <= n.to;) {
            const l = state.doc.lineAt(p)
            out.push(line("md-codeblock").range(l.from))
            p = l.to + 1
          }
          return false
        } else if (name === "HorizontalRule") {
          if (!near(n.from, n.to)) out.push(Decoration.replace({ widget: new Rule() }).range(n.from, n.to))
        } else if (name === "Task") {
          const l = state.doc.lineAt(n.from)
          if (/\[[xX]\]/.test(state.sliceDoc(n.from, n.from + 3))) out.push(line("md-done").range(l.from))
        } else if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "LinkMark" || name === "URL"
          || (name === "CodeMark" && n.node.parent?.name === "InlineCode")) {
          const p = n.node.parent!
          if (!near(p.from, p.to)) out.push(hide.range(n.from, n.to))
          else out.push(mark("md-mark").range(n.from, n.to))
        } else if (name === "CodeInfo" || (name === "CodeMark" && n.node.parent?.name === "FencedCode")) {
          out.push(mark("md-mark").range(n.from, n.to))
        }
      },
    })
  }
  // Block markers come from LEAD, so what is hidden is exactly what the cursor skips.
  const atomic: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    for (let p = from; p <= to;) {
      const l = state.doc.lineAt(p)
      const m = lead(state, l.from)
      if (m) {
        if (m.mid > m.start) atomic.push(hide.range(m.start, m.mid))
        const d = /\[[ xX]\]/.test(m.marker) ? Decoration.replace({ widget: new Check(/x/i.test(m.marker)) })
          : /^[-*+]/.test(m.marker) ? Decoration.replace({ widget: new Bullet() }) : hide
        if (m.marker) atomic.push(d.range(m.mid, m.end))
      }
      p = l.to + 1
    }
  }
  return { all: Decoration.set([...out, ...atomic], true), atomic: Decoration.set(atomic, true) }
}

const live = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  atomic: DecorationSet
  constructor(v: EditorView) { ({ all: this.decorations, atomic: this.atomic } = decorate(v)) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
      ({ all: this.decorations, atomic: this.atomic } = decorate(u.view))
  }
}, {
  decorations: (p) => p.decorations,
  provide: (p) => EditorView.atomicRanges.of((v) => v.plugin(p)?.atomic ?? Decoration.none),
})

// Keeps the cursor out of hidden block markers: clicking or Home lands after "# ",
// and ArrowLeft from there goes to the line above instead of getting stuck.
const snap = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.selection) return tr
  const s = tr.state
  const before = tr.startState.selection.main.head
  let moved = false
  const ranges = tr.selection.ranges.map((r) => {
    if (!r.empty) return r
    const m = lead(s, r.head)
    if (!m || r.head < m.start || r.head >= m.end) return r
    moved = true
    const leaving = !tr.docChanged && before === m.end && m.line.number > 1
    return EditorSelection.cursor(leaving ? s.doc.line(m.line.number - 1).to : m.end)
  })
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr
})

// Toolbar and shortcut commands. Each one edits the Markdown text itself.
function wrap(v: EditorView, m: string) {
  v.dispatch(v.state.changeByRange((r) => {
    const text = v.state.sliceDoc(r.from, r.to)
    const outside = v.state.sliceDoc(r.from - m.length, r.from) === m && v.state.sliceDoc(r.to, r.to + m.length) === m
    if (outside) return { changes: [{ from: r.from - m.length, to: r.from }, { from: r.to, to: r.to + m.length }], range: EditorSelection.range(r.from - m.length, r.to - m.length) }
    return { changes: { from: r.from, to: r.to, insert: m + text + m }, range: EditorSelection.range(r.from + m.length, r.to + m.length) }
  }))
  v.focus()
  return true
}

function prefix(v: EditorView, p: string | ((i: number) => string)) {
  const lines = new Set<number>()
  for (const r of v.state.selection.ranges)
    for (let n = v.state.doc.lineAt(r.from).number; n <= v.state.doc.lineAt(r.to).number; n++) lines.add(n)
  const want = (i: number) => (typeof p === "string" ? p : p(i))
  const all = [...lines].map((n) => {
    const l = v.state.doc.line(n)
    const m = LEAD.exec(l.text)!
    const head = m[1].length + m[2].length
    return { l, m, head, old: m[3] ?? /^\d+[.)] /.exec(l.text.slice(head))?.[0] ?? "" }
  })
  // Same marker on every line toggles it off; anything else is swapped for the new one.
  const quote = want(0) === "> "
  const same = all.every(({ m, old }, i) => (quote ? !!m[2] : old === want(i)))
  const changes = all.map(({ l, m, head, old }, i) => quote
    ? { from: l.from + m[1].length, to: l.from + head, insert: same ? "" : "> " }
    : { from: l.from + head, to: l.from + head + old.length, insert: same ? "" : want(i) })
  v.dispatch({ changes })
  v.focus()
  return true
}

function insert(v: EditorView, text: string, caret = text.length) {
  const r = v.state.selection.main
  const l = v.state.doc.lineAt(r.from)
  const pad = l.text.trim() && r.from === l.to ? "\n" : ""
  v.dispatch({ changes: { from: r.from, to: r.to, insert: pad + text }, selection: { anchor: r.from + pad.length + caret } })
  v.focus()
  return true
}

function link(v: EditorView) {
  const r = v.state.selection.main
  const text = v.state.sliceDoc(r.from, r.to) || "link"
  const at = r.from + text.length + 3
  v.dispatch({ changes: { from: r.from, to: r.to, insert: `[${text}](url)` }, selection: { anchor: at, head: at + 3 } })
  v.focus()
  return true
}

type Tool = [React.ReactNode, string, string | null, (v: EditorView) => boolean]
const TOOLS: Tool[][] = [
  [
    [<Heading1 />, "Heading 1", "# ", (v) => prefix(v, "# ")],
    [<Heading2 />, "Heading 2", "## ", (v) => prefix(v, "## ")],
  ],
  [
    [<Bold />, "Bold", "Ctrl B", (v) => wrap(v, "**")],
    [<Italic />, "Italic", "Ctrl I", (v) => wrap(v, "*")],
    [<Strikethrough />, "Strikethrough", "Ctrl Shift X", (v) => wrap(v, "~~")],
    [<Code />, "Inline code", "Ctrl E", (v) => wrap(v, "`")],
    [<Link />, "Link", null, link],
  ],
  [
    [<List />, "Bulleted list", "- ", (v) => prefix(v, "- ")],
    [<ListOrdered />, "Numbered list", "1. ", (v) => prefix(v, (i) => `${i + 1}. `)],
    [<ListChecks />, "Checklist", "- [ ] ", (v) => prefix(v, "- [ ] ")],
    [<Quote />, "Quote", "> ", (v) => prefix(v, "> ")],
    [<SquareCode />, "Code block", "```", (v) => insert(v, "```\n\n```", 4)],
  ],
]

const keys = Prec.highest(keymap.of([
  {
    key: "Enter",
    run: (v) => {
      const l = v.state.doc.lineAt(v.state.selection.main.head)
      if (!v.state.selection.main.empty || !/^\s*(> ?)+$/.test(l.text)) return false
      v.dispatch({ changes: { from: l.from, to: l.to } })
      return true
    },
  },
  { key: "Mod-b", run: (v) => wrap(v, "**") },
  { key: "Mod-i", run: (v) => wrap(v, "*") },
  { key: "Mod-e", run: (v) => wrap(v, "`") },
  { key: "Mod-Shift-x", run: (v) => wrap(v, "~~") },
  { key: "Mod-Alt-1", run: (v) => prefix(v, "# ") },
  { key: "Mod-Alt-2", run: (v) => prefix(v, "## ") },
  { key: "Mod-Alt-3", run: (v) => prefix(v, "### ") },
]))

// Rough plain text for previews on cards.
export const plain = (md: string) =>
  md.replace(/^\s*(> ?)*(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/gm, "")
    .replace(/^(```.*|---+)$/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim()

export function MdEditor({ value, onChange, hint, className }: {
  value: string; onChange: (md: string) => void; hint?: string; className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    let timer = 0
    let last = value
    const flush = () => {
      clearTimeout(timer)
      const md = v.state.doc.toString()
      if (md !== last) { last = md; changed.current(md) }
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keys,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          live,
          snap,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "true", "aria-label": "Notes" }),
          placeholder(hint ?? ""),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            clearTimeout(timer)
            timer = window.setTimeout(flush, 500)
          }),
          EditorView.domEventHandlers({ blur: flush }),
        ],
      }),
    })
    view.current = v
    return () => { flush(); v.destroy() }
    // The editor owns the text after mount; the parent remounts it per task.
  }, [])

  const copy = async () => {
    await navigator.clipboard.writeText(view.current?.state.doc.toString() ?? "")
    toast.success("Copied as Markdown")
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="-mx-1.5 flex flex-wrap items-center gap-0.5 text-muted-foreground">
        {TOOLS.map((group, i) => (
          <div key={i} className={cn("flex items-center gap-0.5", i > 0 && "border-l pl-0.5")}>
            {group.map(([icon, label, key, run]) => (
              <Tooltip key={label}>
                <TooltipTrigger render={
                  <Button variant="ghost" size="icon-xs" aria-label={label}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => view.current && run(view.current)} />
                }>{icon}</TooltipTrigger>
                <TooltipContent>{label}{key && <Kbd>{key}</Kbd>}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Copy as Markdown" onClick={copy} />}>
            <Copy />
          </TooltipTrigger>
          <TooltipContent>Copy as Markdown</TooltipContent>
        </Tooltip>
      </div>
      <div ref={host} className="orlo-md min-h-0 flex-1 cursor-text" onClick={(e) => e.target === e.currentTarget && view.current?.focus()} />
    </div>
  )
}
