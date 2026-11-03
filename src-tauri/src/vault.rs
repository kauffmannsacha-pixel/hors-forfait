// Module Rust « vault » — bibliothèque locale des fichiers épinglés dans les pages.
//
// - Copie dédupliquée par SHA-256 (calcul en streaming, une seule lecture du fichier) dans
//   <app_data_dir>/vault/<2 premiers hex>/<hash>.<ext>. Même contenu → même fichier.
// - Mode « lié » : le fichier reste à sa place, on ne calcule que son empreinte.
// - Surveillance des fichiers liés (crate notify) : émet `vault-changed` {path, kind, newPath?, size?}
//   quand un fichier lié est supprimé, renommé/déplacé ou modifié.
//
// Commandes à enregistrer dans lib.rs (generate_handler!) :
//   vault::vault_dir, vault::vault_import, vault::vault_import_bytes, vault::vault_check,
//   vault::vault_watch, vault::vault_read_text, vault::vault_read_bytes, vault::vault_remove,
//   vault::vault_key_state, vault::vault_open, vault::vault_reveal

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager};

const CHUNK: usize = 1 << 20; // 1 Mio par lecture
const PROGRESS_EVENT: &str = "vault-import-progress";
const CHANGED_EVENT: &str = "vault-changed";

/// Miroir de `VaultFile` (src/db/types.ts), sérialisé en camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub hash: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub path: String,
    pub linked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
    pub added_at: u64,
    /// Date de modification du fichier source (ms depuis l'epoch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    /// Chemin d'origine d'un fichier copié dans le vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    token: String,
    done: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    path: String,
    /// "removed" | "renamed" | "modified"
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_path: Option<String>,
    /// true si le nouveau chemin est déduit (même nom réapparu dans un autre dossier surveillé).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    guess: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<u64>,
}

#[derive(Serialize)]
pub struct KeyState {
    alt: bool,
    ctrl: bool,
    shift: bool,
    /// false hors Windows : le front se rabat sur l'état clavier du DOM.
    supported: bool,
}

// ───────────────────────── utilitaires ─────────────────────────

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path_string(p))
}

/// Nom de fichier sûr (sans dossier) pour un import d'octets.
fn clean_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if last.is_empty() { "fichier".to_string() } else { last.to_string() }
}

/// Extension sûre (alphanumérique, ≤ 16 caractères, minuscules).
fn clean_ext(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    if ext.is_empty() || ext.len() > 16 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext)
}

fn guess_mime(name: &str) -> String {
    mime_guess::from_path(name).first_raw().unwrap_or("application/octet-stream").to_string()
}

/// Clé de comparaison de chemins (insensible à la casse sous Windows).
fn key(p: &Path) -> String {
    let s = path_string(p);
    if cfg!(windows) { s.replace('/', "\\").to_lowercase() } else { s }
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Dossier de données de l'application introuvable : {e}"))?;
    let root = base.join("vault");
    fs::create_dir_all(&root).map_err(|e| format!("Impossible de créer le vault « {} » : {e}", root.display()))?;
    Ok(root)
}

