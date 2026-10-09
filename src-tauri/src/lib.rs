use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::{fs, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_notification::NotificationExt;

mod cli;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const TAIL: &str = "Do not delete files unless the task says so. When finished, summarize what you changed. \
End your final message with exactly one status line: `ORLO_STATUS: complete` if the task is fully done, \
`ORLO_STATUS: review` if a person should check your work first, or `ORLO_STATUS: input` if you need an answer \
from the user (ask the question just above that line).";
const CAP_MINUTES: u64 = 20;
const CLAUDE_FLAGS: &[&str] = &[
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--max-turns", "30", "--max-budget-usd", "1.50",
];
// No --bare: it switches Claude Code to API-key-only auth, so a normal `claude /login` would read as "Not logged in".
#[cfg_attr(not(windows), allow(dead_code))]
const NO_WINDOW: u32 = 0x0800_0000;
/// Every CLI Orlo can hand a task to, in sidebar order.
const AGENTS: &[&str] = &["claude", "codex", "grok", "hermes", "gemini"];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS lists(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  due TEXT, list_id INTEGER, status TEXT NOT NULL DEFAULT 'open', agent TEXT, session_id TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags(name TEXT PRIMARY KEY, color TEXT NOT NULL);
";

struct Db(Mutex<Connection>);
/// Images and videos added to notes live here, as attachments/<file> links in the Markdown.
struct Media(PathBuf);
#[derive(Default)]
struct Runs(Mutex<HashMap<i64, Child>>);

#[derive(Serialize)]
struct List { id: i64, name: String }

#[derive(Serialize, Deserialize)]
struct Task {
    id: i64, title: String, notes: String, due: Option<String>, list_id: Option<i64>,
    status: String, agent: Option<String>, session_id: Option<String>, tags: String, kind: String, model: String, effort: String, verdict: String,
    /// A project folder the agent works in (from the Code view); None means its own folder under ~/Orlo.
    cwd: Option<String>,
    /// How much the agent may do without asking; see access_args.
    #[serde(default)]
    access: String,
}

#[derive(Serialize, Clone)]
struct Ev { task_id: i64, kind: String, text: String }

#[derive(Serialize)]
struct Cli { name: &'static str, path: Option<String>, cap: String }

fn e<E: ToString>(x: E) -> String { x.to_string() }

/// Model and reasoning end up as CLI args; keep them to plain identifiers.
fn plain(s: &str) -> bool { s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) }

/// Approval flags for each access level an agent's CLI supports. "" is Orlo's default for that agent.
/// Nobody is there to answer a prompt mid-run, so every level either allows a tool or refuses it outright.
fn access_args(agent: &str, access: &str) -> Result<&'static [&'static str], String> {
    Ok(match (agent, access) {
        ("claude", "" | "edit") => &["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep"],
        ("claude", "full") => &["--permission-mode", "bypassPermissions"],
        ("claude", "plan") => &["--permission-mode", "plan"],
        // codex's unelevated Windows sandbox refuses every command ("cannot enforce split writable root sets"),
        // so its default is full access; read-only still works for questions about the code.
        ("codex", "" | "full") => &["-s", "danger-full-access"],
        ("codex", "read") => &["-s", "read-only"],
        ("grok", "") => &[],
        ("grok", "full") => &["--always-approve"],
        ("grok", "edit") => &["--permission-mode", "acceptEdits"],
        ("grok", "plan") => &["--permission-mode", "plan"],
        ("gemini", "" | "full") => &["--yolo"],
        ("gemini", "edit") => &["--approval-mode", "auto_edit"],
        ("hermes", "" | "full") => &["--yolo"],
        _ => return Err(format!("{agent} doesn't support that access level.")),
    })
}

/// Each delegated task gets its own folder here. ORLO_WORK overrides the default ~/Orlo.
fn work_root() -> PathBuf {
    let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os("ORLO_WORK").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os(home).unwrap_or_default()).join("Orlo"))
}

fn read_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?, title: r.get(1)?, notes: r.get(2)?, due: r.get(3)?, list_id: r.get(4)?,
        status: r.get(5)?, agent: r.get(6)?, session_id: r.get(7)?, tags: r.get(8)?, kind: r.get(9)?, model: r.get(10)?, effort: r.get(11)?, verdict: r.get(12)?, cwd: r.get(13)?, access: r.get(14)?,
    })
}
const TASK_COLS: &str = "id, title, notes, due, list_id, status, agent, session_id, tags, kind, model, effort, verdict, cwd, access";

#[tauri::command]
fn lists(db: State<Db>) -> Result<Vec<List>, String> {
    let c = db.0.lock().unwrap();
    let mut s = c.prepare("SELECT id, name FROM lists ORDER BY id").map_err(e)?;
    let r = s.query_map([], |r| Ok(List { id: r.get(0)?, name: r.get(1)? })).map_err(e)?.collect::<Result<_, _>>().map_err(e);
    r
}

#[tauri::command]
fn add_list(db: State<Db>, name: String) -> Result<List, String> {
    let c = db.0.lock().unwrap();
    c.execute("INSERT INTO lists(name) VALUES (?1)", [&name]).map_err(e)?;
    Ok(List { id: c.last_insert_rowid(), name })
}

#[tauri::command]
fn rename_list(db: State<Db>, id: i64, name: String) -> Result<(), String> {
    db.0.lock().unwrap().execute("UPDATE lists SET name=?1 WHERE id=?2", params![name, id]).map(|_| ()).map_err(e)
}

#[tauri::command]
fn delete_list(db: State<Db>, id: i64) -> Result<(), String> {
    let c = db.0.lock().unwrap();
    c.execute("UPDATE tasks SET list_id=NULL WHERE list_id=?1", [id]).map_err(e)?;
    c.execute("DELETE FROM lists WHERE id=?1", [id]).map(|_| ()).map_err(e)
}

#[tauri::command]
fn tag_colors(db: State<Db>) -> Result<HashMap<String, String>, String> {
    let c = db.0.lock().unwrap();
    let mut s = c.prepare("SELECT name, color FROM tags").map_err(e)?;
    let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<_, _>>().map_err(e);
    r
}

