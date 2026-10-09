// What each agent CLI lets Orlo choose per run. Kept in one place so the task panel and the Code view agree.

export const MAC = navigator.userAgent.includes("Mac")
/** Modifier key as it's printed on this keyboard: "⌘" on a Mac, "Ctrl+" elsewhere. */
export const MOD = MAC ? "⌘" : "Ctrl+"

export type Pick = { agent: string; model: string; effort: string; access: string }
export const noPick: Pick = { agent: "", model: "", effort: "", access: "" }

export const MODELS: Record<string, string[]> = {
  claude: ["fable", "opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.5"],
  // From `grok models` (grok 1.0.50).
  grok: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
}
export const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  grok: ["low", "medium", "high"],
}

/** Access levels each CLI supports, first one is Orlo's default. Values match access_args in lib.rs. */
export const ACCESS: Record<string, [value: string, label: string, hint: string][]> = {
  claude: [
    ["", "Edit files", "Reads, edits and runs commands with Bash, Read, Edit, Write, Glob and Grep"],
    ["full", "Full access", "Skips every permission check"],
    ["plan", "Plan only", "Reads and plans, changes nothing"],
  ],
  codex: [
    ["", "Full access", "No sandbox (Codex's sandbox blocks every command when Orlo starts it on Windows)"],
    ["read", "Read only", "Can read the project but not change it"],
  ],
  grok: [
    ["", "Default", "Grok's own approval settings"],
    ["edit", "Accept edits", "Approves file edits automatically"],
    ["full", "Auto-approve all", "Approves every tool call"],
    ["plan", "Plan only", "Reads and plans, changes nothing"],
  ],
  gemini: [
    ["", "Full access", "Approves every tool call (--yolo)"],
    ["edit", "Auto-approve edits", "Approves file edits, refuses other tools"],
  ],
  hermes: [["", "Full access", "Approves every tool call (--yolo)"]],
}

/** Slash commands Orlo handles itself, for every agent. */
export const BUILTIN: [name: string, hint: string][] = [
  ["clear", "Start a new conversation"],
  ["model", "Switch model, e.g. /model opus"],
  ["effort", "Switch reasoning, e.g. /effort high"],
  ["access", "Switch access, e.g. /access full"],
  ["stop", "Stop the running agent"],
]

/** Commands the CLI itself runs, until it reports its own list on the first run (Claude and Grok do). */
export const AGENT_COMMANDS: Record<string, string[]> = {
  claude: ["compact"],
  grok: ["compact", "context", "review"],
}
