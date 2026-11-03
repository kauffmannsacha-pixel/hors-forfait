// Module Rust « upload » — mise en ligne YouTube reprenable (YouTube Data API v3, protocole « resumable »),
// miniatures (thumbnails.set), sous-titres (captions.insert) et infos d'un fichier vidéo (taille, durée, dimensions MP4/MOV).
//
// Commandes à enregistrer dans lib.rs :
//   upload::yt_upload_init, upload::yt_upload_chunk, upload::yt_upload_status, upload::yt_upload_cancel,
//   upload::yt_file_info, upload::yt_thumbnail_set, upload::yt_caption_insert
// Événement émis pendant l'envoi d'un morceau : « yt-upload-progress » { uploadUrl, offset, sent, len, total }.
//
// Protocole (developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) :
//   1. POST …/upload/youtube/v3/videos?uploadType=resumable&part=… (X-Upload-Content-Length / -Type) → Location = URL de session
//   2. PUT URL de session, Content-Range: bytes DEBUT-FIN/TOTAL (morceaux multiples de 256 Kio sauf le dernier)
//      → 308 + Range (incomplet) | 200/201 + ressource vidéo (terminé) | 5xx (réessayer) | 404 (session expirée)
//   3. Reprise : PUT vide avec Content-Range: bytes */TOTAL → 308 + Range indique ce que le serveur a reçu.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{ErrorKind, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const VIDEOS_UPLOAD: &str = "https://www.googleapis.com/upload/youtube/v3/videos";
const THUMBNAILS_UPLOAD: &str = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const CAPTIONS_UPLOAD: &str = "https://www.googleapis.com/upload/youtube/v3/captions";
const QUANTUM: u64 = 256 * 1024;
const MAX_CHUNK: u64 = 256 * 1024 * 1024;
const MAX_VIDEO: u64 = 256 * 1024 * 1024 * 1024;
const PROGRESS_EVENT: &str = "yt-upload-progress";
const ALLOWED_PARTS: [&str; 5] = ["snippet", "status", "recordingDetails", "localizations", "paidProductPlacementDetails"];

// ── Types renvoyés au front ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadInit {
    upload_url: String,
    total: u64,
    mime: String,
}

/// Résultat d'un PUT (morceau ou demande d'état).
/// status : "incomplete" | "complete" | "expired" | "retry" | "unauthorized" | "cancelled"
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UploadStep {
    status: &'static str,
    next_offset: u64,
    video_id: Option<String>,
    http_status: u16,
    retry_after: Option<u64>,
    message: Option<String>,
    upload_status: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    upload_url: String,
    offset: u64,
    sent: u64,
    len: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    name: String,
    size: u64,
    mime: String,
    duration_sec: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

// ── Outils ──────────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    // Pas de redirection automatique : un 308 « Resume Incomplete » n'est PAS une redirection.
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .user_agent("Prisme/0.1 (mise en ligne YouTube)")
        .build()
        .map_err(|e| format!("Client HTTP indisponible : {e}"))?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}
fn is_cancelled(url: &str) -> bool {
    cancelled().lock().map(|s| s.contains(url)).unwrap_or(false)
}
fn clear_cancel(url: &str) {
    if let Ok(mut s) = cancelled().lock() {
        s.remove(url);
    }
}

fn video_mime(path: &str) -> String {
    match mime_guess::from_path(path).first_raw() {
        Some(m) if m.starts_with("video/") => m.to_string(),
        _ => "application/octet-stream".into(),
    }
}

fn image_mime(path: &str, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    match mime_guess::from_path(path).first_raw() {
        Some("image/png") => "image/png",
        Some("image/jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn file_error(path: &str, e: std::io::Error) -> String {
    match e.kind() {
        ErrorKind::NotFound => format!("Fichier introuvable : {path} (déplacé ou supprimé ?)"),
        ErrorKind::PermissionDenied => format!("Accès refusé au fichier : {path}"),
        ErrorKind::UnexpectedEof => format!("Fichier tronqué ou modifié pendant l'envoi : {path}"),
        _ => format!("Lecture impossible de {path} : {e}"),
    }
}

fn net_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Délai dépassé : la connexion à YouTube est trop lente ou a été coupée.".into()
    } else if e.is_connect() {
        "Connexion à YouTube impossible (hors ligne ?).".into()
    } else {
        format!("Erreur réseau : {e}")
    }
}