/// None goes back to the automatic color.
#[tauri::command]
fn set_tag_color(db: State<Db>, name: String, color: Option<String>) -> Result<(), String> {
    let c = db.0.lock().unwrap();
    match color {
        Some(col) if col.len() == 7 && col.starts_with('#') && col[1..].chars().all(|x| x.is_ascii_hexdigit()) => {
            c.execute("INSERT OR REPLACE INTO tags(name, color) VALUES (?1, ?2)", params![name, col]).map(|_| ()).map_err(e)
        }
        Some(_) => Err("Colors are #rrggbb".into()),
        None => c.execute("DELETE FROM tags WHERE name=?1", [name]).map(|_| ()).map_err(e),
    }
}

/// The comma-separated tags column with `from` renamed to `to` (merged if it's already there); None if `from` isn't in it.
fn retag(tags: &str, from: &str, to: &str) -> Option<String> {
    let ts: Vec<&str> = tags.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
    if !ts.contains(&from) {
        return None;
    }
    let mut out: Vec<&str> = vec![];
    for t in ts.into_iter().map(|t| if t == from { to } else { t }) {
        if !out.contains(&t) { out.push(t) }
    }
    Some(out.join(","))
}

#[tauri::command]
fn rename_tag(db: State<Db>, from: String, to: String) -> Result<String, String> {
    let to = to.trim().trim_start_matches('#').replace(',', " ").trim().to_string();
    if to.is_empty() { return Err("A tag needs a name".into()) }
    let mut c = db.0.lock().unwrap();
    let tx = c.transaction().map_err(e)?;
    let rows: Vec<(i64, String)> = {
        let mut s = tx.prepare("SELECT id, tags FROM tasks WHERE tags != ''").map_err(e)?;
        let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<_, _>>().map_err(e)?;
        r
    };
    for (id, tags) in rows {
        if let Some(t) = retag(&tags, &from, &to) {
            tx.execute("UPDATE tasks SET tags=?1 WHERE id=?2", params![t, id]).map_err(e)?;
        }
    }
    // A picked color moves with the tag, unless the name it merges into already has one.
    tx.execute("UPDATE OR IGNORE tags SET name=?1 WHERE name=?2", params![to, from]).map_err(e)?;
    tx.execute("DELETE FROM tags WHERE name=?1 AND name!=?2", params![from, to]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(to)
}

// The Code view's file access. It edits the user's own project files, nothing more: the folders where agent CLIs
// keep their logins are off limits, so Orlo never reads or writes a token even when someone browses there.
const PRIVATE: &[&str] = &[".claude", ".codex", ".grok", ".gemini", ".hermes", ".ssh", ".aws", ".config/gcloud", ".config/gh"];

fn editable(path: &str) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(path).map_err(|x| format!("{path}: {x}"))?;
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).and_then(|h| std::fs::canonicalize(h).ok());
    if let Some(h) = home {
        if PRIVATE.iter().any(|d| p.starts_with(h.join(d))) {
            return Err("Orlo doesn't open the folders where agent CLIs and other tools keep their sign-ins.".into());
        }
    }
    Ok(p)
}

#[derive(Serialize)]
struct Entry { name: String, dir: bool }

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(editable(&path)?).map_err(e)?
        .filter_map(|x| x.ok())
        .map(|x| Entry { name: x.file_name().to_string_lossy().into_owned(), dir: x.file_type().is_ok_and(|t| t.is_dir()) })
        .filter(|x| !SKIP.contains(&x.name.as_str()))
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let p = editable(&path)?;
    if fs::metadata(&p).map_err(e)?.len() > 4 << 20 { return Err("That file is over 4 MB, too big to edit here.".into()) }
    String::from_utf8(fs::read(&p).map_err(e)?).map_err(|_| "That looks like a binary file.".into())
}

/// Writes a file, creating it (not its folder) when it's new.
#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = editable(&p.parent().ok_or("No folder")?.to_string_lossy())?;
    fs::write(dir.join(p.file_name().ok_or("No file name")?), text).map_err(e)
}

const SKIP: &[&str] = &[".git", "node_modules", "target", ".DS_Store"];