/// Fichier déjà présent dans le vault pour ce hash (quelle que soit son extension).
fn find_existing(shard: &Path, hash: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(shard).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stem = name.split('.').next().unwrap_or("");
        if stem.eq_ignore_ascii_case(hash) && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

fn store_name(hash: &str, ext: Option<&str>) -> String {
    match ext {
        Some(e) => format!("{hash}.{e}"),
        None => hash.to_string(),
    }
}

fn tmp_path(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join(".tmp");
    fs::create_dir_all(&dir).map_err(|e| format!("Impossible de préparer le vault : {e}"))?;
    Ok(dir.join(format!("{}.part", uuid::Uuid::new_v4())))
}

/// Range un fichier temporaire (déjà haché) à sa place définitive. Déduplication : si le
/// contenu existe déjà, le temporaire est supprimé et le fichier existant est renvoyé.
fn place_in_vault(root: &Path, hash: &str, ext: Option<&str>, tmp: &Path) -> Result<PathBuf, String> {
    let shard = root.join(&hash[..2]);
    if let Err(e) = fs::create_dir_all(&shard) {
        let _ = fs::remove_file(tmp);
        return Err(format!("Impossible de créer « {} » : {e}", shard.display()));
    }
    if let Some(existing) = find_existing(&shard, hash) {
        let _ = fs::remove_file(tmp);
        return Ok(existing);
    }
    let dest = shard.join(store_name(hash, ext));
    match fs::rename(tmp, &dest) {
        Ok(()) => Ok(dest),
        Err(e) => {
            let _ = fs::remove_file(tmp);
            // Import concurrent du même contenu : le fichier est déjà là, c'est le même.
            if dest.is_file() { Ok(dest) } else { Err(format!("Impossible d'enregistrer le fichier dans le vault : {e}")) }
        }
    }
}

/// Supprime les copies interrompues (> 1 h) laissées dans <vault>/.tmp.
fn clean_tmp(root: &Path) {
    let Ok(rd) = fs::read_dir(root.join(".tmp")) else { return };
    for entry in rd.flatten() {
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map(|d| d > Duration::from_secs(3600))
            .unwrap_or(false);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Progression d'un import, émise au plus toutes les 120 ms (`vault-import-progress`).
struct Progress {
    emitter: Option<(AppHandle, String)>,
    total: u64,
    done: u64,
    last: Instant,
}

impl Progress {
    fn new(emitter: Option<(AppHandle, String)>, total: u64) -> Self {
        Self { emitter, total, done: 0, last: Instant::now() }
    }
    fn add(&mut self, n: usize) {
        self.done += n as u64;
        let Some((app, token)) = &self.emitter else { return };
        if self.last.elapsed() >= Duration::from_millis(120) || self.done >= self.total {
            self.last = Instant::now();
            let _ = app.emit(PROGRESS_EVENT, ProgressPayload { token: token.clone(), done: self.done, total: self.total });
        }
    }
}

/// Lit `input` jusqu'au bout en alimentant le hash (et la copie si `out` est fourni).
fn pump(input: &mut File, mut out: Option<&mut File>, hasher: &mut Sha256, progress: &mut Progress) -> std::io::Result<u64> {
    let mut buf = vec![0u8; CHUNK];
    let mut size = 0u64;
    loop {
        let n = match input.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
        if let Some(o) = out.as_deref_mut() {
            o.write_all(&buf[..n])?;
        }
        size += n as u64;
        progress.add(n);
    }
    Ok(size)
}

/// Importe un fichier du disque. `root` = dossier du vault (ignoré si `link`).
fn import_path_blocking(root: &Path, src: &Path, link: bool, progress: &mut Progress) -> Result<VaultFile, String> {
    let meta = fs::metadata(src).map_err(|e| format!("Fichier introuvable ou inaccessible « {} » : {e}", src.display()))?;
    let name = display_name(src);
    if meta.is_dir() {
        return Err(format!("« {name} » est un dossier : seuls les fichiers peuvent être épinglés."));
    }
    let mime = guess_mime(&name);
    let mut input = File::open(src).map_err(|e| format!("Lecture impossible de « {name} » : {e}"))?;
    let mut hasher = Sha256::new();
    progress.total = meta.len();

    if link {
        let size = pump(&mut input, None, &mut hasher, progress).map_err(|e| format!("Lecture impossible de « {name} » : {e}"))?;
        return Ok(VaultFile {
            hash: hex::encode(hasher.finalize()),
            name,
            mime,
            size,
            path: path_string(&absolute(src)),
            linked: true,
            missing: None,
            added_at: now_ms(),
            modified_at: mtime_ms(&meta),
            original_path: None,
        });
    }

    let tmp = tmp_path(root)?;
    let copied = File::create(&tmp)
        .and_then(|mut out| {
            let size = pump(&mut input, Some(&mut out), &mut hasher, progress)?;
            out.sync_all()?;
            Ok(size)
        });
    let size = match copied {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Copie impossible de « {name} » dans le vault : {e}"));
        }
    };
    let hash = hex::encode(hasher.finalize());
    let dest = place_in_vault(root, &hash, clean_ext(&name).as_deref(), &tmp)?;
    Ok(VaultFile {
        hash,
        name,
        mime,
        size,
        path: path_string(&dest),
        linked: false,
        missing: None,
        added_at: now_ms(),
        modified_at: mtime_ms(&meta),
        original_path: Some(path_string(&absolute(src))),
    })
}

fn import_bytes_blocking(root: &Path, name: String, mime: String, bytes: Vec<u8>) -> Result<VaultFile, String> {
    let name = clean_name(&name);
    let mime = {
        let m = mime.trim().to_ascii_lowercase();
        if m.is_empty() || m == "application/octet-stream" { guess_mime(&name) } else { m }
    };
    let hash = hex::encode(Sha256::digest(&bytes));
    let shard = root.join(&hash[..2]);
    let path = match find_existing(&shard, &hash) {
        Some(existing) => existing,
        None => {
            let ext = clean_ext(&name).or_else(|| {
                mime_guess::get_mime_extensions_str(&mime).and_then(|v| v.first()).map(|e| e.to_string())
            });
            let tmp = tmp_path(root)?;
            let written = File::create(&tmp).and_then(|mut f| {
                f.write_all(&bytes)?;
                f.sync_all()
            });
            if let Err(e) = written {
                let _ = fs::remove_file(&tmp);
                return Err(format!("Écriture impossible de « {name} » dans le vault : {e}"));
            }
            place_in_vault(root, &hash, ext.as_deref(), &tmp)?
        }
    };
    Ok(VaultFile {
        hash,
        name,
        mime,
        size: bytes.len() as u64,
        path: path_string(&path),
        linked: false,
        missing: None,
        added_at: now_ms(),
        modified_at: Some(now_ms()),
        original_path: None,
    })
}

/// Décode les en-têtes `%XX` (noms de fichiers non ASCII transmis en en-tête HTTP).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Windows-1252 (fichiers texte « ANSI » courants sous Windows).
fn decode_cp1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char })
        .collect()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|c| if little_endian { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) });
    char::decode_utf16(units).map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
}

