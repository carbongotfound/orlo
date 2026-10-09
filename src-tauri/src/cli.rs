//! `orlo tasks|notes|show|done|x|reopen|add|append|skill`: Orlo tasks from a terminal, so any agent can pick work up and file new work.
//! Runs before the window is created and talks to the same SQLite file the app uses.
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{env, path::PathBuf, time::Duration};

const HELP: &str = "Orlo CLI: your Orlo tasks and notes, for you and your agents.

  orlo tasks [--all] [--json]   open tasks with their descriptions (--all adds done and X'd ones)
  orlo notes [--json]           notes
  orlo show <id> [--json]       one task or note in full
  orlo done <id>                check a task off
  orlo x <id>                   X a task: closed without doing it (won't do, can't do, obsolete)
  orlo reopen <id>              open it again
  orlo add <title> [--note] [--notes <text>] [--due YYYY-MM-DD] [--list <name>] [--tag <tag>]... [--for <id>]
                                add a task (or a note); prints its id. A note --for a task puts
                                READ THIS on that task; agents Orlo started may only add notes, for their own task.
  orlo append <id> <text>       add a line to a task's or note's description
  orlo skill                    instructions for AI agents, as a SKILL.md

ORLO_DATA points at another data folder.";

/// Some(exit code) when the arguments are a CLI command; None means start the app.
pub fn main() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    let cmd = args.first()?.as_str();
    if !["tasks", "notes", "show", "done", "x", "reopen", "add", "append", "skill", "help", "--help", "-h"].contains(&cmd) {
        return None;
    }
    attach_console();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let id = args.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok());
    let result = match cmd {
        "add" => add(&args),
        "append" => append(id, args.get(2)),
        "skill" => Ok(skill()),
        _ => run(cmd, id, flag("--json"), flag("--all")),
    };
    match result {
        Ok(out) => {
            println!("{out}");
            Some(0)
        }
        Err(x) => {
            eprintln!("orlo: {x}");
            Some(1)
        }
    }
}

/// Where the app keeps orlo.db; the same folder Tauri's app_data_dir resolves to for com.orlo.app.
pub fn data_dir() -> PathBuf {
    if let Some(d) = env::var_os("ORLO_DATA") {
        return d.into();
    }
    let home = || PathBuf::from(env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
    let base = if cfg!(windows) {
        env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"))
    };
    base.join("com.orlo.app")
}

fn open() -> Result<Connection, String> {
    let path = data_dir().join("orlo.db");
    let c = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| format!("no Orlo data at {}. Open Orlo once first.", path.display()))?;
    c.busy_timeout(Duration::from_secs(5)).map_err(|x| x.to_string())?;
    // Same as the app's migration, in case this CLI is newer than the Orlo that last opened the file.
    let _ = c.execute("ALTER TABLE tasks ADD COLUMN origin TEXT", []);
    let _ = c.execute("ALTER TABLE tasks ADD COLUMN for_task INTEGER", []);
    let _ = c.execute("ALTER TABLE tasks ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0", []);
    Ok(c)
}