/// Every file under a project, relative and with `/`, for quick open. Stops at 20,000 files.
#[tauri::command]
fn list_files(root: String) -> Result<Vec<String>, String> {
    let root = editable(&root)?;
    let (mut out, mut stack) = (Vec::new(), vec![root.clone()]);
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for x in rd.flatten() {
            let name = x.file_name().to_string_lossy().into_owned();
            if SKIP.contains(&name.as_str()) { continue }
            let p = x.path();
            if x.file_type().is_ok_and(|t| t.is_dir()) {
                if editable(&p.to_string_lossy()).is_ok() { stack.push(p) }
            } else if let Ok(r) = p.strip_prefix(&root) {
                out.push(r.to_string_lossy().replace('\\', "/"));
                if out.len() >= 20_000 { return Ok(out) }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// The parent must exist and be allowed; the new entry is created or moved inside it.
fn in_editable_dir(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    Ok(editable(&p.parent().ok_or("No folder")?.to_string_lossy())?.join(p.file_name().ok_or("No name")?))
}

/// The Code view's Changes panel: "status", "diff" (tracked file), "diff-new" (untracked file) or "discard".
#[tauri::command]
fn git(root: String, op: String, path: Option<String>) -> Result<String, String> {
    let dir = editable(&root)?;
    let path = path.unwrap_or_default();
    if path.starts_with('-') || path.split(['/', '\\']).any(|p| p == "..") { return Err("Bad path.".into()) }
    let args: Vec<&str> = match op.as_str() {
        "status" => vec!["status", "--porcelain=v1", "-uall"],
        "diff" => vec!["diff", "HEAD", "--", &path],
        "diff-new" => vec!["diff", "--no-index", "--", if cfg!(windows) { "NUL" } else { "/dev/null" }, &path],
        "discard" => vec!["restore", "--source=HEAD", "--staged", "--worktree", "--", &path],
        _ => return Err("Unknown git operation.".into()),
    };
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&dir).args(["-c", "core.quotepath=off", "-c", "color.ui=never"]).args(args).stdin(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, NO_WINDOW);
    let out = cmd.output().map_err(|x| format!("git: {x}"))?;
    // diff --no-index exits 1 when the files differ, which is the point.
    if !out.status.success() && op != "diff-new" {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.contains("not a git repository") { "not a git repository".into() } else { err.trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir(in_editable_dir(&path)?).map_err(e)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let (a, b) = (editable(&from)?, in_editable_dir(&to)?);
    if b.exists() { return Err(format!("{} already exists.", b.display())) }
    fs::rename(a, b).map_err(e)
}

/// Files and empty folders only, so one click can never wipe out a whole tree.
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = editable(&path)?;
    if p.is_dir() { fs::remove_dir(&p).map_err(|_| "Only empty folders can be deleted here.".to_string()) } else { fs::remove_file(&p).map_err(e) }
}

/// The Code view's terminal: one command at a time in the project folder, output streamed as "term" events.
#[derive(Default)]
struct Term(Mutex<Option<Child>>);

#[derive(Clone, Serialize)]
struct TermEv { text: String, code: Option<i32>, done: bool }

#[tauri::command]
fn run_cmd(app: AppHandle, cwd: String, line: String) -> Result<(), String> {
    let dir = editable(&cwd)?;
    let term = app.state::<Term>();
    let mut slot = term.0.lock().unwrap();
    if let Some(c) = slot.as_mut() {
        if c.try_wait().map_err(e)?.is_none() { return Err("A command is still running. Stop it first.".into()) }
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/D /S /C \"{line}\"")).creation_flags(NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(std::env::var("SHELL").unwrap_or("/bin/sh".into()));
        c.arg("-c").arg(&line);
        std::os::unix::process::CommandExt::process_group(&mut c, 0);
        c
    };
    let mut child = cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("FORCE_COLOR", "0").env("NO_COLOR", "1").spawn().map_err(e)?;
    let pipes: Vec<Box<dyn Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    let readers: Vec<_> = pipes.into_iter().map(|r| {
        let a = app.clone();
        thread::spawn(move || {
            let mut br = BufReader::new(r);
            let mut buf = Vec::new();
            while br.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
                let _ = a.emit("term", TermEv { text: String::from_utf8_lossy(&buf).into_owned(), code: None, done: false });
                buf.clear();
            }
        })
    }).collect();
    *slot = Some(child);
    drop(slot);
    let a = app.clone();
    thread::spawn(move || {
        for r in readers { let _ = r.join(); }
        let code = a.state::<Term>().0.lock().unwrap().as_mut().and_then(|c| c.wait().ok()).and_then(|s| s.code());
        let _ = a.emit("term", TermEv { text: String::new(), code, done: true });
    });
    Ok(())
}

#[tauri::command]
fn stop_cmd(term: State<Term>) {
    if let Some(c) = term.0.lock().unwrap().as_mut() { kill_tree(c.id()) }
}

/// `orlo skill` output, for the command menu's "Copy Orlo skill for AI agents".
#[tauri::command]
fn agent_skill() -> String {
    cli::skill()
}

#[tauri::command]
fn tasks(db: State<Db>) -> Result<Vec<Task>, String> {
    let c = db.0.lock().unwrap();
    let mut s = c.prepare(&format!("SELECT {TASK_COLS} FROM tasks ORDER BY status='done', id")).map_err(e)?;
    let r = s.query_map([], read_task).map_err(e)?.collect::<Result<_, _>>().map_err(e);
    r
}

#[tauri::command]
fn add_task(db: State<Db>, title: String, list_id: Option<i64>, due: Option<String>, kind: String, cwd: Option<String>) -> Result<Task, String> {
    let c = db.0.lock().unwrap();
    c.execute("INSERT INTO tasks(title, list_id, due, kind, cwd) VALUES (?1, ?2, ?3, ?4, ?5)", params![title, list_id, due, kind, cwd]).map_err(e)?;
    c.query_row(&format!("SELECT {TASK_COLS} FROM tasks WHERE id=?1"), [c.last_insert_rowid()], read_task).map_err(e)
}

#[tauri::command]
fn save_task(db: State<Db>, task: Task) -> Result<(), String> {
    db.0.lock().unwrap()
        .execute(
            "UPDATE tasks SET title=?1, notes=?2, due=?3, list_id=?4, status=?5, tags=?6 WHERE id=?7",
            params![task.title, task.notes, task.due, task.list_id, task.status, task.tags, task.id],
        )
        .map(|_| ()).map_err(e)
}

#[tauri::command]
fn delete_task(db: State<Db>, runs: State<Runs>, id: i64) -> Result<(), String> {
    if let Some(mut c) = runs.0.lock().unwrap().remove(&id) {
        kill_tree(c.id());
        let _ = c.kill();
        let _ = c.wait();
    }
    let c = db.0.lock().unwrap();
    c.execute("DELETE FROM events WHERE task_id=?1", [id]).map_err(e)?;
    c.execute("DELETE FROM tasks WHERE id=?1", [id]).map(|_| ()).map_err(e)
}

#[tauri::command]
fn events(db: State<Db>, task_id: i64) -> Result<Vec<Ev>, String> {
    let c = db.0.lock().unwrap();
    let mut s = c.prepare("SELECT kind, text FROM events WHERE task_id=?1 ORDER BY id").map_err(e)?;
    let r = s.query_map([task_id], |r| Ok(Ev { task_id, kind: r.get(0)?, text: r.get(1)? })).map_err(e)?.collect::<Result<_, _>>().map_err(e);
    r
}

#[tauri::command]
fn clis() -> Vec<Cli> {
    AGENTS
        .iter()
        .copied()
        .map(|name| Cli {
            name,
            path: which(name).map(|p| p.display().to_string()),
            cap: if name == "claude" { format!("30 turns · $1.50 · {CAP_MINUTES} min") } else { format!("{CAP_MINUTES} min") },
        })
        .collect()
}

#[tauri::command]
fn running(runs: State<Runs>) -> Vec<i64> {
    runs.0.lock().unwrap().keys().copied().collect()
}

#[tauri::command]
fn attachments_dir(m: State<Media>) -> String {
    m.0.display().to_string()
}

/// Stores an image or video sent as raw bytes (x-name header) and returns its Markdown path.
#[tauri::command]
fn attach(m: State<Media>, request: tauri::ipc::Request) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected the file's bytes.".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("file");
    let name: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' }).collect();
    let name = name.trim_start_matches('.');
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(e)?.as_millis();
    let file = format!("{stamp}-{name}");
    fs::write(m.0.join(&file), bytes).map_err(e)?;
    Ok(format!("attachments/{file}"))
}