/// `truncated` : la lecture a été coupée à la limite (un caractère multi-octets peut être incomplet à la fin).
fn decode_text(bytes: &[u8], truncated: bool) -> Result<String, String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok(decode_utf16(&bytes[2..], true));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok(decode_utf16(&bytes[2..], false));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    if body[..body.len().min(8192)].contains(&0) {
        return Err("Fichier binaire : aucun aperçu texte disponible.".into());
    }
    match std::str::from_utf8(body) {
        Ok(s) => Ok(s.to_string()),
        // Coupure au milieu d'un caractère multi-octets (lecture tronquée) : on garde la partie valide.
        Err(e) if e.error_len().is_none() && truncated => Ok(String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned()),
        Err(_) => Ok(decode_cp1252(body)),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("Tâche interrompue : {e}"))?
}

// ───────────────────────── commandes ─────────────────────────

/// Dossier du vault (créé au besoin). Nettoie au passage les copies interrompues.
#[tauri::command]
pub async fn vault_dir(app: AppHandle) -> Result<String, String> {
    blocking(move || {
        let root = vault_root(&app)?;
        clean_tmp(&root);
        Ok(path_string(&root))
    })
    .await
}

/// Importe un fichier du disque : copie dédupliquée dans le vault, ou simple lien (`link`).
/// `token` (optionnel) : identifiant des événements `vault-import-progress` {token, done, total}.
#[tauri::command]
pub async fn vault_import(app: AppHandle, path: String, link: bool, token: Option<String>) -> Result<VaultFile, String> {
    blocking(move || {
        let root = if link { PathBuf::new() } else { vault_root(&app)? };
        let mut progress = Progress::new(token.map(|t| (app.clone(), t)), 0);
        import_path_blocking(&root, Path::new(&path), link, &mut progress)
    })
    .await
}

#[derive(Deserialize)]
struct BytesArgs {
    name: String,
    #[serde(default)]
    mime: String,
    bytes: Vec<u8>,
}

/// Importe des octets (presse-papiers, pièce jointe, image générée…).
/// Deux formes d'appel : JSON `{name, mime, bytes: number[]}` (signature `name, mime, bytes: Vec<u8>`),
/// ou corps binaire brut (Uint8Array) avec les en-têtes `x-vault-name` / `x-vault-mime` encodés en %XX
/// — bien plus rapide pour les gros fichiers.
#[tauri::command]
pub async fn vault_import_bytes(app: AppHandle, request: Request<'_>) -> Result<VaultFile, String> {
    let (name, mime, bytes) = match request.body() {
        InvokeBody::Raw(bytes) => {
            let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
            (header("x-vault-name"), header("x-vault-mime"), bytes.clone())
        }
        InvokeBody::Json(v) => {
            let a: BytesArgs = serde_json::from_value(v.clone()).map_err(|e| format!("Arguments invalides pour l'import : {e}"))?;
            (a.name, a.mime, a.bytes)
        }
    };
    blocking(move || import_bytes_blocking(&vault_root(&app)?, name, mime, bytes)).await
}