fn add(args: &[String]) -> Result<String, String> {
    const USAGE: &str = "usage: orlo add <title> [--note] [--notes <text>] [--due YYYY-MM-DD] [--list <name>] [--tag <tag>]... [--for <id>]";
    let title = args.get(1).filter(|t| !t.starts_with("--") && !t.trim().is_empty()).ok_or(USAGE)?;
    let value = |f: &str| args.iter().position(|a| a == f).map(|i| args.get(i + 1).cloned().ok_or(USAGE));
    let note = args.iter().any(|a| a == "--note");
    let due = value("--due").transpose()?;
    if let Some(d) = &due {
        let ok = d.len() == 10 && d.char_indices().all(|(i, ch)| if i == 4 || i == 7 { ch == '-' } else { ch.is_ascii_digit() });
        if !ok || note { return Err(if note { "notes don't take a due date".into() } else { format!("--due wants YYYY-MM-DD, got {d}") }); }
    }
    let tags: Vec<&str> = args.windows(2).filter(|w| w[0] == "--tag").map(|w| w[1].trim_start_matches('#')).collect();
    let c = open()?;
    let list: Option<i64> = match value("--list").transpose()? {
        Some(name) => Some(c.query_row("SELECT id FROM lists WHERE name=?1 COLLATE NOCASE", [name.trim()], |r| r.get(0)).map_err(|_| format!("no list named {name}"))?),
        None => None,
    };
    // The task a note is for: --for, else the task of the Orlo agent running this.
    let num = |s: String| s.trim_start_matches('#').parse::<i64>().map_err(|_| format!("--for wants a task id, got {s}"));
    let target = match value("--for").transpose()? {
        Some(_) if !note => return Err("--for is for notes: orlo add <title> --note --for <id>".into()),
        Some(f) => Some(num(f)?),
        None if note => env::var("ORLO_TASK").ok().and_then(|t| t.parse().ok()),
        None => None,
    };
    if let Some(t) = target {
        c.query_row("SELECT 1 FROM tasks WHERE id=?1 AND kind='task'", [t], |_| Ok(())).map_err(|_| format!("no task #{t}"))?;
    }
    if let Some(own) = own_task() {
        if !note || target != Some(own) {
            return Err(format!("agents Orlo started can only add notes for their own task: orlo add <title> --note (it goes on #{own})"));
        }
    }
    // Lets Orlo continue the Claude Code session that filed this; just the id, nothing else from that session.
    let origin = env::var("CLAUDE_CODE_SESSION_ID").ok().filter(|s| !s.is_empty()).map(|s| format!("claude:{s}"));
    // ...and its folder, so an agent picking the task up works in the same project.
    let cwd = origin.as_ref().filter(|_| !note).and_then(|_| env::current_dir().ok()).map(|d| d.display().to_string());
    c.execute(
        "INSERT INTO tasks(title, notes, due, kind, tags, list_id, origin, cwd, for_task, fresh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![title.trim(), value("--notes").transpose()?.unwrap_or_default(), due, if note { "note" } else { "task" }, tags.join(","), list, origin, cwd, target, target.is_some()],
    ).map_err(|x| x.to_string())?;
    let id = c.last_insert_rowid();
    Ok(match target {
        Some(t) => format!("#{id} added; #{t} shows READ THIS"),
        None => format!("#{id} added"),
    })
}

fn append(id: Option<i64>, text: Option<&String>) -> Result<String, String> {
    let (id, text) = id.zip(text).ok_or("usage: orlo append <id> <text>")?;
    let c = open()?;
    mine(&c, id)?;
    // A note written for a task: the task shows READ THIS again.
    let n = c.execute(
        "UPDATE tasks SET notes = CASE WHEN trim(notes)='' THEN ?1 ELSE rtrim(notes) || char(10) || char(10) || ?1 END,
         fresh = for_task IS NOT NULL WHERE id=?2 AND kind IN ('task','note')",
        params![text.trim(), id],
    ).map_err(|x| x.to_string())?;
    if n == 0 { return Err(format!("no task #{id}")); }
    Ok(format!("#{id} updated"))
}

/// Set for agents Orlo started: the one task they may change.
fn own_task() -> Option<i64> {
    env::var("ORLO_TASK").ok()?.parse().ok()
}

/// An agent Orlo started may change its own task and the notes written for it, nothing else.
/// ponytail: a guard against mistakes, not a sandbox; the agent could unset ORLO_TASK.
fn mine(c: &Connection, id: i64) -> Result<(), String> {
    let Some(own) = own_task() else { return Ok(()) };
    let ok = id == own || c.query_row("SELECT 1 FROM tasks WHERE id=?1 AND for_task=?2", params![id, own], |_| Ok(())).is_ok();
    if ok { Ok(()) } else { Err(format!("agents Orlo started may only change their own task (#{own}) and its notes")) }
}