#[tauri::command]
fn delegate(app: AppHandle, task_id: i64, agent: String, model: String, effort: String, access: Option<String>) -> Result<(), String> {
    let access = access.unwrap_or_default();
    access_args(&agent, &access)?;
    if !plain(&model) || !plain(&effort) {
        return Err("Model and reasoning may only use letters, digits, '.', '_' and '-'.".into());
    }
    let (title, notes, sid): (String, String, Option<String>) = {
        let c = app.state::<Db>();
        let c = c.0.lock().unwrap();
        c.query_row("SELECT title, notes, session_id FROM tasks WHERE id=?1", [task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
    };
    if sid.is_some() {
        return Err("This task already has a session. Reply to continue it.".into());
    }
    // Agents get real paths for attached images and videos.
    let media = app.state::<Media>().0.clone();
    let notes = notes.replace("](attachments/", &format!("]({}{}", media.display(), std::path::MAIN_SEPARATOR));
    let prompt = [title.trim(), notes.trim(), TAIL].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    start(&app, task_id, &agent, &model, &effort, &access, None, prompt, "prompt")?;
    let db = app.state::<Db>();
    db.0.lock().unwrap().execute("UPDATE tasks SET agent=?1, model=?2, effort=?3, access=?4 WHERE id=?5", params![agent, model, effort, access, task_id]).map_err(e)?;
    Ok(())
}

/// Continues the session. Model, reasoning and access may change between turns (the Code view's pickers, /model).
#[tauri::command]
fn reply(app: AppHandle, task_id: i64, text: String, model: Option<String>, effort: Option<String>, access: Option<String>) -> Result<(), String> {
    let (agent, sid, m, x, a): (Option<String>, Option<String>, String, String, String) = {
        let c = app.state::<Db>();
        let c = c.0.lock().unwrap();
        c.query_row("SELECT agent, session_id, model, effort, access FROM tasks WHERE id=?1", [task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(e)?
    };
    let (model, effort, access) = (model.unwrap_or(m), effort.unwrap_or(x), access.unwrap_or(a));
    if !plain(&model) || !plain(&effort) {
        return Err("Model and reasoning may only use letters, digits, '.', '_' and '-'.".into());
    }
    if let Some(ag) = &agent { access_args(ag, &access)?; }
    app.state::<Db>().0.lock().unwrap()
        .execute("UPDATE tasks SET model=?1, effort=?2, access=?3 WHERE id=?4", params![model, effort, access, task_id]).map_err(e)?;
    match (agent, sid) {
        (Some(a), Some(s)) => start(&app, task_id, &a, &model, &effort, &access, Some(s), text, "reply"),
        _ => Err("No session to resume yet.".into()),
    }
}

#[tauri::command]
fn stop(runs: State<Runs>, task_id: i64) {
    let child = runs.0.lock().unwrap().remove(&task_id);
    if let Some(mut c) = child {
        kill_tree(c.id());
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut c = Command::new("taskkill");
    c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    c.creation_flags(NO_WINDOW);
    let _ = c.status();
}

/// Agents start in their own process group (see start), so this ends the agent and everything it spawned.
#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).stderr(Stdio::null()).status();
}

/// System notification with the default sound for a finished run; the in-app bell reads the same "verdict"/"end" events.
fn notify(app: &AppHandle, task_id: i64, agent: &str, body: &str) {
    let title: String = app.state::<Db>().0.lock().unwrap()
        .query_row("SELECT title FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).unwrap_or_default();
    let who = agent[..1].to_uppercase() + &agent[1..];
    let _ = app.notification().builder().title(format!("{who} Agent · {title}")).body(body).sound("Default").show();
}

fn push(app: &AppHandle, task_id: i64, kind: &str, text: &str) {
    if !matches!(kind, "delta" | "commands") {
        let db = app.state::<Db>();
        let _ = db.0.lock().unwrap().execute("INSERT INTO events(task_id, kind, text) VALUES (?1, ?2, ?3)", params![task_id, kind, text]);
    }
    let _ = app.emit("agent", Ev { task_id, kind: kind.into(), text: text.into() });
}

#[allow(clippy::too_many_arguments)]
fn start(app: &AppHandle, task_id: i64, agent: &str, model: &str, effort: &str, access: &str, sid: Option<String>, text: String, kind: &str) -> Result<(), String> {
    let perms = access_args(agent, access)?;
    let runs = app.state::<Runs>();
    let mut map = runs.0.lock().unwrap();
    if map.contains_key(&task_id) {
        return Err("Already running.".into());
    }
    let exe = which(agent).ok_or(format!("{agent} is not on PATH"))?;
    let cwd: Option<String> = app.state::<Db>().0.lock().unwrap().query_row("SELECT cwd FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).map_err(e)?;
    let dir = cwd.map(PathBuf::from).unwrap_or_else(|| work_root().join(task_id.to_string()));
    fs::create_dir_all(&dir).map_err(e)?;
    // Rust refuses newlines in .cmd/.bat args; exe shims (and anything on macOS) take them fine.
    let is_exe = !cfg!(windows) || exe.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"));
    let arg = if is_exe { text.clone() } else { text.replace(['\r', '\n'], " ") };

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_remove("CLAUDECODE");
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    match agent {
        "claude" => {
            if let Some(s) = &sid { cmd.args(["-r", s]); }
            cmd.arg("-p").arg(&arg).args(CLAUDE_FLAGS).args(perms);
            if !model.is_empty() { cmd.args(["--model", model]); }
            if !effort.is_empty() { cmd.args(["--effort", effort]); }
        }
        "codex" => {
            cmd.args(["exec", "--skip-git-repo-check"]).args(perms);
            if !model.is_empty() { cmd.args(["-m", model]); }
            if !effort.is_empty() { cmd.arg("-c").arg(format!("model_reasoning_effort={effort}")); }
            if let Some(s) = &sid { cmd.args(["resume", s]); }
            cmd.arg(&arg);
        }
        "grok" => {
            cmd.arg("--no-auto-update");
            if let Some(s) = &sid { cmd.args(["-r", s]); }
            if !model.is_empty() { cmd.args(["-m", model]); }
            if !effort.is_empty() { cmd.args(["--reasoning-effort", effort]); }
            cmd.args(perms).arg("-p").arg(&arg).args(["--output-format", "streaming-json"]);
        }
        "hermes" => {
            // Nous Research's Hermes Agent: one query, quiet output, no approval prompts nobody could answer.
            cmd.arg("chat");
            if let Some(s) = &sid { cmd.args(["-r", s]); }
            cmd.arg("-Q").args(perms);
            if !model.is_empty() { cmd.args(["-m", model]); }
            cmd.arg("-q").arg(&arg);
        }
        "gemini" => {
            if let Some(s) = &sid { cmd.args(["--resume", s]); }
            cmd.arg("-p").arg(&arg).args(perms).args(["--output-format", "stream-json"]);
            if !model.is_empty() { cmd.args(["-m", model]); }
        }
        _ => return Err(format!("Unknown agent {agent}")),
    }
    let mut child = cmd.spawn().map_err(|x| format!("Could not start {agent}: {x}"))?;
    let pid = child.id();
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    map.insert(task_id, child);
    drop(map);
    let _ = app.state::<Db>().0.lock().unwrap().execute("UPDATE tasks SET verdict='' WHERE id=?1", [task_id]);
    push(app, task_id, kind, &text);

    let a = app.clone();
    let errt = thread::spawn(move || pump(&a, task_id, err, true));
    let a = app.clone();
    let grok = agent == "grok";
    let name = agent.to_string();
    thread::spawn(move || {
        let verdict = pump(&a, task_id, out, false);
        let _ = errt.join();
        if let Some(v) = verdict {
            // The agent's own call: "complete" closes the task, the others wait for the user.
            let db = a.state::<Db>();
            let _ = db.0.lock().unwrap().execute(
                "UPDATE tasks SET verdict=?1, status=CASE WHEN ?1='complete' THEN 'done' ELSE status END WHERE id=?2",
                params![v, task_id],
            );
            push(&a, task_id, "verdict", v);
            notify(&a, task_id, &name, match v {
                "complete" => "Finished and marked the task done.",
                "review" => "Done. Ready for your review.",
                _ => "Has a question for you.",
            });
        }
        let child = a.state::<Runs>().0.lock().unwrap().remove(&task_id);
        let Some(mut c) = child else { return push(&a, task_id, "end", "Stopped.") };
        let code = c.wait().ok().and_then(|s| s.code());
        if verdict.is_none() && code != Some(0) {
            notify(&a, task_id, &name, "Stopped before finishing.");
        }
        if grok && code != Some(0) {
            push(&a, task_id, "hint", "If Grok isn't logged in, run `grok` once in a terminal.");
        }
        push(&a, task_id, "end", &code.map_or("Exited.".into(), |c| format!("Exited with code {c}.")));
    });
    let a = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(CAP_MINUTES * 60));
        let hit = a.state::<Runs>().0.lock().unwrap().get(&task_id).is_some_and(|c| c.id() == pid);
        if hit {
            push(&a, task_id, "hint", &format!("Hit the {CAP_MINUTES}-minute cap. Stopping."));
            kill_tree(pid);
        }
    });
    Ok(())
}

/// Streams one pipe into thread events; returns the last ORLO_STATUS the agent printed.
fn pump(app: &AppHandle, task_id: i64, r: impl Read, is_err: bool) -> Option<&'static str> {
    let mut verdict = None;
    let mut s = Sink { is_err, ..Default::default() };
    let mut br = BufReader::new(r);
    let mut buf = Vec::new();
    while br.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
        buf.clear();
        for (kind, text) in s.line(&line) {
            if !is_err && kind != "delta" {
                verdict = status_in(&text).or(verdict);
            }
            push(app, task_id, kind, &text);
        }
        if let Some(sid) = s.sid.take() {
            let db = app.state::<Db>();
            let _ = db.0.lock().unwrap().execute("UPDATE tasks SET session_id=?1 WHERE id=?2 AND session_id IS NULL", params![sid, task_id]);
        }
    }
    if !s.live.trim().is_empty() {
        verdict = status_in(&s.live).or(verdict);
        push(app, task_id, "text", s.live.trim());
    }
    verdict
}

fn status_in(text: &str) -> Option<&'static str> {
    text.lines().rev().find_map(|l| {
        let v = l.trim().trim_matches('`').strip_prefix("ORLO_STATUS:")?.trim().trim_matches('`').to_ascii_lowercase();
        ["complete", "review", "input"].into_iter().find(|k| v.starts_with(k))
    })
}