/// Renvoie les chemins (fichiers liés) introuvables.
#[tauri::command]
pub async fn vault_check(paths: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || Ok(paths.into_iter().filter(|p| !Path::new(p).is_file()).collect())).await
}

/// Début d'un fichier texte (extrait de code), décodé UTF-8 / UTF-16 / Windows-1252.
#[tauri::command]
pub async fn vault_read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let max = max_bytes.unwrap_or(64 * 1024).clamp(1, 8 * 1024 * 1024);
    blocking(move || {
        let f = File::open(&path).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
        let mut buf = Vec::new();
        f.take(max).read_to_end(&mut buf).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
        decode_text(&buf, buf.len() as u64 >= max)
    })
    .await
}

/// Octets bruts d'un fichier (ex. miniature intégrée d'un .psd), renvoyés en binaire (ArrayBuffer).
#[tauri::command]
pub async fn vault_read_bytes(path: String, offset: Option<u64>, length: Option<u64>) -> Result<Response, String> {
    let offset = offset.unwrap_or(0);
    let length = length.unwrap_or(1 << 20).min(64 << 20);
    let data = blocking(move || {
        let mut f = File::open(&path).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
        let mut buf = Vec::new();
        f.take(length).read_to_end(&mut buf).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
        Ok(buf)
    })
    .await?;
    Ok(Response::new(data))
}

/// Supprime une copie du vault. Refuse tout fichier situé hors du vault (un fichier lié n'est jamais touché).
#[tauri::command]
pub async fn vault_remove(app: AppHandle, path: String) -> Result<bool, String> {
    blocking(move || {
        let root = fs::canonicalize(vault_root(&app)?).map_err(|e| format!("Vault inaccessible : {e}"))?;
        let target = match fs::canonicalize(&path) {
            Ok(p) => p,
            Err(_) => return Ok(false), // déjà absent
        };
        if !target.starts_with(&root) || !target.is_file() || target.starts_with(root.join(".tmp")) {
            return Err("Refusé : seuls les fichiers copiés dans le vault peuvent être supprimés.".into());
        }
        fs::remove_file(&target).map_err(|e| format!("Suppression impossible : {e}"))?;
        if let Some(parent) = target.parent() {
            if parent != root.as_path() {
                let _ = fs::remove_dir(parent); // seulement s'il est vide
            }
        }
        Ok(true)
    })
    .await
}

#[cfg(windows)]
mod keys {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    /// Bit de poids fort = touche enfoncée en ce moment (même pendant un glisser-déposer système).
    pub fn is_down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }
}

/// État physique des touches de modification. Sert à détecter Alt pendant un dépôt de fichiers
/// depuis l'explorateur (la webview ne reçoit pas les événements clavier pendant le glisser).
#[tauri::command]
pub fn vault_key_state() -> KeyState {
    #[cfg(windows)]
    {
        KeyState { alt: keys::is_down(0x12), ctrl: keys::is_down(0x11), shift: keys::is_down(0x10), supported: true }
    }
    #[cfg(not(windows))]
    {
        KeyState { alt: false, ctrl: false, shift: false, supported: false }
    }
}

/// Ouvre le fichier avec l'application par défaut du système (repli si le plugin opener n'est pas autorisé).
#[tauri::command]
pub async fn vault_open(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Fichier introuvable : {path}"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| format!("Impossible d'ouvrir le fichier : {e}"))
}

/// Affiche le fichier sélectionné dans l'explorateur.
#[tauri::command]
pub async fn vault_reveal(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Fichier introuvable : {path}"));
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("Impossible d'afficher le fichier dans l'explorateur : {e}"))
}

// ───────────────────────── surveillance des fichiers liés ─────────────────────────

type WatchedFiles = Arc<Mutex<HashMap<String, PathBuf>>>;

struct WatchState {
    watcher: RecommendedWatcher,
    dirs: HashSet<PathBuf>,
    files: WatchedFiles,
}

static WATCH: Mutex<Option<WatchState>> = Mutex::new(None);

