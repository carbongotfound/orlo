//! `orlo tasks|notes|show|done|reopen`: read and check off Orlo tasks from a terminal, so any agent can pick work up.
//! Runs before the window is created and talks to the same SQLite file the app uses.
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{env, path::PathBuf, time::Duration};

const HELP: &str = "Orlo CLI: your Orlo tasks and notes, for you and your agents.

  orlo tasks [--all] [--json]   open tasks with their descriptions (--all adds done ones)
  orlo notes [--json]           notes
  orlo show <id> [--json]       one task or note in full
  orlo done <id>                check a task off
  orlo reopen <id>              open it again

ORLO_DATA points at another data folder.";

/// Some(exit code) when the arguments are a CLI command; None means start the app.
pub fn main() -> Option<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    let cmd = args.first()?.as_str();
    if !["tasks", "notes", "show", "done", "reopen", "help", "--help", "-h"].contains(&cmd) {
        return None;
    }
    attach_console();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let id = args.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok());
    match run(cmd, id, flag("--json"), flag("--all")) {
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

fn run(cmd: &str, id: Option<i64>, as_json: bool, all: bool) -> Result<String, String> {
    if cmd.starts_with('-') || cmd == "help" {
        return Ok(HELP.into());
    }
    let path = data_dir().join("orlo.db");
    let c = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| format!("no Orlo data at {}. Open Orlo once first.", path.display()))?;
    c.busy_timeout(Duration::from_secs(5)).map_err(|x| x.to_string())?;
    let need = || id.ok_or(format!("usage: orlo {cmd} <id>"));
    match cmd {
        "done" | "reopen" => {
            let id = need()?;
            let status = if cmd == "done" { "done" } else { "open" };
            let n = c.execute("UPDATE tasks SET status=?1 WHERE id=?2 AND kind='task'", params![status, id]).map_err(|x| x.to_string())?;
            if n == 0 {
                return Err(format!("no task #{id}"));
            }
            Ok(format!("#{id} {}", if cmd == "done" { "done" } else { "reopened" }))
        }
        "show" => {
            let id = need()?;
            let t = rows(&c, "t.id=?1", params![id])?.pop().ok_or(format!("no task #{id}"))?;
            Ok(if as_json { t.to_string() } else { full(&t) })
        }
        _ => {
            let filter = match (cmd, all) {
                ("notes", _) => "t.kind='note'",
                (_, true) => "t.kind='task'",
                _ => "t.kind='task' AND t.status!='done'",
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
         FROM tasks t LEFT JOIN lists l ON l.id=t.list_id WHERE {filter} ORDER BY t.status='done', t.due IS NULL, t.due, t.id"
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
    let mut head = format!("#{} {} {}", t["id"], if t["status"] == "done" { "[x]" } else { "[ ]" }, t["title"].as_str().unwrap_or(""));
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