/// Turns one output line from any of the CLIs into thread events.
#[derive(Default)]
struct Sink { is_err: bool, live: String, prev: String, sid: Option<String>, last: String, cmds: bool }

impl Sink {
    /// Streamed text so far as one finished message.
    fn flush(&mut self) -> Vec<(&'static str, String)> {
        let t = std::mem::take(&mut self.live);
        if t.trim().is_empty() { vec![] } else { vec![("text", t.trim().to_string())] }
    }

    fn line(&mut self, l: &str) -> Vec<(&'static str, String)> {
        let mut out = self.parse(l);
        // Claude sends its final answer as a message and again as the result; show it once.
        out.retain(|(k, t)| !(*k == "result" && t.trim() == self.last.trim()));
        if let Some((_, t)) = out.iter().rev().find(|(k, _)| matches!(*k, "text" | "result")) {
            self.last = t.clone();
        }
        out
    }

    fn parse(&mut self, l: &str) -> Vec<(&'static str, String)> {
        if l.trim().is_empty() {
            return vec![];
        }
        if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(l) {
            return self.json(&v);
        }
        let prev = std::mem::replace(&mut self.prev, l.trim().to_string());
        // codex prints "session id: …", hermes "Session: …" or "session_id: …"
        let t = l.trim();
        if let Some(n) = ["session id:", "session_id:", "session:"].iter().find(|p| t.to_ascii_lowercase().starts_with(*p)).map(|p| p.len()) {
            if let Some(id) = t[n..].split_whitespace().next() {
                self.sid = Some(id.to_string());
            }
        }
        if prev == "tokens used" {
            return vec![("cost", format!("{} tokens", l.trim()))];
        }
        if l.trim() == "tokens used" {
            return vec![];
        }
        vec![(if self.is_err { "log" } else { "text" }, l.to_string())]
    }