/// Analyse un lot d'événements bruts et signale l'état final de chaque fichier lié concerné.
fn process_batch(files: &WatchedFiles, batch: Vec<Event>, emit_changed: &mut dyn FnMut(ChangedPayload)) {
    let mut renames: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut appeared: Vec<PathBuf> = Vec::new();
    let mut touched: Vec<PathBuf> = Vec::new();
    let mut rename_from: Option<PathBuf> = None;
    for ev in batch {
        match ev.kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if ev.paths.len() >= 2 => {
                renames.push((ev.paths[0].clone(), ev.paths[1].clone()));
                appeared.push(ev.paths[1].clone());
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                rename_from = ev.paths.first().cloned();
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                if let Some(to) = ev.paths.first() {
                    if let Some(from) = rename_from.take() {
                        renames.push((from, to.clone()));
                    }
                    appeared.push(to.clone());
                }
            }
            EventKind::Create(_) => appeared.extend(ev.paths.iter().cloned()),
            _ => {}
        }
        touched.extend(ev.paths);
    }

    let Ok(mut map) = files.lock() else { return };
    let mut seen = HashSet::new();
    for p in touched {
        let k = key(&p);
        if !seen.insert(k.clone()) {
            continue;
        }
        let Some(watched) = map.get(&k).cloned() else { continue };
        if let Ok(meta) = fs::metadata(&watched) {
            if meta.is_file() {
                emit_changed(ChangedPayload {
                    path: path_string(&watched),
                    kind: "modified",
                    new_path: None,
                    guess: false,
                    size: Some(meta.len()),
                    modified_at: mtime_ms(&meta),
                });
                continue;
            }
        }
        // Le fichier a disparu : renommé sur place, déplacé vers un autre dossier surveillé, ou supprimé.
        let renamed = renames.iter().rev().find(|(from, to)| key(from) == k && to.is_file()).map(|(_, to)| (to.clone(), false));
        let moved = || {
            let name = key(Path::new(watched.file_name()?));
            appeared
                .iter()
                .find(|c| {
                    let ck = key(c);
                    ck != k && !map.contains_key(&ck) && c.file_name().map(|n| key(Path::new(n)) == name).unwrap_or(false) && c.is_file()
                })
                .map(|c| (c.clone(), true))
        };
        match renamed.or_else(moved) {
            Some((new_path, guess)) => {
                let meta = fs::metadata(&new_path).ok();
                map.remove(&k);
                map.insert(key(&new_path), new_path.clone());
                seen.insert(key(&new_path)); // déjà signalé : pas de « modified » en double
                emit_changed(ChangedPayload {
                    path: path_string(&watched),
                    kind: "renamed",
                    new_path: Some(path_string(&new_path)),
                    guess,
                    size: meta.as_ref().map(|m| m.len()),
                    modified_at: meta.as_ref().and_then(mtime_ms),
                });
            }
            None => emit_changed(ChangedPayload {
                path: path_string(&watched),
                kind: "removed",
                new_path: None,
                guess: false,
                size: None,
                modified_at: None,
            }),
        }
    }
}

