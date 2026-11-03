// Module Rust « mcp » — transport stdio des serveurs MCP (les mêmes que Claude Desktop).
//
// Commandes (à enregistrer dans lib.rs par l'orchestrateur) :
//   mcp::mcp_spawn, mcp::mcp_send, mcp::mcp_kill, mcp::mcp_kill_all,
//   mcp::mcp_read_desktop_config, mcp::mcp_desktop_config_path
//
// Événements émis vers le webview :
//   « mcp-message » {id, line}  : une ligne JSON-RPC lue sur stdout du serveur
//   « mcp-log »     {id, line}  : une ligne de stderr (journal du serveur)
//   « mcp-exit »    {id, code}  : le processus s'est arrêté (après la dernière ligne stdout)
//
// Nettoyage : à la première ouverture d'un serveur, un petit plugin Tauri est enregistré
// dynamiquement pour tuer tous les serveurs (et leurs sous-processus) à la fermeture de l'app.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
struct McpLine {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct McpExit {
    id: String,
    code: Option<i32>,
}

struct Proc {
    generation: u64,
    pid: Option<u32>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    kill_tx: Option<oneshot::Sender<()>>,
}

static PROCS: OnceLock<Mutex<HashMap<String, Proc>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(1);
static CLEANUP_REGISTERED: AtomicBool = AtomicBool::new(false);

fn procs() -> &'static Mutex<HashMap<String, Proc>> {
    PROCS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_procs() -> std::sync::MutexGuard<'static, HashMap<String, Proc>> {
    procs().lock().unwrap_or_else(|e| e.into_inner())
}

/// Enregistre (une seule fois) un plugin qui tue tous les serveurs MCP à la fermeture de Prisme.
fn ensure_cleanup(app: &AppHandle) {
    if CLEANUP_REGISTERED.swap(true, Ordering::SeqCst) {
        return;
    }
    let plugin = tauri::plugin::Builder::<tauri::Wry, ()>::new("prisme-mcp-cleanup")
        .on_event(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_all_blocking();
            }
        })
        .build();
    if let Err(e) = app.plugin(plugin) {
        CLEANUP_REGISTERED.store(false, Ordering::SeqCst);
        eprintln!("[mcp] nettoyage à la fermeture non enregistré : {e}");
    }
}

/// Tue de force un processus et tous ses descendants (bloquant, utilisé à la fermeture).
fn force_kill_tree_blocking(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // Le serveur est lancé dans son propre groupe de processus : on tue tout le groupe.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Version asynchrone (utilisée par mcp_kill quand le serveur ne s'arrête pas de lui-même).
async fn force_kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

fn kill_all_blocking() {
    let drained: Vec<Proc> = lock_procs().drain().map(|(_, p)| p).collect();
    for p in drained {
        if let Some(pid) = p.pid {
            force_kill_tree_blocking(pid);
        }
        if let Some(tx) = p.kill_tx {
            let _ = tx.send(());
        }
    }
}

// ───────────────────────────── Résolution de la commande (Windows) ─────────────────────────────

/// Échappement façon cross-spawn / https://qntm.org/cmd pour une ligne passée à `cmd /D /S /C "…"`.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_cmd_meta(c: char) -> bool {
    matches!(c, '(' | ')' | '[' | ']' | '%' | '!' | '^' | '"' | '`' | '<' | '>' | '&' | '|' | ';' | ',' | ' ' | '*' | '?')
}