/// How to call this executable from a shell: `orlo` once Orlo's PATH shim points here (Windows), else the full path.
pub fn exe() -> String {
    let exe = env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "orlo".into());
    #[cfg(windows)]
    if let Some(l) = env::var_os("LOCALAPPDATA") {
        if std::fs::read_to_string(PathBuf::from(l).join("Orlo").join("bin").join("orlo.cmd")).is_ok_and(|s| s.contains(&format!("\"{exe}\""))) {
            return "orlo".into();
        }
    }
    if exe.contains(' ') { format!("\"{exe}\"") } else { exe }
}

/// A skill file for Claude Code (~/.claude/skills/orlo/SKILL.md) and the like; also works pasted into any agent's instructions.
pub fn skill() -> String {
    let exe = exe();
    format!(r#"---
name: orlo
description: Read, add and check off the user's Orlo tasks and notes. Use when the user mentions Orlo, their to-do list, tasks or notes, asks what to work on next, or when you finish, discover or leave behind work worth tracking.
---

# Orlo

Orlo is the user's to-do and notes app. Its executable doubles as a CLI that reads and writes the same local database:

    {exe}

Every command prints plain text; add `--json` to `tasks`, `notes` and `show` for structured output.

| Command | What it does |
|---|---|
| `{exe} tasks` | Open tasks, one per line: `#id [ ] title · due · list · #tags · agent: verdict`, then the first line of the description |
| `{exe} tasks --all` | Done (`[x]`) and X'd (`[-]`) tasks too |
| `{exe} notes` | Notes |
| `{exe} show <id>` | One task or note in full, with its whole description (Markdown) |
| `{exe} add "<title>" [--notes "<text>"] [--due YYYY-MM-DD] [--tag <tag>]...` | Add a task; prints `#id added` |
| `{exe} add "<title>" --list "<list>"` | Add it to one of the user's lists |
| `{exe} add "<title>" --note --notes "<text>" [--for <id>]` | Add a note; `--for` attaches it to that task, which shows READ THIS until the user opens it |
| `{exe} append <id> "<text>"` | Add a paragraph to a task's or note's description |
| `{exe} done <id>` | Check a task off |
| `{exe} x <id>` | X a task: closed without doing it (won't do, can't do, no longer needed) |
| `{exe} reopen <id>` | Open it again |

## How to use it

- When the user mentions `#21` or "task 21", that's an Orlo id: run `show 21` to see what they mean.
- Before starting, run `tasks` (and `show <id>` for anything relevant) so you work on what the user actually has planned.
- When you finish a task the user gave you that is also in Orlo, `append` a one-line summary of what you did, then mark it `done`.
- Only mark tasks done that you actually completed. If you only got part of the way, `append` what's left instead.
- If a task can't or shouldn't be done (obsolete, duplicate, blocked for good), `append` why, then `x` it.
- When you write up something a task's worker must know (findings, a plan, a spec), add it as a note `--for` that task.
- When the user gives you new tasks, `add` them (with `--list`/`--tag` matching where similar tasks live) before you start.
- When you find follow-up work you won't do now (a bug, a TODO, a question for the user), `add` it as a task with a clear title and enough context in `--notes` for someone to pick it up cold.
- Keep titles short and imperative ("Fix login timeout on Safari"). Put detail in `--notes`.
- Don't delete or rewrite the user's existing text; `append` only adds.
- The Orlo window picks up changes when the user switches back to it.
"#)
}

fn run(cmd: &str, id: Option<i64>, as_json: bool, all: bool) -> Result<String, String> {
    if cmd.starts_with('-') || cmd == "help" {
        return Ok(HELP.into());
    }
    let c = open()?;
    let need = || id.ok_or(format!("usage: orlo {cmd} <id>"));
    match cmd {
        "done" | "x" | "reopen" => {
            let id = need()?;
            mine(&c, id)?;
            let status = match cmd { "reopen" => "open", s => s };
            let n = c.execute("UPDATE tasks SET status=?1 WHERE id=?2 AND kind='task'", params![status, id]).map_err(|x| x.to_string())?;
            if n == 0 {
                return Err(format!("no task #{id}"));
            }
            Ok(format!("#{id} {}", match cmd { "done" => "done", "x" => "X'd", _ => "reopened" }))
        }
        "show" => {
            let id = need()?;
            let t = rows(&c, "t.id=?1", params![id])?.pop().ok_or(format!("no task #{id}"))?;
            let notes = rows(&c, "t.for_task=?1 AND t.kind='note'", params![id])?;
            if as_json { return Ok(t.to_string()); }
            let refs: Vec<String> = notes.iter().map(|n| format!("Note #{} for this task: {}", n["id"], n["title"].as_str().unwrap_or(""))).collect();
            Ok(if refs.is_empty() { full(&t) } else { format!("{}\n\n{}", full(&t), refs.join("\n")) })
        }
        _ => {
            let filter = match (cmd, all) {
                ("notes", _) => "t.kind='note'",
                (_, true) => "t.kind='task'",
                _ => "t.kind='task' AND t.status='open'",
            };
            let ts = rows(&c, filter, [])?;
            Ok(if as_json {
                Value::Array(ts).to_string()
            } else if ts.is_empty() {
                format!("No {cmd}.")
            } else {
                ts.iter().map(brief).collect::<Vec<_>>().join("\n")
            })
        }
    }
}

fn rows(c: &Connection, filter: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT t.id, t.kind, t.title, t.notes, t.status, t.due, t.tags, l.name, t.agent, t.verdict
         FROM tasks t LEFT JOIN lists l ON l.id=t.list_id WHERE {filter} ORDER BY t.status!='open', t.due IS NULL, t.due, t.id"
    );
    let mut s = c.prepare(&sql).map_err(|x| x.to_string())?;
    let r = s
        .query_map(p, |r| {
            let tags: String = r.get(6)?;
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "title": r.get::<_, String>(2)?,
                "notes": r.get::<_, String>(3)?, "status": r.get::<_, String>(4)?, "due": r.get::<_, Option<String>>(5)?,
                "tags": tags.split(',').map(str::trim).filter(|x| !x.is_empty()).collect::<Vec<_>>(),
                "list": r.get::<_, Option<String>>(7)?, "agent": r.get::<_, Option<String>>(8)?, "verdict": r.get::<_, String>(9)?,
            }))
        })
        .map_err(|x| x.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| x.to_string());
    r
}

