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

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const TAIL: &str = "Do not delete files unless the task says so. When finished, summarize what you changed. \
End your final message with exactly one status line: `ORLO_STATUS: complete` if the task is fully done, \
`ORLO_STATUS: review` if a person should check your work first, or `ORLO_STATUS: input` if you need an answer \
from the user (ask the question just above that line).";
const CAP_MINUTES: u64 = 20;
const CLAUDE_FLAGS: &[&str] = &[
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit",
    "--max-turns", "30", "--max-budget-usd", "1.50",
];
// No --bare: it switches Claude Code to API-key-only auth, so a normal `claude /login` would read as "Not logged in".
const NO_WINDOW: u32 = 0x0800_0000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS lists(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  due TEXT, list_id INTEGER, status TEXT NOT NULL DEFAULT 'open', agent TEXT, session_id TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
";

struct Db(Mutex<Connection>);
#[derive(Default)]
struct Runs(Mutex<HashMap<i64, Child>>);

#[derive(Serialize)]
struct List { id: i64, name: String }

#[derive(Serialize, Deserialize)]
struct Task {
    id: i64, title: String, notes: String, due: Option<String>, list_id: Option<i64>,
    status: String, agent: Option<String>, session_id: Option<String>, tags: String, kind: String, model: String, effort: String, verdict: String,
}

#[derive(Serialize, Clone)]
struct Ev { task_id: i64, kind: String, text: String }

#[derive(Serialize)]
struct Cli { name: &'static str, path: Option<String>, cap: String }

fn e<E: ToString>(x: E) -> String { x.to_string() }

/// Each delegated task gets its own folder here. ORLO_WORK overrides the default ~/Orlo.
fn work_root() -> PathBuf {
    std::env::var_os("ORLO_WORK").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("Orlo"))
}

fn read_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?, title: r.get(1)?, notes: r.get(2)?, due: r.get(3)?, list_id: r.get(4)?,
        status: r.get(5)?, agent: r.get(6)?, session_id: r.get(7)?, tags: r.get(8)?, kind: r.get(9)?, model: r.get(10)?, effort: r.get(11)?, verdict: r.get(12)?,
    })
}
const TASK_COLS: &str = "id, title, notes, due, list_id, status, agent, session_id, tags, kind, model, effort, verdict";

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
fn tasks(db: State<Db>) -> Result<Vec<Task>, String> {
    let c = db.0.lock().unwrap();
    let mut s = c.prepare(&format!("SELECT {TASK_COLS} FROM tasks ORDER BY status='done', id")).map_err(e)?;
    let r = s.query_map([], read_task).map_err(e)?.collect::<Result<_, _>>().map_err(e);
    r
}