#[cfg_attr(not(windows), allow(dead_code))]
fn escape_cmd_meta(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if is_cmd_meta(c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn escape_cmd_command(cmd: &str) -> String {
    escape_cmd_meta(cmd)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn escape_cmd_argument(arg: &str, double_escape: bool) -> String {
    // 1) une suite de \ suivie d'un " : on double les \ et on échappe le "
    let mut quoted = String::with_capacity(arg.len() + 8);
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    // 2) des \ en fin de chaîne précèdent le " fermant : on les double
    quoted.push_str(&"\\".repeat(backslashes * 2));
    // 3) on entoure de guillemets puis on échappe les métacaractères de cmd
    let mut escaped = escape_cmd_meta(&format!("\"{quoted}\""));
    if double_escape {
        escaped = escape_cmd_meta(&escaped);
    }
    escaped
}

/// Cherche l'exécutable dans le PATH (avec PATHEXT), comme le ferait Windows.
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_in_path(command: &str, path_var: Option<&std::ffi::OsStr>, pathext: &str) -> Option<PathBuf> {
    let exts: Vec<String> = pathext
        .split(';')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let try_base = |base: &Path| -> Option<PathBuf> {
        if base.extension().is_some() && base.is_file() {
            return Some(base.to_path_buf());
        }
        for ext in &exts {
            let candidate = PathBuf::from(format!("{}{}", base.display(), ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    };
    let p = Path::new(command);
    if p.is_absolute() || command.contains('\\') || command.contains('/') {
        return try_base(p);
    }
    let paths = path_var?;
    for dir in std::env::split_paths(paths) {
        if let Some(found) = try_base(&dir.join(command)) {
            return Some(found);
        }
    }
    None
}

#[cfg(windows)]
fn build_command(command: &str, args: &[String], env: &HashMap<String, String>) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Les lanceurs (npx, uvx…) passent toujours par cmd /C, comme Claude Desktop.
    const SHELL_LAUNCHERS: [&str; 10] = ["npx", "npm", "pnpm", "pnpx", "yarn", "uvx", "uv", "bunx", "bun", "deno"];

    let path_var = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .or_else(|| std::env::var_os("PATH"));
    let pathext = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATHEXT"))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    let resolved = resolve_in_path(command, path_var.as_deref(), &pathext);

    let stem = Path::new(command)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let is_exe = resolved
        .as_ref()
        .and_then(|p| p.extension())
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            e == "exe" || e == "com"
        })
        .unwrap_or(false);
    let needs_shell = !is_exe || SHELL_LAUNCHERS.contains(&stem.as_str());

    let mut cmd = if needs_shell {
        // Les « shims » npm (node_modules\.bin\*.cmd) relisent leurs arguments : double échappement.
        let double = resolved
            .as_ref()
            .map(|p| {
                let s = p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
                s.contains("node_modules\\.bin\\") && s.ends_with(".cmd")
            })
            .unwrap_or(false);
        let mut line = escape_cmd_command(command);
        for a in args {
            line.push(' ');
            line.push_str(&escape_cmd_argument(a, double));
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(comspec);
        c.raw_arg("/D").raw_arg("/S").raw_arg("/C").raw_arg(format!("\"{line}\""));
        c
    } else {
        let mut c = Command::new(resolved.unwrap_or_else(|| PathBuf::from(command)));
        c.args(args);
        c
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn build_command(command: &str, args: &[String], _env: &HashMap<String, String>) -> Command {
    let mut c = Command::new(command);
    c.args(args);
    #[cfg(unix)]
    {
        // Groupe de processus dédié : permet d'arrêter aussi les sous-processus (npx → node…).
        c.process_group(0);
    }
    c
}

fn spawn_error_message(command: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "Impossible de lancer « {command} » : programme introuvable. Vérifie qu'il est installé et présent dans le PATH (pour npx : installe Node.js ; pour uvx : installe uv)."
        ),
        std::io::ErrorKind::PermissionDenied => {
            format!("Impossible de lancer « {command} » : accès refusé par le système.")
        }
        _ => format!("Impossible de lancer « {command} » : {e}"),
    }
}

/// Lit un flux ligne par ligne (UTF-8 tolérant) et émet chaque ligne non vide.
async fn pump_lines<T: AsyncRead + Unpin>(app: AppHandle, id: String, stream: T, event: &'static str) {
    let mut reader = BufReader::new(stream);
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                    buf.pop();
                }
                if buf.is_empty() {
                    continue;
                }
                let line = String::from_utf8_lossy(&buf).into_owned();
                let _ = app.emit(event, McpLine { id: id.clone(), line });
            }
            Err(_) => break,
        }
    }
}

// ───────────────────────────── Commandes ─────────────────────────────

/// Lance un serveur MCP stdio. `id` est choisi par le webview (unique par lancement).
/// Renvoie le PID du processus.
#[tauri::command]
pub async fn mcp_spawn(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Commande du serveur MCP vide.".to_string());
    }
    ensure_cleanup(&app);

    // Un ancien processus avec le même identifiant est arrêté.
    let old = lock_procs().remove(&id);
    if let Some(old) = old {
        if let Some(pid) = old.pid {
            force_kill_tree(pid).await;
        }
        if let Some(tx) = old.kill_tx {
            let _ = tx.send(());
        }
    }

    let env = env.unwrap_or_default();
    let mut cmd = build_command(&command, &args, &env);
    cmd.envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| spawn_error_message(&command, &e))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sortie standard du serveur MCP indisponible.".to_string())?;
    let stderr = child.stderr.take();

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    let stdin = Arc::new(tokio::sync::Mutex::new(stdin));

    lock_procs().insert(
        id.clone(),
        Proc { generation, pid, stdin: stdin.clone(), kill_tx: Some(kill_tx) },
    );

    let out_task = tauri::async_runtime::spawn(pump_lines(app.clone(), id.clone(), stdout, "mcp-message"));
    if let Some(err) = stderr {
        tauri::async_runtime::spawn(pump_lines(app.clone(), id.clone(), err, "mcp-log"));
    }

    // Surveillance : fin naturelle du processus, ou demande d'arrêt (fermeture de stdin puis arrêt forcé).
    let app_wait = app.clone();
    let id_wait = id.clone();
    let stdin_wait = stdin.clone();
    tauri::async_runtime::spawn(async move {
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = &mut kill_rx => {
                // Arrêt poli : fermer stdin suffit pour la plupart des serveurs MCP.
                stdin_wait.lock().await.take();
                match tokio::time::timeout(Duration::from_millis(1500), child.wait()).await {
                    Ok(s) => s.ok(),
                    Err(_) => {
                        if let Some(pid) = pid {
                            force_kill_tree(pid).await;
                        }
                        let _ = child.start_kill();
                        child.wait().await.ok()
                    }
                }
            }
        };
        // Toutes les lignes stdout sont émises avant l'événement de fin.
        let _ = tokio::time::timeout(Duration::from_secs(2), out_task).await;
        {
            let mut map = lock_procs();
            if map.get(&id_wait).map(|p| p.generation) == Some(generation) {
                map.remove(&id_wait);
            }
        }
        let _ = app_wait.emit("mcp-exit", McpExit { id: id_wait, code: status.and_then(|s| s.code()) });
    });

    Ok(pid.unwrap_or(0))
}