/// `#12 [ ] Title · due 2026-10-09 · #Work · claude: review`, then the first line of its description.
fn brief(t: &Value) -> String {
    let mark = match t["status"].as_str() { Some("done") => "[x]", Some("x") => "[-]", _ => "[ ]" };
    let mut head = format!("#{} {mark} {}", t["id"], t["title"].as_str().unwrap_or(""));
    if t["status"] == "x" { head += " · X'd"; }
    if let Some(d) = t["due"].as_str() { head += &format!(" · due {d}"); }
    if let Some(l) = t["list"].as_str() { head += &format!(" · {l}"); }
    let tags: Vec<String> = t["tags"].as_array().into_iter().flatten().filter_map(|g| g.as_str()).map(|g| format!("#{g}")).collect();
    if !tags.is_empty() { head += &format!(" · {}", tags.join(" ")); }
    if let Some(a) = t["agent"].as_str() {
        let v = t["verdict"].as_str().unwrap_or("");
        head += &format!(" · {a}{}", if v.is_empty() { String::new() } else { format!(": {v}") });
    }
    match t["notes"].as_str().and_then(|n| n.lines().map(str::trim).find(|l| !l.is_empty())) {
        Some(l) => format!("{head}\n    {}", l.chars().take(100).collect::<String>()),
        None => head,
    }
}

fn full(t: &Value) -> String {
    let mut h = t.clone();
    h["notes"] = "".into();
    let notes = t["notes"].as_str().unwrap_or("").trim();
    if notes.is_empty() { brief(&h) } else { format!("{}\n\n{notes}", brief(&h)) }
}

/// The app is a GUI exe on Windows; when it's run from a console without redirection, print into that console.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n: u32) -> isize;
        fn AttachConsole(pid: u32) -> i32;
    }
    unsafe {
        let out = GetStdHandle(-11i32 as u32);
        if out == 0 || out == -1 {
            AttachConsole(u32::MAX);
        }
    }
}
#[cfg(not(windows))]
fn attach_console() {}