    fn json(&mut self, v: &Value) -> Vec<(&'static str, String)> {
        let s = |p: &str| v.pointer(p).and_then(Value::as_str);
        if let Some(id) = ["/session_id", "/sessionId", "/thread_id"].iter().find_map(|p| s(p)) {
            self.sid = Some(id.to_string());
        }
        match s("/type").unwrap_or("") {
            "stream_event" => match s("/event/delta/text") {
                Some(t) => {
                    self.live.push_str(t);
                    vec![("delta", t.to_string())]
                }
                None => vec![],
            },
            "assistant" => {
                self.live.clear();
                let blocks = v.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
                blocks.iter().filter_map(|b| match b["type"].as_str()? {
                    "text" => Some(("text", b["text"].as_str()?.to_string())),
                    "tool_use" => {
                        let i = &b["input"];
                        let arg = ["command", "file_path", "path", "pattern"].iter().find_map(|k| i[k].as_str()).unwrap_or("");
                        Some(("tool", format!("{} {arg}", b["name"].as_str().unwrap_or("tool")).trim().to_string()))
                    }
                    _ => None,
                }).collect()
            }
            "result" => {
                // Claude repeats its answer here; Gemini only streamed it, so the streamed text is the answer.
                let live = std::mem::take(&mut self.live);
                let mut out = vec![match s("/result") {
                    Some(t) => ("result", t.to_string()),
                    None if !live.trim().is_empty() => ("text", live.trim().to_string()),
                    None => ("result", s("/subtype").or(s("/status")).unwrap_or("Done.").to_string()),
                }];
                if let Some(cost) = v["total_cost_usd"].as_f64() {
                    out.push(("cost", format!("${cost:.2} · {} turns", v["num_turns"].as_u64().unwrap_or(0))));
                } else if let Some(t) = v.pointer("/stats/total_tokens").and_then(Value::as_u64) {
                    out.push(("cost", format!("{t} tokens")));
                }
                out
            }
            // Gemini's stream-json echoes the user's message too; only the assistant's is shown.
            "message" => match (s("/role"), s("/content")) {
                (Some("assistant"), Some(t)) => {
                    self.live.push_str(t);
                    vec![("delta", t.to_string())]
                }
                _ => vec![],
            },
            // Gemini's tool_use and Grok's tool_call; whatever was said before the call becomes its own message.
            "tool_use" | "tool_call" => {
                let i = v.get("parameters").or(v.get("rawInput")).cloned().unwrap_or_default();
                let arg = i.as_object().and_then(|o| o.values().find_map(Value::as_str)).unwrap_or("");
                let name = s("/tool_name").or(s("/toolName")).unwrap_or("tool");
                let mut out = self.flush();
                out.push(("tool", format!("{name} {}", arg.chars().take(160).collect::<String>()).trim().to_string()));
                out
            }
            // Grok's streaming-json: answer text arrives as {"type":"text","data":"…"}; its reasoning isn't shown.
            "text" => match s("/data") {
                Some(t) => {
                    self.live.push_str(t);
                    vec![("delta", t.to_string())]
                }
                None => vec![],
            },
            "system" if s("/subtype") == Some("compact_boundary") => {
                let n = |p: &str| v.pointer(p).and_then(Value::as_u64).unwrap_or(0);
                vec![("cost", format!("Compacted the conversation · {} → {} tokens", n("/compact_metadata/pre_tokens"), n("/compact_metadata/post_tokens")))]
            }
            // Claude lists its slash commands in its init line, Grok in available_commands (repeated, so only the first counts).
            "system" | "available_commands" => match v.get("slash_commands").or(v.get("commands")).and_then(Value::as_array) {
                Some(list) if !self.cmds => {
                    self.cmds = true;
                    let names: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
                    vec![("commands", names.join(","))]
                }
                _ => vec![],
            },
            "user" | "init" | "tool_result" | "thought" | "tool_call_update" | "usage" => vec![],
            _ => {
                if let Some(r) = s("/result") {
                    self.live.clear();
                    return vec![("result", r.to_string())];
                }
                if let Some(t) = ["/text", "/content", "/delta"].iter().find_map(|p| s(p)) {
                    self.live.push_str(t);
                    return vec![("delta", t.to_string())];
                }
                // Bookkeeping events CLIs add over time (rate_limit_event, …) carry no text for the user.
                vec![]
            }
        }
    }
}

// Self-update for the portable exe: download the release asset, check it against the SHA-256
// GitHub publishes for it, swap it in for the running exe (Windows allows renaming a running exe)
// and restart. The frontend finds the release; this side only trusts this repo's download URLs.
const RELEASES: &str = "https://github.com/carbongotfound/orlo/releases/download/";

fn is_release_url(url: &str) -> bool {
    url.starts_with(RELEASES) && url.ends_with(".exe") && !url.contains("..") && !url.contains(['?', '#', '\\'])
}