/// Écrit une ligne JSON-RPC sur stdin du serveur (le saut de ligne est ajouté ici).
#[tauri::command]
pub async fn mcp_send(id: String, line: String) -> Result<(), String> {
    let stdin = lock_procs()
        .get(&id)
        .map(|p| p.stdin.clone())
        .ok_or_else(|| "Serveur MCP arrêté ou introuvable.".to_string())?;
    let mut guard = stdin.lock().await;
    let pipe = guard
        .as_mut()
        .ok_or_else(|| "Connexion au serveur MCP fermée.".to_string())?;
    let mut data = line.replace(['\r', '\n'], " ").into_bytes();
    data.push(b'\n');
    pipe.write_all(&data)
        .await
        .map_err(|e| format!("Écriture vers le serveur MCP impossible : {e}"))?;
    pipe.flush()
        .await
        .map_err(|e| format!("Écriture vers le serveur MCP impossible : {e}"))?;
    Ok(())
}

/// Arrête un serveur MCP (fermeture de stdin, puis arrêt forcé de l'arbre de processus après 1,5 s).
#[tauri::command]
pub async fn mcp_kill(id: String) -> Result<(), String> {
    let proc = lock_procs().remove(&id);
    if let Some(mut p) = proc {
        if let Some(tx) = p.kill_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// Arrête tous les serveurs MCP (rechargement complet de la configuration).
#[tauri::command]
pub async fn mcp_kill_all() -> Result<(), String> {
    let drained: Vec<Proc> = lock_procs().drain().map(|(_, p)| p).collect();
    for mut p in drained {
        if let Some(tx) = p.kill_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

// ───────────────────────────── Configuration Claude Desktop ─────────────────────────────

fn desktop_config_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = dirs::config_dir() {
        // Windows : %APPDATA%\Claude ; macOS : ~/Library/Application Support/Claude ; Linux : ~/.config/Claude
        out.push(dir.join("Claude").join("claude_desktop_config.json"));
    }
    #[cfg(windows)]
    {
        // Version Microsoft Store (MSIX) de Claude Desktop : AppData virtualisé.
        if let Some(local) = dirs::data_local_dir() {
            if let Ok(entries) = std::fs::read_dir(local.join("Packages")) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                    if name.starts_with("claude_") || (name.starts_with("anthropic") && name.contains("claude")) {
                        out.push(
                            e.path()
                                .join("LocalCache")
                                .join("Roaming")
                                .join("Claude")
                                .join("claude_desktop_config.json"),
                        );
                    }
                }
            }
        }
    }
    out
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Lit `claude_desktop_config.json` de Claude Desktop. Renvoie le texte JSON, ou null s'il n'existe pas.
#[tauri::command]
pub async fn mcp_read_desktop_config() -> Result<Option<String>, String> {
    for path in desktop_config_candidates() {
        match tokio::fs::read(&path).await {
            Ok(bytes) => return Ok(Some(decode_text(&bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(format!(
                    "Impossible de lire la configuration de Claude Desktop ({}) : {e}",
                    path.display()
                ))
            }
        }
    }
    Ok(None)
}

/// Chemin de la configuration Claude Desktop utilisée (ou attendue si elle n'existe pas encore).
#[tauri::command]
pub fn mcp_desktop_config_path() -> Option<String> {
    let candidates = desktop_config_candidates();
    candidates
        .iter()
        .find(|p| p.is_file())
        .or_else(|| candidates.first())
        .map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echappe_les_arguments_cmd() {
        assert_eq!(escape_cmd_argument("abc", false), "^\"abc^\"");
        assert_eq!(escape_cmd_argument("a b", false), "^\"a^ b^\"");
        assert_eq!(escape_cmd_argument("a&b", false), "^\"a^&b^\"");
        assert_eq!(escape_cmd_argument("C:\\dir\\", false), "^\"C:\\dir\\\\^\"");
        assert_eq!(escape_cmd_argument("say \"hi\"", false), "^\"say^ \\^\"hi\\^\"^\"");
        assert_eq!(escape_cmd_command("npx"), "npx");
    }

    #[test]
    fn decode_bom_et_utf16() {
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'{', b'}']), "{}");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'{', 0, b'}', 0]), "{}");
        assert_eq!(decode_text(b"{\"a\":1}"), "{\"a\":1}");
    }
}