fn check_upload_url(url: &str) -> Result<(), String> {
    // Le jeton OAuth n'est envoyé qu'aux serveurs d'envoi de Google.
    if url.starts_with("https://www.googleapis.com/upload/") || url.starts_with("https://youtube.googleapis.com/upload/") {
        Ok(())
    } else {
        Err("Adresse de session d'envoi invalide.".into())
    }
}

fn check_video_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err(format!("Identifiant de vidéo invalide : {id}"))
    }
}

/// « bytes DEBUT-FIN/TOTAL »
fn content_range(offset: u64, len: u64, total: u64) -> String {
    format!("bytes {}-{}/{}", offset, offset + len - 1, total)
}

/// En-tête Range d'une réponse 308 (« bytes=0-999999 ») → prochaine position (1000000). Absent → 0.
fn next_offset_from_range(range: Option<&str>) -> u64 {
    range
        .and_then(|r| r.rsplit('-').next())
        .and_then(|last| last.trim().parse::<u64>().ok())
        .map(|last| last + 1)
        .unwrap_or(0)
}

/// Délai d'un PUT de morceau : 2 min + 1 s par 8 Kio (connexions très lentes).
fn chunk_timeout(len: u64) -> Duration {
    Duration::from_secs(120 + len / 8192)
}

/// Message d'erreur Google (JSON « error.errors[0].reason ») traduit en français.
fn google_error(service: &str, status: u16, body: &str) -> String {
    let v: Option<Value> = serde_json::from_str(body).ok();
    let reason = v
        .as_ref()
        .and_then(|v| v.pointer("/error/errors/0/reason").or_else(|| v.pointer("/error/status")))
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let google_msg = v
        .as_ref()
        .and_then(|v| v.pointer("/error/message"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let fr: &str = match reason.as_str() {
        "quotaExceeded" | "dailyLimitExceeded" => "quota YouTube du jour épuisé — réessaie après minuit (heure du Pacifique)",
        "uploadLimitExceeded" => "limite d'envois atteinte pour cette chaîne — réessaie plus tard",
        "rateLimitExceeded" | "userRateLimitExceeded" | "uploadRateLimitExceeded" | "RESOURCE_EXHAUSTED" => "trop de requêtes en peu de temps — réessaie dans quelques minutes",
        "youtubeSignupRequired" => "ce compte Google n'a pas encore de chaîne YouTube",
        "insufficientPermissions" | "PERMISSION_DENIED" => "autorisation insuffisante — reconnecte la chaîne en acceptant la gestion des vidéos (youtube.upload / youtube.force-ssl)",
        "forbidden" => "action refusée par YouTube pour cette chaîne",
        "authError" | "UNAUTHENTICATED" => "jeton expiré ou révoqué — reconnecte la chaîne",
        "invalidTitle" => "titre refusé (vide, plus de 100 caractères ou contenant < >)",
        "invalidDescription" => "description refusée (plus de 5 000 octets ou contenant < >)",
        "invalidTags" => "tags refusés (500 caractères maximum au total)",
        "invalidCategoryId" => "catégorie invalide",
        "invalidPublishAt" => "date de programmation invalide (elle doit être dans le futur, vidéo privée)",
        "invalidRecordingDetails" => "date d'enregistrement invalide",
        "invalidVideoMetadata" | "invalidMetadata" => "métadonnées invalides",
        "defaultLanguageNotSet" => "langue par défaut manquante",
        "invalidFilename" => "nom de fichier refusé",
        "mediaBodyRequired" => "contenu du fichier manquant",
        "invalidImage" => "image refusée (JPEG ou PNG, 2 Mo maximum)",
        "mediaBodyTooLarge" => "fichier trop volumineux",
        "videoNotFound" => "vidéo introuvable (encore en traitement ou supprimée)",
        "contentRequired" => "fichier de sous-titres vide",
        "captionExists" | "nameAlreadyExists" => "une piste de sous-titres porte déjà ce nom et cette langue",
        "invalidCaptionTrack" | "invalidCaptionFormat" | "invalidValue" => "fichier de sous-titres illisible (format .srt attendu)",
        "playlistNotFound" => "playlist introuvable",
        "videoAlreadyInPlaylist" => "la vidéo est déjà dans cette playlist",
        "manualSortRequired" => "la playlist doit être triée manuellement pour choisir une position",
        _ => "",
    };
    let generic = match status {
        400 => "requête refusée",
        401 => "authentification refusée (jeton expiré — reconnecte la chaîne)",
        403 => "accès refusé",
        404 => "ressource introuvable",
        409 => "conflit",
        413 => "fichier trop volumineux",
        429 => "trop de requêtes, réessaie dans un instant",
        500..=599 => "service YouTube momentanément indisponible",
        _ => "erreur inattendue",
    };
    let main = if fr.is_empty() { generic } else { fr };
    let detail = if google_msg.is_empty() || !fr.is_empty() && google_msg.len() > 160 {
        String::new()
    } else {
        format!(" ({})", google_msg.chars().take(200).collect::<String>())
    };
    format!("{service} : {main}{detail} [HTTP {status}]")
}

async fn read_range(path: &str, offset: u64, len: u64, total: u64) -> Result<Vec<u8>, String> {
    let mut f = tokio::fs::File::open(path).await.map_err(|e| file_error(path, e))?;
    let size = f.metadata().await.map_err(|e| file_error(path, e))?.len();
    if size != total {
        return Err("Le fichier vidéo a changé depuis le début de l'envoi (taille différente) : relance l'envoi depuis le début.".into());
    }
    f.seek(SeekFrom::Start(offset)).await.map_err(|e| file_error(path, e))?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).await.map_err(|e| file_error(path, e))?;
    Ok(buf)
}

/// Interprète la réponse d'un PUT de session (morceau ou demande d'état).
async fn interpret(res: reqwest::Response, offset: u64, total: u64) -> Result<UploadStep, String> {
    let status = res.status().as_u16();
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let retry_after = header("retry-after").and_then(|s| s.trim().parse::<u64>().ok());
    match status {
        308 => Ok(UploadStep {
            status: "incomplete",
            next_offset: next_offset_from_range(header("range").as_deref()),
            http_status: 308,
            retry_after,
            ..Default::default()
        }),
        200 | 201 => {
            let body = res.text().await.unwrap_or_default();
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let video_id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
            let upload_status = v.pointer("/status/uploadStatus").and_then(|x| x.as_str()).map(|s| s.to_string());
            let reason = v
                .pointer("/status/rejectionReason")
                .or_else(|| v.pointer("/status/failureReason"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let message = match (upload_status.as_deref(), reason.as_deref()) {
                (Some("rejected"), r) => Some(format!("YouTube a refusé la vidéo{}", r.map(|r| format!(" (motif : {r})")).unwrap_or_default())),
                (Some("failed"), r) => Some(format!("Le traitement YouTube a échoué{}", r.map(|r| format!(" (motif : {r})")).unwrap_or_default())),
                _ => None,
            };
            if video_id.is_none() {
                return Err("YouTube a terminé l'envoi sans renvoyer d'identifiant de vidéo.".into());
            }
            Ok(UploadStep { status: "complete", next_offset: total, video_id, http_status: status, retry_after, message, upload_status })
        }
        404 | 410 => Ok(UploadStep {
            status: "expired",
            next_offset: 0,
            http_status: status,
            message: Some("La session d'envoi a expiré : l'envoi repart du début.".into()),
            ..Default::default()
        }),
        401 => Ok(UploadStep { status: "unauthorized", next_offset: offset, http_status: 401, ..Default::default() }),
        429 | 500 | 502 | 503 | 504 => Ok(UploadStep {
            status: "retry",
            next_offset: offset,
            http_status: status,
            retry_after,
            message: Some(format!("YouTube momentanément indisponible (HTTP {status}), nouvelle tentative…")),
            ..Default::default()
        }),
        _ => {
            let body = res.text().await.unwrap_or_default();
            Err(google_error("Mise en ligne YouTube", status, &body))
        }
    }
}

// ── Commandes ───────────────────────────────────────────────────────────

/// Ouvre une session d'envoi reprenable. `metadata_json` = ressource vidéo { snippet, status, recordingDetails? }.
#[tauri::command]
pub async fn yt_upload_init(path: String, metadata_json: String, token: String, notify_subscribers: bool) -> Result<UploadInit, String> {
    let meta: Value = serde_json::from_str(&metadata_json).map_err(|e| format!("Métadonnées illisibles : {e}"))?;
    let obj = meta.as_object().ok_or("Métadonnées : objet JSON attendu.")?;
    let parts: Vec<&str> = ALLOWED_PARTS.iter().copied().filter(|p| obj.contains_key(*p)).collect();
    if !parts.contains(&"snippet") {
        return Err("Métadonnées : la partie « snippet » (titre, description…) est obligatoire.".into());
    }
    let total = tokio::fs::metadata(&path).await.map_err(|e| file_error(&path, e))?.len();
    if total == 0 {
        return Err("Le fichier vidéo est vide.".into());
    }
    if total > MAX_VIDEO {
        return Err("Le fichier dépasse la taille maximale acceptée par YouTube (256 Go).".into());
    }
    let mime = video_mime(&path);
    let url = format!(
        "{VIDEOS_UPLOAD}?uploadType=resumable&part={}&notifySubscribers={}",
        parts.join("%2C"),
        if notify_subscribers { "true" } else { "false" }
    );
    let res = client()?
        .post(url)
        .bearer_auth(&token)
        .header("Content-Type", "application/json; charset=UTF-8")
        .header("X-Upload-Content-Length", total.to_string())
        .header("X-Upload-Content-Type", mime.clone())
        .timeout(Duration::from_secs(90))
        .body(metadata_json)
        .send()
        .await
        .map_err(|e| net_error(&e))?;
    let status = res.status().as_u16();
    if status == 200 || status == 201 {
        let location = res.headers().get("location").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        return match location {
            Some(upload_url) => Ok(UploadInit { upload_url, total, mime }),
            None => Err("YouTube n'a pas renvoyé d'adresse de session (en-tête Location manquant).".into()),
        };
    }
    let body = res.text().await.unwrap_or_default();
    Err(google_error("Mise en ligne YouTube", status, &body))
}

/// Envoie la plage [offset, offset+len) du fichier (PUT + Content-Range). Émet « yt-upload-progress ».
#[tauri::command]
pub async fn yt_upload_chunk(app: AppHandle, upload_url: String, path: String, offset: u64, len: u64, total: u64, token: String) -> Result<UploadStep, String> {
    check_upload_url(&upload_url)?;
    let end = offset.checked_add(len).ok_or("Plage invalide.")?;
    if len == 0 || end > total {
        return Err(format!("Plage invalide : {offset} + {len} dépasse {total} octets."));
    }
    if len % QUANTUM != 0 && end != total {
        return Err("Taille de morceau invalide : multiple de 256 Kio obligatoire (sauf le dernier).".into());
    }
    if len > MAX_CHUNK {
        return Err("Morceau trop grand (256 Mio maximum).".into());
    }
    clear_cancel(&upload_url);
    let data = read_range(&path, offset, len, total).await?;
    let mime = video_mime(&path);

    // Corps en flux de 256 Kio : progression fine + annulation immédiate (pause).
    let pieces: Vec<Vec<u8>> = data.chunks(QUANTUM as usize).map(|c| c.to_vec()).collect();
    drop(data);
    let url_s = upload_url.clone();
    let app_s = app.clone();
    let mut sent: u64 = 0;
    let stream = futures_util::stream::iter(pieces.into_iter().map(move |piece| {
        if is_cancelled(&url_s) {
            return Err(std::io::Error::new(ErrorKind::Interrupted, "envoi mis en pause"));
        }
        sent += piece.len() as u64;
        let _ = app_s.emit(PROGRESS_EVENT, Progress { upload_url: url_s.clone(), offset, sent, len, total });
        Ok::<Vec<u8>, std::io::Error>(piece)
    }));

    let res = client()?
        .put(&upload_url)
        .bearer_auth(&token)
        .header("Content-Length", len.to_string())
        .header("Content-Type", mime)
        .header("Content-Range", content_range(offset, len, total))
        .timeout(chunk_timeout(len))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;
    match res {
        Ok(r) => {
            clear_cancel(&upload_url);
            interpret(r, offset, total).await
        }
        Err(e) => {
            if is_cancelled(&upload_url) {
                clear_cancel(&upload_url);
                return Ok(UploadStep { status: "cancelled", next_offset: offset, message: Some("Envoi mis en pause.".into()), ..Default::default() });
            }
            // Coupure réseau : le front demande l'état (yt_upload_status) avant de reprendre.
            Ok(UploadStep { status: "retry", next_offset: offset, message: Some(net_error(&e)), ..Default::default() })
        }
    }
}

/// Demande à YouTube ce qu'il a reçu (PUT vide, Content-Range: bytes */total) pour reprendre après une coupure.
#[tauri::command]
pub async fn yt_upload_status(upload_url: String, total: u64, token: String) -> Result<UploadStep, String> {
    check_upload_url(&upload_url)?;
    let res = client()?
        .put(&upload_url)
        .bearer_auth(&token)
        .header("Content-Length", "0")
        .header("Content-Range", format!("bytes */{total}"))
        .timeout(Duration::from_secs(60))
        .body(Vec::<u8>::new())
        .send()
        .await;
    match res {
        Ok(r) => interpret(r, 0, total).await,
        Err(e) => Ok(UploadStep { status: "retry", next_offset: 0, message: Some(net_error(&e)), ..Default::default() }),
    }
}

/// Interrompt le morceau en cours pour cette session (pause immédiate).
#[tauri::command]
pub fn yt_upload_cancel(upload_url: String) {
    if let Ok(mut s) = cancelled().lock() {
        s.insert(upload_url);
    }
}

/// Taille, type, et (MP4/MOV/M4V) durée + dimensions de la vidéo.
#[tauri::command]
pub async fn yt_file_info(path: String) -> Result<FileInfo, String> {
    let meta = tokio::fs::metadata(&path).await.map_err(|e| file_error(&path, e))?;
    if !meta.is_file() {
        return Err(format!("Ce n'est pas un fichier : {path}"));
    }
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    let probe = probe_mp4(&path).await.ok().flatten().unwrap_or_default();
    Ok(FileInfo { name, size: meta.len(), mime: video_mime(&path), duration_sec: probe.duration, width: probe.width, height: probe.height })
}

/// thumbnails.set : envoie l'image (JPEG/PNG) comme miniature personnalisée.
#[tauri::command]
pub async fn yt_thumbnail_set(video_id: String, path: String, token: String) -> Result<Value, String> {
    check_video_id(&video_id)?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| file_error(&path, e))?;
    if bytes.is_empty() {
        return Err("L'image de miniature est vide.".into());
    }
    let mime = image_mime(&path, &bytes);
    let url = format!("{THUMBNAILS_UPLOAD}?videoId={video_id}&uploadType=media");
    let res = client()?
        .post(url)
        .bearer_auth(&token)
        .header("Content-Type", mime)
        .timeout(Duration::from_secs(180))
        .body(bytes)
        .send()
        .await
        .map_err(|e| net_error(&e))?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        return Ok(serde_json::from_str(&body).unwrap_or(Value::Null));
    }
    let mut msg = google_error("Miniature YouTube", status, &body);
    if status == 403 {
        msg.push_str(" — Les miniatures personnalisées exigent une chaîne validée (youtube.com/verify).");
    }
    Err(msg)
}

/// captions.insert (envoi multipart) : piste de sous-titres .srt pour une vidéo.
#[tauri::command]
pub async fn yt_caption_insert(video_id: String, path: String, language: String, name: String, is_draft: bool, token: String) -> Result<Value, String> {
    check_video_id(&video_id)?;
    let data = tokio::fs::read(&path).await.map_err(|e| file_error(&path, e))?;
    if data.is_empty() {
        return Err("Le fichier de sous-titres est vide.".into());
    }
    if data.len() as u64 > 100 * 1024 * 1024 {
        return Err("Fichier de sous-titres trop volumineux (100 Mo maximum).".into());
    }
    let meta = serde_json::json!({ "snippet": { "videoId": video_id, "language": language, "name": name, "isDraft": is_draft } });
    let boundary = format!("prisme_{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(data.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    body.extend_from_slice(&data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let res = client()?
        .post(format!("{CAPTIONS_UPLOAD}?uploadType=multipart&part=snippet"))
        .bearer_auth(&token)
        .header("Content-Type", format!("multipart/related; boundary={boundary}"))
        .timeout(Duration::from_secs(300))
        .body(body)
        .send()
        .await
        .map_err(|e| net_error(&e))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    } else {
        Err(google_error("Sous-titres YouTube", status, &text))
    }
}

// ── Lecture MP4 / MOV (boîtes ISO-BMFF : moov → mvhd, trak → tkhd) ──────

#[derive(Default)]
struct Mp4Probe {
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

async fn probe_mp4(path: &str) -> std::io::Result<Option<Mp4Probe>> {
    let mut f = tokio::fs::File::open(path).await?;
    let size = f.metadata().await?.len();
    let mut pos = 0u64;
    for _ in 0..64 {
        if pos + 8 > size {
            break;
        }
        f.seek(SeekFrom::Start(pos)).await?;
        let mut hdr = [0u8; 8];
        f.read_exact(&mut hdr).await?;
        let mut box_size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let mut header_len = 8u64;
        if box_size == 1 {
            let mut ext = [0u8; 8];
            f.read_exact(&mut ext).await?;
            box_size = u64::from_be_bytes(ext);
            header_len = 16;
        } else if box_size == 0 {
            box_size = size - pos;
        }
        if box_size < header_len || pos + box_size > size {
            break;
        }
        if &hdr[4..8] == b"moov" {
            let len = box_size - header_len;
            if len > 64 * 1024 * 1024 {
                return Ok(None);
            }
            let mut buf = vec![0u8; len as usize];
            f.read_exact(&mut buf).await?;
            return Ok(Some(parse_moov(&buf)));
        }
        pos += box_size;
    }
    Ok(None)
}

fn boxes(buf: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let mut size = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let kind = [buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]];
        let mut hl = 8usize;
        if size == 1 {
            if i + 16 > buf.len() {
                break;
            }
            let mut ext = [0u8; 8];
            ext.copy_from_slice(&buf[i + 8..i + 16]);
            size = u64::from_be_bytes(ext) as usize;
            hl = 16;
        } else if size == 0 {
            size = buf.len() - i;
        }
        if size < hl || i + size > buf.len() {
            break;
        }
        out.push((kind, &buf[i + hl..i + size]));
        i += size;
    }
    out
}