#[tauri::command]
async fn install_update(app: AppHandle, url: String, sha256: String) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if !cfg!(windows) { return Err("In-app updates are for the Windows exe. Download the new version from GitHub Releases.".into()) }
    if !is_release_url(&url) { return Err("Not an Orlo release download".into()) }
    let exe = std::env::current_exe().map_err(e)?;
    let new = exe.with_extension("new");
    let old = exe.with_extension("old");
    // curl.exe ships with Windows 10+, so no HTTP client is bundled for one download.
    let mut curl = Command::new("curl.exe");
    curl.args(["-fsSL", "--proto", "=https", "--proto-redir", "=https", "-o"]).arg(&new).arg(&url);
    #[cfg(windows)]
    curl.creation_flags(NO_WINDOW);
    let out = curl.output().map_err(e)?;
    if !out.status.success() { return Err(format!("Download failed: {}", String::from_utf8_lossy(&out.stderr).trim())) }
    let got = format!("{:x}", Sha256::digest(fs::read(&new).map_err(e)?));
    if !got.eq_ignore_ascii_case(sha256.trim_start_matches("sha256:")) {
        let _ = fs::remove_file(&new);
        return Err("The download didn't match the release checksum, so nothing was changed".into());
    }
    let _ = fs::remove_file(&old);
    fs::rename(&exe, &old).map_err(e)?;
    if let Err(x) = fs::rename(&new, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(e(x));
    }
    Command::new(&exe).spawn().map_err(e)?;
    app.exit(0);
    Ok(())
}