#[tauri::command]
fn add_task(db: State<Db>, title: String, list_id: Option<i64>, due: Option<String>, kind: String) -> Result<Task, String> {
    let c = db.0.lock().unwrap();
    c.execute("INSERT INTO tasks(title, list_id, due, kind) VALUES (?1, ?2, ?3, ?4)", params![title, list_id, due, kind]).map_err(e)?;
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
    ["claude", "codex", "grok"]
        .into_iter()
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
fn delegate(app: AppHandle, task_id: i64, agent: String, model: String, effort: String) -> Result<(), String> {
    // Both end up as CLI args; keep them to plain identifiers.
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !ok(&model) || !ok(&effort) {
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
    let prompt = [title.trim(), notes.trim(), TAIL].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    start(&app, task_id, &agent, &model, &effort, None, prompt, "prompt")?;
    let db = app.state::<Db>();
    db.0.lock().unwrap().execute("UPDATE tasks SET agent=?1, model=?2, effort=?3 WHERE id=?4", params![agent, model, effort, task_id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
fn reply(app: AppHandle, task_id: i64, text: String) -> Result<(), String> {
    let (agent, sid, model, effort): (Option<String>, Option<String>, String, String) = {
        let c = app.state::<Db>();
        let c = c.0.lock().unwrap();
        c.query_row("SELECT agent, session_id, model, effort FROM tasks WHERE id=?1", [task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(e)?
    };
    match (agent, sid) {
        (Some(a), Some(s)) => start(&app, task_id, &a, &model, &effort, Some(s), text, "reply"),
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

fn kill_tree(pid: u32) {
    let mut c = Command::new("taskkill");
    c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(NO_WINDOW);
    let _ = c.status();
}

/// Windows toast for a finished run; the in-app bell reads the same "verdict"/"end" events.
fn notify(app: &AppHandle, task_id: i64, agent: &str, body: &str) {
    let title: String = app.state::<Db>().0.lock().unwrap()
        .query_row("SELECT title FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).unwrap_or_default();
    let who = agent[..1].to_uppercase() + &agent[1..];
    let _ = app.notification().builder().title(format!("{who} Agent · {title}")).body(body).show();
}

fn push(app: &AppHandle, task_id: i64, kind: &str, text: &str) {
    if kind != "delta" {
        let db = app.state::<Db>();
        let _ = db.0.lock().unwrap().execute("INSERT INTO events(task_id, kind, text) VALUES (?1, ?2, ?3)", params![task_id, kind, text]);
    }
    let _ = app.emit("agent", Ev { task_id, kind: kind.into(), text: text.into() });
}

#[allow(clippy::too_many_arguments)]
fn start(app: &AppHandle, task_id: i64, agent: &str, model: &str, effort: &str, sid: Option<String>, text: String, kind: &str) -> Result<(), String> {
    let runs = app.state::<Runs>();
    let mut map = runs.0.lock().unwrap();
    if map.contains_key(&task_id) {
        return Err("Already running.".into());
    }
    let exe = which(agent).ok_or(format!("{agent} is not on PATH"))?;
    let dir = work_root().join(task_id.to_string());
    fs::create_dir_all(&dir).map_err(e)?;
    // Rust refuses newlines in .cmd/.bat args; exe shims take them fine.
    let is_exe = exe.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"));
    let arg = if is_exe { text.clone() } else { text.replace(['\r', '\n'], " ") };

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_remove("CLAUDECODE");
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    match agent {
        "claude" => {
            if let Some(s) = &sid { cmd.args(["-r", s]); }
            cmd.arg("-p").arg(&arg).args(CLAUDE_FLAGS);
            if !model.is_empty() { cmd.args(["--model", model]); }
            if !effort.is_empty() { cmd.args(["--effort", effort]); }
        }
        "codex" => {
            // codex's unelevated Windows sandbox refuses every command ("cannot enforce split writable
            // root sets"), so it gets the same full user access the claude agent has through Bash.
            cmd.args(["exec", "--skip-git-repo-check", "-s", "danger-full-access"]);
            if !model.is_empty() { cmd.args(["-m", model]); }
            if !effort.is_empty() { cmd.arg("-c").arg(format!("model_reasoning_effort={effort}")); }
            if let Some(s) = &sid { cmd.args(["resume", s]); }
            cmd.arg(&arg);
        }
        "grok" => {
            cmd.arg("--no-auto-update");
            if let Some(s) = &sid { cmd.args(["-r", s]); }
            cmd.arg("-p").arg(&arg).args(["--output-format", "streaming-json"]);
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
struct Sink { is_err: bool, live: String, prev: String, sid: Option<String> }

impl Sink {
    fn line(&mut self, l: &str) -> Vec<(&'static str, String)> {
        if l.trim().is_empty() {
            return vec![];
        }
        if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(l) {
            return self.json(&v, l);
        }
        let prev = std::mem::replace(&mut self.prev, l.trim().to_string());
        if let Some(s) = l.trim().strip_prefix("session id:") {
            self.sid = Some(s.trim().to_string());
        }
        if prev == "tokens used" {
            return vec![("cost", format!("{} tokens", l.trim()))];
        }
        if l.trim() == "tokens used" {
            return vec![];
        }
        vec![(if self.is_err { "log" } else { "text" }, l.to_string())]
    }

    fn json(&mut self, v: &Value, raw: &str) -> Vec<(&'static str, String)> {
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
                self.live.clear();
                let text = s("/result").or(s("/subtype")).unwrap_or("Done.").to_string();
                let cost = v["total_cost_usd"].as_f64().unwrap_or(0.0);
                let turns = v["num_turns"].as_u64().unwrap_or(0);
                vec![("result", text), ("cost", format!("${cost:.2} · {turns} turns"))]
            }
            "system" | "user" => vec![],
            _ => {
                if let Some(r) = s("/result") {
                    self.live.clear();
                    return vec![("result", r.to_string())];
                }
                if let Some(t) = ["/text", "/content", "/delta"].iter().find_map(|p| s(p)) {
                    self.live.push_str(t);
                    return vec![("delta", t.to_string())];
                }
                vec![("log", raw.chars().take(200).collect())]
            }
        }
    }
}

/// PATH lookup preferring a real .exe anywhere on PATH over shims.
fn which(name: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH")?).collect();
    let pathext = std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into());
    let exts = std::iter::once(".exe").chain(pathext.split(';').filter(|x| !x.is_empty() && !x.eq_ignore_ascii_case(".exe")));
    for ext in exts {
        for d in &dirs {
            let p = d.join(format!("{name}{ext}"));
            if !p.is_file() {
                continue;
            }
            // npm's claude.cmd just forwards to this exe; spawning it directly keeps newlines intact
            let sib = d.join(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe");
            if name == "claude" && ext != ".exe" && sib.is_file() {
                return Some(sib);
            }
            return Some(p);
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Runs::default())
        .setup(|app| {
            // ORLO_DATA keeps a dev or demo database apart from the real one.
            let dir = match std::env::var_os("ORLO_DATA") { Some(d) => PathBuf::from(d), None => app.path().app_data_dir()? };
            fs::create_dir_all(&dir)?;
            let c = Connection::open(dir.join("orlo.db"))?;
            c.execute_batch(SCHEMA)?;
            // Columns added after v1; the error on an already-migrated db is expected.
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT ''", []);
            let _ = c.execute("ALTER TABLE tasks ADD COLUMN verdict TEXT NOT NULL DEFAULT ''", []);
            app.manage(Db(Mutex::new(c)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lists, add_list, rename_list, delete_list, tasks, add_task, save_task, delete_task, events, clis, running, delegate, reply, stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building orlo")
        .run(|app, ev| {
            // never leave an agent editing files after the window is gone
            if let RunEvent::Exit = ev {
                for (_, c) in app.state::<Runs>().0.lock().unwrap().drain() {
                    kill_tree(c.id());
                }
            }
        });
}

#[cfg(test)]
mod tests {
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

        let mut c = Sink { is_err: true, ..Default::default() };
        assert_eq!(c.line("session id: 019a-77"), vec![("log", "session id: 019a-77".into())]);
        assert_eq!(c.sid.as_deref(), Some("019a-77"));
        assert!(c.line("tokens used").is_empty());
        assert_eq!(c.line("1,234"), vec![("cost", "1,234 tokens".into())]);
    }

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