fn be_u32(p: &[u8], at: usize) -> Option<u32> {
    p.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn be_u64(p: &[u8], at: usize) -> Option<u64> {
    p.get(at..at + 8).map(|b| u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
}

/// mvhd : durée = duration / timescale (versions 0 et 1).
fn parse_mvhd(p: &[u8]) -> Option<f64> {
    let (timescale, duration) = if *p.first()? == 1 { (be_u32(p, 20)?, be_u64(p, 24)?) } else { (be_u32(p, 12)?, be_u32(p, 16)? as u64) };
    if timescale == 0 {
        None
    } else {
        Some(duration as f64 / timescale as f64)
    }
}

/// tkhd : largeur/hauteur (16.16), inversées si la matrice indique une rotation de 90°/270°.
fn parse_tkhd(p: &[u8]) -> Option<(u32, u32)> {
    let v1 = *p.first()? == 1;
    let (matrix, dims) = if v1 { (52usize, 88usize) } else { (40usize, 76usize) };
    let w = be_u32(p, dims)? >> 16;
    let h = be_u32(p, dims + 4)? >> 16;
    if w == 0 || h == 0 {
        return None;
    }
    let a = be_u32(p, matrix)? as i32;
    let b = be_u32(p, matrix + 4)? as i32;
    let d = be_u32(p, matrix + 16)? as i32;
    if a == 0 && d == 0 && b != 0 {
        Some((h, w))
    } else {
        Some((w, h))
    }
}

fn parse_moov(moov: &[u8]) -> Mp4Probe {
    let mut probe = Mp4Probe::default();
    for (kind, payload) in boxes(moov) {
        match &kind {
            b"mvhd" => probe.duration = parse_mvhd(payload),
            b"trak" if probe.width.is_none() => {
                if let Some((_, tkhd)) = boxes(payload).into_iter().find(|(k, _)| k == b"tkhd") {
                    if let Some((w, h)) = parse_tkhd(tkhd) {
                        probe.width = Some(w);
                        probe.height = Some(h);
                    }
                }
            }
            _ => {}
        }
    }
    probe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(content_range(0, 262_144, 1_000_000), "bytes 0-262143/1000000");
        assert_eq!(next_offset_from_range(Some("bytes=0-999999")), 1_000_000);
        assert_eq!(next_offset_from_range(None), 0);
    }

    #[test]
    fn mp4_boxes() {
        // mvhd v0 : timescale 1000, durée 61 500 → 61,5 s
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&61_500u32.to_be_bytes());
        assert_eq!(parse_mvhd(&mvhd), Some(61.5));
        // tkhd v0 : 1080×1920 sans rotation
        let mut tkhd = vec![0u8; 84];
        tkhd[40..44].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        tkhd[56..60].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        tkhd[76..80].copy_from_slice(&(1080u32 << 16).to_be_bytes());
        tkhd[80..84].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        assert_eq!(parse_tkhd(&tkhd), Some((1080, 1920)));
        let mut buf = Vec::new();
        buf.extend_from_slice(&((8 + mvhd.len()) as u32).to_be_bytes());
        buf.extend_from_slice(b"mvhd");
        buf.extend_from_slice(&mvhd);
        assert_eq!(boxes(&buf).len(), 1);
        assert_eq!(parse_moov(&buf).duration, Some(61.5));
    }
}