/// Regroupe les événements bruts (rafales d'écriture, renommage en deux temps sous Windows…)
/// et les traite après 400 ms de calme (ou au plus tard toutes les 2 s).
fn spawn_worker(app: AppHandle, files: WatchedFiles, rx: Receiver<notify::Result<Event>>) {
    let _ = std::thread::Builder::new().name("prisme-vault-watch".into()).spawn(move || {
        let mut pending: Vec<Event> = Vec::new();
        let mut since: Option<Instant> = None;
        loop {
            let wait = if pending.is_empty() { Duration::from_secs(3600) } else { Duration::from_millis(400) };
            match rx.recv_timeout(wait) {
                Ok(Ok(ev)) => {
                    pending.push(ev);
                    let start = *since.get_or_insert_with(Instant::now);
                    if start.elapsed() < Duration::from_secs(2) {
                        continue;
                    }
                }
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !pending.is_empty() {
                since = None;
                process_batch(&files, std::mem::take(&mut pending), &mut |payload| {
                    let _ = app.emit(CHANGED_EVENT, payload);
                });
            }
        }
    });
}

fn configure_watch(app: &AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let mut guard = WATCH.lock().map_err(|_| "Surveillance des fichiers indisponible.".to_string())?;
    if guard.is_none() {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let watcher = notify::recommended_watcher(tx).map_err(|e| format!("Surveillance des fichiers liés impossible : {e}"))?;
        let files: WatchedFiles = Arc::new(Mutex::new(HashMap::new()));
        spawn_worker(app.clone(), files.clone(), rx);
        *guard = Some(WatchState { watcher, dirs: HashSet::new(), files });
    }
    let Some(state) = guard.as_mut() else { return Ok(0) };

    let mut wanted_files = HashMap::new();
    let mut wanted_dirs = HashSet::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        if let Some(dir) = pb.parent() {
            if dir.is_dir() {
                wanted_dirs.insert(dir.to_path_buf());
            }
        }
        wanted_files.insert(key(&pb), pb);
    }
    // On surveille les dossiers parents (non récursif) : un fichier renommé ou recréé reste visible.
    for d in state.dirs.difference(&wanted_dirs).cloned().collect::<Vec<_>>() {
        let _ = state.watcher.unwatch(&d);
        state.dirs.remove(&d);
    }
    for d in wanted_dirs {
        if !state.dirs.contains(&d) && state.watcher.watch(&d, RecursiveMode::NonRecursive).is_ok() {
            state.dirs.insert(d);
        }
    }
    if let Ok(mut f) = state.files.lock() {
        *f = wanted_files;
    }
    Ok(state.dirs.len())
}