/// PATH lookup; on Windows a real .exe anywhere on PATH wins over shims.
fn which(name: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH")?).collect();
    let pathext = std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = if cfg!(windows) {
        std::iter::once(".exe").chain(pathext.split(';').filter(|x| !x.is_empty() && !x.eq_ignore_ascii_case(".exe"))).collect()
    } else {
        vec![""]
    };
    for ext in exts {
        for d in &dirs {
            let p = d.join(format!("{name}{ext}"));
            if !p.is_file() {
                continue;
            }
            // npm's claude.cmd just forwards to this exe; spawning it directly keeps newlines intact
            let sib = d.join(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe");
            if cfg!(windows) && name == "claude" && ext != ".exe" && sib.is_file() {
                return Some(sib);
            }
            return Some(p);
        }
    }
    None
}

/// Apps opened from Finder get launchd's bare PATH, so CLIs in ~/.local/bin or Homebrew would look missing.
/// Use the PATH the user's login shell builds, the same one a terminal gets.
#[cfg(target_os = "macos")]
fn shell_path() {
    let sh = std::env::var("SHELL").unwrap_or("/bin/zsh".into());
    let mut dirs: Vec<PathBuf> = Command::new(sh)
        .args(["-ilc", r#"printf '\n__ORLO_PATH__%s' "$PATH""#])
        .stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).rsplit_once("__ORLO_PATH__").map(|(_, p)| p.trim().to_string()))
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    dirs.extend([home.join(".local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    if let Ok(p) = std::env::join_paths(dirs) { std::env::set_var("PATH", p) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = cli::main() {
        std::process::exit(code);
    }
    #[cfg(target_os = "macos")]
    shell_path();
    tauri::Builder::default()
        // Registered first: launching Orlo again just brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Runs::default())
        .manage(Term::default())
        .setup(|app| {
            // ORLO_DATA keeps a dev or demo database apart from the real one.
            let dir = match std::env::var_os("ORLO_DATA") { Some(d) => PathBuf::from(d), None => app.path().app_data_dir()? };
            fs::create_dir_all(&dir)?;
            let c = Connection::open(dir.join("orlo.db"))?;
            // `orlo done` from a terminal may hold the file for a moment.
            c.busy_timeout(Duration::from_secs(5))?;
            c.execute_batch(SCHEMA)?;
            // Columns added after v1; the error on an already-migrated db is expected.
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN verdict TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN cwd TEXT", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN access TEXT NOT NULL DEFAULT ''", []);
            app.manage(Db(Mutex::new(c)));
            let media = dir.join("attachments");
            fs::create_dir_all(&media)?;
            // The webview may load files from this folder only.
            app.asset_protocol_scope().allow_directory(&media, false)?;
            app.manage(Media(media));
            // Left behind by install_update; the previous process may still hold it, then it goes next time.
            if let Ok(exe) = std::env::current_exe() { let _ = fs::remove_file(exe.with_extension("old")); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lists, add_list, rename_list, delete_list, tag_colors, set_tag_color, rename_tag, agent_skill, list_dir, list_files, read_text, write_text, make_dir, rename_path, delete_path, run_cmd, stop_cmd, tasks, add_task, save_task, delete_task, events, clis, running, delegate, reply, stop, install_update, attachments_dir, attach, git
        ])
        .build(tauri::generate_context!())
        .expect("error while building orlo")
        .run(|app, ev| {
            // never leave an agent editing files after the window is gone
            if let RunEvent::Exit = ev {
                for (_, c) in app.state::<Runs>().0.lock().unwrap().drain() {
                    kill_tree(c.id());
                }
                if let Some(c) = app.state::<Term>().0.lock().unwrap().as_mut() { kill_tree(c.id()) }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_trusts_release_downloads() {
        use super::is_release_url;
        assert!(is_release_url("https://github.com/carbongotfound/orlo/releases/download/v1.1.0/Orlo-1.1.0-windows-x64.exe"));
        assert!(!is_release_url("https://github.com/someone/orlo/releases/download/v1.1.0/Orlo.exe"));
        assert!(!is_release_url("https://github.com/carbongotfound/orlo/releases/download/../../x/evil.exe"));
        assert!(!is_release_url("https://github.com/carbongotfound/orlo/releases/download/v1/a.exe?x=.exe"));
        assert!(!is_release_url("http://github.com/carbongotfound/orlo/releases/download/v1/a.exe"));
    }

    use super::*;

    #[test]
    fn reads_status_line() {
        assert_eq!(status_in("Made the folder.\n\nORLO_STATUS: complete"), Some("complete"));
        assert_eq!(status_in("`ORLO_STATUS: review`"), Some("review"));
        assert_eq!(status_in("Which drive?\nORLO_STATUS: input\n"), Some("input"));
        assert_eq!(status_in("ORLO_STATUS: maybe"), None);
        assert_eq!(status_in("no status"), None);
    }

    #[test]
    fn parses_claude_and_codex_lines() {
        let mut s = Sink::default();
        assert!(s.line(r#"{"type":"system","session_id":"abc"}"#).is_empty());
        assert_eq!(s.sid.take().as_deref(), Some("abc"));
        assert_eq!(s.line(r#"{"type":"stream_event","event":{"delta":{"text":"Hi"}}}"#), vec![("delta", "Hi".into())]);
        assert_eq!(
            s.line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#),
            vec![("text", "Hi".into()), ("tool", "Bash ls".into())]
        );
        assert!(s.live.is_empty());
        assert_eq!(
            s.line(r#"{"type":"result","result":"Done","total_cost_usd":0.0812,"num_turns":3}"#),
            vec![("result", "Done".into()), ("cost", "$0.08 · 3 turns".into())]
        );
        assert_eq!(
            s.line(r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":40215,"post_tokens":6668}}"#),
            vec![("cost", "Compacted the conversation · 40215 → 6668 tokens".into())]
        );
        s.line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All done."}]}}"#);
        assert_eq!(s.line(r#"{"type":"result","result":"All done.","total_cost_usd":0.1,"num_turns":1}"#), vec![("cost", "$0.10 · 1 turns".into())]);

        let mut c = Sink { is_err: true, ..Default::default() };
        assert_eq!(c.line("session id: 019a-77"), vec![("log", "session id: 019a-77".into())]);
        assert_eq!(c.sid.as_deref(), Some("019a-77"));
        assert!(c.line("tokens used").is_empty());
        assert_eq!(c.line("1,234"), vec![("cost", "1,234 tokens".into())]);
    }

    #[test]
    fn keeps_out_of_sign_in_folders() {
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
        let codex = PathBuf::from(&home).join(".codex");
        if codex.is_dir() { assert!(editable(&codex.to_string_lossy()).is_err()) }
        assert!(editable(&std::env::temp_dir().to_string_lossy()).is_ok());
    }

    #[test]
    fn renames_tags() {
        assert_eq!(retag("Work,Urgent", "Work", "Job").as_deref(), Some("Job,Urgent"));
        assert_eq!(retag("Work, Job", "Work", "Job").as_deref(), Some("Job"));
        assert_eq!(retag("Workshop", "Work", "Job"), None);
        assert_eq!(retag("", "Work", "Job"), None);
    }

    #[test]
    fn parses_gemini_and_hermes_lines() {
        let mut g = Sink::default();
        assert!(g.line(r#"{"type":"init","session_id":"g-1","model":"x"}"#).is_empty());
        assert_eq!(g.sid.take().as_deref(), Some("g-1"));
        assert!(g.line(r#"{"type":"message","role":"user","content":"do it"}"#).is_empty());
        assert_eq!(g.line(r#"{"type":"message","role":"assistant","content":"Done. ORLO_STATUS: review","delta":true}"#), vec![("delta", "Done. ORLO_STATUS: review".into())]);
        assert_eq!(
            g.line(r#"{"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"ls"}}"#),
            vec![("text", "Done. ORLO_STATUS: review".into()), ("tool", "run_shell_command ls".into())]
        );
        assert_eq!(g.line(r#"{"type":"message","role":"assistant","content":"All set.","delta":true}"#), vec![("delta", "All set.".into())]);
        assert_eq!(
            g.line(r#"{"type":"result","status":"success","stats":{"total_tokens":42}}"#),
            vec![("text", "All set.".into()), ("cost", "42 tokens".into())]
        );

        let mut k = Sink::default();
        assert!(k.line(r#"{"type":"thought","data":" verify the success "}"#).is_empty());
        assert!(k.line(r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#).is_empty());
        assert_eq!(k.line(r#"{"type":"available_commands","tools":["read_file"],"commands":["compact","review"]}"#), vec![("commands", "compact,review".into())]);
        assert!(k.line(r#"{"type":"available_commands","commands":["compact"]}"#).is_empty());
        // Grok names its session only on the last line; that is enough to resume it.
        k.line(r#"{"type":"end","stopReason":"end_turn","sessionId":"97c18453-fb89"}"#);
        assert_eq!(k.sid.as_deref(), Some("97c18453-fb89"));
        assert_eq!(k.line(r#"{"type":"text","data":"Reading it."}"#), vec![("delta", "Reading it.".into())]);
        assert_eq!(
            k.line(r#"{"type":"tool_call","toolCallId":"c-1","status":"pending","toolName":"read_file","rawInput":{"target_file":"a.md"}}"#),
            vec![("text", "Reading it.".into()), ("tool", "read_file a.md".into())]
        );
        assert!(k.line(r#"{"type":"tool_call_update","toolCallId":"c-1","status":null}"#).is_empty());
        assert!(k.line(r#"{"type":"usage","usage":{"input_tokens":1}}"#).is_empty());

        let mut h = Sink::default();
        assert_eq!(h.line("Session:        20260225_143052_a1b2c3"), vec![("text", "Session:        20260225_143052_a1b2c3".into())]);
        assert_eq!(h.sid.as_deref(), Some("20260225_143052_a1b2c3"));
    }

    #[cfg(windows)]
    #[test]
    fn prefers_exe_over_shim() {
        let tmp = std::env::temp_dir().join("orlo-which");
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("zzorlo.cmd"), "").unwrap();
        fs::write(b.join("zzorlo.exe"), "").unwrap();
        std::env::set_var("PATH", std::env::join_paths([&a, &b]).unwrap());
        assert_eq!(which("zzorlo"), Some(b.join("zzorlo.exe")));
        assert_eq!(which("zzorlo-missing"), None);
    }
}