/// Surveille les fichiers liés (remplace la liste précédente). Renvoie le nombre de dossiers surveillés.
#[tauri::command]
pub async fn vault_watch(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    blocking(move || configure_watch(&app, paths)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vérifie que toutes les commandes s'enregistrent comme dans lib.rs.
    #[allow(dead_code)]
    fn registration_compiles() -> Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> {
        Box::new(tauri::generate_handler![
            vault_dir,
            vault_import,
            vault_import_bytes,
            vault_check,
            vault_watch,
            vault_read_text,
            vault_read_bytes,
            vault_remove,
            vault_key_state,
            vault_open,
            vault_reveal
        ])
    }

    #[test]
    fn decodes_text_variants() {
        assert_eq!(decode_text("héllo".as_bytes(), false).unwrap(), "héllo");
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'a'], false).unwrap(), "a");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'a', 0, b'b', 0], false).unwrap(), "ab");
        assert_eq!(decode_text(&[b'c', b'a', b'f', 0xE9], false).unwrap(), "café"); // Windows-1252
        assert_eq!(decode_text(&[b'c', 0x92, b'e', b's', b't'], false).unwrap(), "c’est");
        let mut cut = "é".as_bytes().to_vec();
        cut.insert(0, b'x');
        cut.pop();
        assert_eq!(decode_text(&cut, true).unwrap(), "x"); // coupure au milieu de « é »
        assert!(decode_text(&[1, 0, 2], false).is_err());
    }

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("prisme-vault-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn import_dedupes_by_hash() {
        let base = temp_dir();
        let root = base.join("vault");
        fs::create_dir_all(&root).unwrap();
        let a = base.join("Script Final.LUA");
        let b = base.join("copie.lua");
        fs::write(&a, b"abc").unwrap();
        fs::write(&b, b"abc").unwrap();
        const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

        let first = import_path_blocking(&root, &a, false, &mut Progress::new(None, 0)).unwrap();
        assert_eq!(first.hash, ABC);
        assert_eq!(first.name, "Script Final.LUA");
        assert_eq!(first.size, 3);
        assert!(!first.linked);
        assert_eq!(PathBuf::from(&first.path), root.join("ba").join(format!("{ABC}.lua")));
        assert_eq!(first.original_path.as_deref(), Some(path_string(&a).as_str()));

        // Même contenu (autre nom) → même fichier dans le vault, pas de seconde copie.
        let second = import_path_blocking(&root, &b, false, &mut Progress::new(None, 0)).unwrap();
        assert_eq!(second.path, first.path);
        assert_eq!(fs::read_dir(root.join("ba")).unwrap().count(), 1);
        // Les copies temporaires ont été rangées ou supprimées.
        assert_eq!(fs::read_dir(root.join(".tmp")).unwrap().count(), 0);

        // Octets identiques → même fichier.
        let bytes = import_bytes_blocking(&root, "C:\\x\\collé.png".into(), "image/png".into(), b"abc".to_vec()).unwrap();
        assert_eq!(bytes.path, first.path);
        assert_eq!(bytes.name, "collé.png");
        assert_eq!(bytes.mime, "image/png");

        // Lien : aucun fichier écrit, chemin d'origine conservé.
        let linked = import_path_blocking(Path::new(""), &a, true, &mut Progress::new(None, 0)).unwrap();
        assert!(linked.linked);
        assert_eq!(linked.hash, ABC);
        assert_eq!(PathBuf::from(&linked.path), a);

        // Nouveau contenu sans extension → déduite du type MIME.
        let other = import_bytes_blocking(&root, "capture".into(), "image/png".into(), vec![1, 2, 3]).unwrap();
        assert!(other.path.ends_with(".png"), "{}", other.path);

        // Un dossier est refusé.
        assert!(import_path_blocking(&root, &base, false, &mut Progress::new(None, 0)).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    fn watched(paths: &[&Path]) -> WatchedFiles {
        Arc::new(Mutex::new(paths.iter().map(|p| (key(p), p.to_path_buf())).collect()))
    }

    fn run(files: &WatchedFiles, events: Vec<Event>) -> Vec<ChangedPayload> {
        let mut out = Vec::new();
        process_batch(files, events, &mut |p| out.push(p));
        out
    }

    #[test]
    fn watcher_detects_rename_move_remove_and_modify() {
        let base = temp_dir();
        let (d1, d2) = (base.join("projet"), base.join("archives"));
        fs::create_dir_all(&d1).unwrap();
        fs::create_dir_all(&d2).unwrap();
        let (a, b, c) = (d1.join("miniature.psd"), d1.join("script.lua"), d2.join("autre.txt"));
        for p in [&a, &b, &c] {
            fs::write(p, b"x").unwrap();
        }
        let files = watched(&[&a, &b, &c]);

        // Renommage sur place (Windows : deux événements From puis To).
        let a2 = d1.join("miniature v2.psd");
        fs::rename(&a, &a2).unwrap();
        let out = run(&files, vec![
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(a.clone()),
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(a2.clone()),
        ]);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].kind, "renamed");
        assert_eq!(out[0].new_path.as_deref(), Some(path_string(&a2).as_str()));
        assert!(!out[0].guess);
        assert!(files.lock().unwrap().contains_key(&key(&a2)));

        // Déplacement vers un autre dossier surveillé : même nom réapparu → déduit (guess).
        let b2 = d2.join("script.lua");
        fs::rename(&b, &b2).unwrap();
        let out = run(&files, vec![
            Event::new(EventKind::Remove(notify::event::RemoveKind::Any)).add_path(b.clone()),
            Event::new(EventKind::Create(notify::event::CreateKind::Any)).add_path(b2.clone()),
        ]);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].kind, "renamed");
        assert!(out[0].guess);
        assert_eq!(out[0].new_path.as_deref(), Some(path_string(&b2).as_str()));

        // Modification : le fichier existe toujours.
        fs::write(&c, b"plus long").unwrap();
        let out = run(&files, vec![Event::new(EventKind::Modify(ModifyKind::Any)).add_path(c.clone())]);
        assert_eq!(out[0].kind, "modified");
        assert_eq!(out[0].size, Some(9));

        // Suppression.
        fs::remove_file(&c).unwrap();
        let out = run(&files, vec![Event::new(EventKind::Remove(notify::event::RemoveKind::Any)).add_path(c.clone())]);
        assert_eq!(out[0].kind, "removed");

        // Fichier non surveillé : ignoré.
        let out = run(&files, vec![Event::new(EventKind::Create(notify::event::CreateKind::Any)).add_path(d1.join("x.tmp"))]);
        assert!(out.is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("caf%C3%A9%20v2.png"), "café v2.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn names_and_extensions() {
        assert_eq!(clean_name("C:\\x\\y\\Rapport.PDF"), "Rapport.PDF");
        assert_eq!(clean_name("  "), "fichier");
        assert_eq!(clean_ext("Rapport.PDF").as_deref(), Some("pdf"));
        assert_eq!(clean_ext("script.lua").as_deref(), Some("lua"));
        assert_eq!(clean_ext("sans_extension"), None);
        assert_eq!(clean_ext("bizarre.ex t"), None);
        assert_eq!(store_name("abc", Some("psd")), "abc.psd");
        assert_eq!(store_name("abc", None), "abc");
    }
}
