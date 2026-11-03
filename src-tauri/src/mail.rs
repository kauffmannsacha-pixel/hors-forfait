// Module Rust « mail » — IMAP (async-imap + async-native-tls sur tokio) et SMTP (lettre).
//
// Les identifiants sont fournis par le front à chaque appel (lus dans le coffre `secrets`) :
// rien n'est écrit sur disque ici. Une connexion IMAP par compte (clé = `account.id`) est gardée
// en mémoire et rétablie automatiquement si le serveur l'a fermée. Le front utilise un id suffixé
// (`<id>#sync`) pour la synchro d'arrière-plan afin de ne pas bloquer les actions de l'utilisateur.
//
// Commandes (à enregistrer dans lib.rs) :
//   mail_imap_test, mail_imap_folders, mail_imap_fetch, mail_imap_fetch_message,
//   mail_imap_fetch_attachment, mail_imap_flags, mail_imap_set_flags, mail_imap_move,
//   mail_imap_delete, mail_imap_search, mail_imap_append, mail_imap_create_folder,
//   mail_imap_disconnect, mail_smtp_test, mail_smtp_send

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_imap::error::Error as ImapError;
use async_imap::imap_proto::{MailboxDatum, RequestId, Response, Status};
use async_imap::types::{Fetch, Flag, Name, NameAttribute};
use async_imap::{Client, Session};
use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD};
use base64::Engine as _;
use futures_util::TryStreamExt;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use mail_parser::{Address, HeaderValue, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const OP_TIMEOUT: Duration = Duration::from_secs(120);
/// En-têtes complets + début du corps (pour l'extrait), sans marquer le message comme lu.
const HEADER_QUERY: &str =
    "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.4096>)";
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;
/// Taille max d'une image intégrée (cid:) renvoyée d'office avec le message.
const INLINE_MAX: usize = 3 * 1024 * 1024;
/// Taille max cumulée des pièces jointes à l'envoi.
const MAX_SEND_BYTES: usize = 25 * 1024 * 1024;

// ───────────────────────────── Types d'entrée ─────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    #[default]
    Ssl,
    Starttls,
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub security: Security,
    pub username: String,
    #[serde(default)]
    pub password: String,
}

/// Compte passé par le front (identifiants lus dans le coffre `secrets`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub imap: Option<ServerConfig>,
    #[serde(default)]
    pub smtp: Option<ServerConfig>,
    /// Certificats auto-signés acceptés UNIQUEMENT pour un serveur local (pont type Proton Bridge).
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Addr {
    #[serde(default)]
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutAttachment {
    pub name: String,
    #[serde(default)]
    pub mime: String,
    /// Contenu en base64 standard.
    pub data: String,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub inline: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub from: Addr,
    #[serde(default)]
    pub to: Vec<Addr>,
    #[serde(default)]
    pub cc: Vec<Addr>,
    #[serde(default)]
    pub bcc: Vec<Addr>,
    #[serde(default)]
    pub reply_to: Option<Addr>,
    pub subject: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<OutAttachment>,
}

// ───────────────────────────── Types de sortie ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    /// Nom brut IMAP (UTF-7 modifié) — à renvoyer tel quel aux autres commandes.
    pub path: String,
    /// Dernier segment, décodé.
    pub name: String,
    /// Chemin complet, décodé.
    pub full_name: String,
    pub delimiter: Option<String>,
    /// inbox | sent | drafts | trash | junk | archive | all | flagged | important
    pub role: Option<String>,
    pub selectable: bool,
    pub depth: u32,
    pub total: Option<u32>,
    pub unread: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderInfo {
    pub uid: u32,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from: Option<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    /// Millisecondes depuis l'époque Unix.
    pub date: i64,
    pub flags: Vec<String>,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub draft: bool,
    pub size: u32,
    pub snippet: String,
    pub has_attachments: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub folder: String,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub exists: u32,
    /// Du plus récent au plus ancien (UID décroissant).
    pub messages: Vec<HeaderInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub index: u32,
    pub name: String,
    pub mime: String,
    pub size: usize,
    pub content_id: Option<String>,
    pub inline: bool,
    /// Base64 standard (absent si non demandé).
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullMessage {
    pub header: HeaderInfo,
    pub bcc: Vec<Addr>,
    pub html: Option<String>,
    pub text: String,
    pub attachments: Vec<AttachmentInfo>,
    pub list_unsubscribe: Option<String>,
    /// Message brut (.eml) en base64, si demandé.
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagsInfo {
    pub uid: u32,
    pub flags: Vec<String>,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub folders: usize,
    pub capabilities: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    /// Message-ID sans chevrons.
    pub message_id: String,
    /// Message tel qu'envoyé (base64) — pour en garder une copie dans « Envoyés ».
    pub raw: String,
}

// ───────────────────────────── Erreurs ─────────────────────────────

enum OpError {
    Imap(ImapError),
    Timeout,
    Msg(String),
}

impl From<ImapError> for OpError {
    fn from(e: ImapError) -> Self {
        OpError::Imap(e)
    }
}

impl OpError {
    /// La connexion n'est plus utilisable : on la jette (et on réessaie une fois si possible).
    fn breaks_connection(&self) -> bool {
        matches!(
            self,
            OpError::Timeout
                | OpError::Imap(ImapError::Io(_))
                | OpError::Imap(ImapError::ConnectionLost)
                | OpError::Imap(ImapError::Parse(_))
        )
    }
}

/// Extrait le texte utile d'un message d'erreur async-imap (`code: …, info: Some("…")`).
fn clean_info(s: &str) -> String {
    if let Some(i) = s.find("info: Some(\"") {
        let rest = &s[i + 12..];
        if let Some(end) = rest.rfind("\")") {
            return rest[..end].replace("\\\"", "\"");
        }
    }
    s.to_string()
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpError::Timeout => write!(f, "Le serveur IMAP met trop de temps à répondre (délai dépassé)."),
            OpError::Msg(m) => write!(f, "{m}"),
            OpError::Imap(e) => match e {
                ImapError::No(info) => write!(f, "Le serveur IMAP a refusé l'opération : {}", clean_info(info)),
                ImapError::Bad(info) => write!(f, "Commande IMAP rejetée par le serveur : {}", clean_info(info)),
                ImapError::Io(io) => write!(f, "Connexion IMAP interrompue : {io}"),
                ImapError::ConnectionLost => write!(f, "Connexion IMAP perdue."),
                ImapError::Parse(p) => write!(f, "Réponse IMAP illisible : {p}"),
                ImapError::Validate(v) => write!(f, "Valeur invalide pour IMAP : {v}"),
                ImapError::Append => write!(f, "Impossible d'enregistrer le message dans ce dossier."),
                other => write!(f, "Erreur IMAP : {other}"),
            },
        }
    }
}

fn net_reason(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => "connexion refusée (port ou sécurité incorrects ?)".into(),
        TimedOut => "délai dépassé".into(),
        NotFound => "serveur introuvable (vérifie le nom d'hôte)".into(),
        _ => {
            let s = e.to_string();
            if s.contains("failed to lookup") || s.contains("No such host") || s.contains("Name or service") {
                "serveur introuvable (vérifie le nom d'hôte et ta connexion Internet)".into()
            } else {
                s
            }
        }
    }
}

fn tls_err(host: &str, e: &dyn fmt::Display) -> String {
    format!("Échec de la connexion sécurisée (TLS) avec {host} : {e}. Vérifie le port et le mode de sécurité.")
}

fn login_err(e: &ImapError) -> String {
    match e {
        ImapError::No(info) | ImapError::Bad(info) => format!(
            "Identifiants refusés par le serveur IMAP ({}). Vérifie l'adresse et le mot de passe — Gmail, Outlook, Yahoo et iCloud exigent un mot de passe d'application.",
            clean_info(info)
        ),
        other => format!("Connexion IMAP impossible : {}", OpError::Imap(clone_err(other))),
    }
}

/// async-imap::Error n'est pas Clone : on en reconstruit une version affichable.
fn clone_err(e: &ImapError) -> ImapError {
    match e {
        ImapError::No(s) => ImapError::No(s.clone()),
        ImapError::Bad(s) => ImapError::Bad(s.clone()),
        ImapError::ConnectionLost => ImapError::ConnectionLost,
        ImapError::Append => ImapError::Append,
        other => ImapError::Io(std::io::Error::other(other.to_string())),
    }
}

// ───────────────────────────── Connexion & pool ─────────────────────────────

trait ImapIo: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug> ImapIo for T {}
type ImapStream = Box<dyn ImapIo>;
type ImapSession = Session<ImapStream>;

struct Pooled {
    session: ImapSession,
    fingerprint: String,
}
type Slot = Arc<Mutex<Option<Pooled>>>;

fn pool() -> &'static std::sync::Mutex<HashMap<String, Slot>> {
    static POOL: OnceLock<std::sync::Mutex<HashMap<String, Slot>>> = OnceLock::new();
    POOL.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn slot_for(id: &str) -> Slot {
    let mut map = pool().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

fn imap_cfg(acc: &MailAccount) -> Result<&ServerConfig, String> {
    acc.imap
        .as_ref()
        .filter(|c| !c.host.trim().is_empty())
        .ok_or_else(|| "Serveur IMAP non configuré pour ce compte.".to_string())
}

fn fingerprint(acc: &MailAccount, cfg: &ServerConfig) -> String {
    let mut h = Sha256::new();
    h.update(cfg.host.trim().as_bytes());
    h.update(cfg.port.to_be_bytes());
    h.update(format!("{:?}", cfg.security).as_bytes());
    h.update(cfg.username.as_bytes());
    h.update([0u8]);
    h.update(cfg.password.as_bytes());
    h.update([acc.accept_invalid_certs as u8]);
    hex::encode(h.finalize())
}

fn is_local_host(h: &str) -> bool {
    matches!(h.trim(), "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn tls_connector(acc: &MailAccount, host: &str) -> async_native_tls::TlsConnector {
    let c = async_native_tls::TlsConnector::new();
    if acc.accept_invalid_certs && is_local_host(host) {
        c.danger_accept_invalid_certs(true)
    } else {
        c
    }
}

async fn read_greeting(client: &mut Client<ImapStream>) -> Result<(), String> {
    match client.read_response().await {
        Some(Ok(resp)) => match resp.parsed() {
            Response::Data { status: Status::Bye, information, .. } => Err(format!(
                "Le serveur IMAP a refusé la connexion : {}",
                information.as_deref().unwrap_or("")
            )),
            _ => Ok(()),
        },
        Some(Err(e)) => Err(format!("Réponse invalide du serveur IMAP : {e}")),
        None => Err("Le serveur IMAP a fermé la connexion dès l'ouverture.".into()),
    }
}

async fn open_client(acc: &MailAccount, cfg: &ServerConfig) -> Result<Client<ImapStream>, String> {
    let host = cfg.host.trim();
    let tcp = match timeout(CONNECT_TIMEOUT, TcpStream::connect((host, cfg.port))).await {
        Err(_) => return Err(format!("Le serveur IMAP {host}:{} ne répond pas (délai dépassé).", cfg.port)),
        Ok(Err(e)) => return Err(format!("Impossible de joindre le serveur IMAP {host}:{} — {}.", cfg.port, net_reason(&e))),
        Ok(Ok(t)) => t,
    };
    let _ = tcp.set_nodelay(true);
    match cfg.security {
        Security::Ssl => {
            let tls = tls_connector(acc, host)
                .connect(host, tcp)
                .await
                .map_err(|e| tls_err(host, &e))?;
            let mut client = Client::new(Box::new(tls) as ImapStream);
            read_greeting(&mut client).await?;
            Ok(client)
        }
        Security::Starttls => {
            let mut plain = Client::new(Box::new(tcp) as ImapStream);
            read_greeting(&mut plain).await?;
            plain
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|e| format!("Le serveur {host} refuse STARTTLS ({}). Essaie le mode SSL/TLS (port 993).", OpError::Imap(e)))?;
            let inner = plain.into_inner();
            let tls = tls_connector(acc, host)
                .connect(host, inner)
                .await
                .map_err(|e| tls_err(host, &e))?;
            Ok(Client::new(Box::new(tls) as ImapStream))
        }
        Security::None => {
            let mut client = Client::new(Box::new(tcp) as ImapStream);
            read_greeting(&mut client).await?;
            Ok(client)
        }
    }
}

async fn connect_imap(acc: &MailAccount, cfg: &ServerConfig) -> Result<ImapSession, String> {
    let fut = async {
        let client = open_client(acc, cfg).await?;
        client
            .login(cfg.username.trim(), &cfg.password)
            .await
            .map_err(|(e, _)| login_err(&e))
    };
    match timeout(CONNECT_TIMEOUT * 2, fut).await {
        Err(_) => Err(format!("Délai dépassé pendant la connexion à {}.", cfg.host.trim())),
        Ok(r) => r,
    }
}

/// Exécute `$body` (une expression async renvoyant `Result<T, OpError>`) avec la session IMAP
/// du compte, en la (re)créant si besoin. Une seule tentative de reconnexion si le serveur
/// avait fermé la connexion gardée en mémoire.
macro_rules! with_session {
    ($acc:expr, $s:ident, $body:expr) => {{
        let acc: &MailAccount = $acc;
        let cfg = imap_cfg(acc)?;
        let fp = fingerprint(acc, cfg);
        let slot = slot_for(&acc.id);
        let mut guard = slot.lock().await;
        let mut attempt = 0u8;
        loop {
            attempt += 1;
            let stale = match guard.as_ref() {
                Some(p) => p.fingerprint != fp,
                None => true,
            };
            if stale {
                if let Some(mut old) = guard.take() {
                    let _ = timeout(Duration::from_secs(3), old.session.logout()).await;
                }
                let session = connect_imap(acc, cfg).await?;
                *guard = Some(Pooled { session, fingerprint: fp.clone() });
            }
            let outcome = {
                let $s: &mut ImapSession = &mut guard.as_mut().expect("session IMAP").session;
                match timeout(OP_TIMEOUT, async { $body }).await {
                    Ok(r) => r,
                    Err(_) => Err(OpError::Timeout),
                }
            };
            match outcome {
                Ok(v) => break Ok(v),
                Err(e) => {
                    let broken = e.breaks_connection();
                    if broken {
                        *guard = None;
                    }
                    if broken && attempt < 2 && !matches!(e, OpError::Timeout) {
                        continue;
                    }
                    break Err(e.to_string());
                }
            }
        }
    }};
}

// ───────────────────────────── Utilitaires ─────────────────────────────

/// Décode un nom de dossier IMAP en UTF-7 modifié (RFC 3501 §5.1.3).
fn decode_mutf7(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        match after.find('-') {
            Some(end) => {
                let chunk = &after[..end];
                if chunk.is_empty() {
                    out.push('&');
                } else {
                    let decoded = STANDARD_NO_PAD
                        .decode(chunk.replace(',', "/").as_bytes())
                        .ok()
                        .filter(|b| b.len() % 2 == 0)
                        .and_then(|b| {
                            let units: Vec<u16> = b.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                            String::from_utf16(&units).ok()
                        });
                    match decoded {
                        Some(t) => out.push_str(&t),
                        None => {
                            out.push('&');
                            out.push_str(chunk);
                            out.push('-');
                        }
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Encode un nom de dossier en UTF-7 modifié.
fn encode_mutf7(s: &str) -> String {
    fn flush(pending: &mut Vec<u16>, out: &mut String) {
        if pending.is_empty() {
            return;
        }
        let bytes: Vec<u8> = pending.iter().flat_map(|u| u.to_be_bytes()).collect();
        out.push('&');
        out.push_str(&STANDARD_NO_PAD.encode(bytes).replace('/', ","));
        out.push('-');
        pending.clear();
    }
    let mut out = String::with_capacity(s.len());
    let mut pending: Vec<u16> = Vec::new();
    for ch in s.chars() {
        if (' '..='~').contains(&ch) {
            flush(&mut pending, &mut out);
            if ch == '&' {
                out.push_str("&-");
            } else {
                out.push(ch);
            }
        } else {
            let mut buf = [0u16; 2];
            pending.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    flush(&mut pending, &mut out);
    out
}

fn quote_imap(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",")
}

fn newest(list: &mut Vec<u32>, limit: usize) {
    list.sort_unstable_by(|a, b| b.cmp(a));
    list.dedup();
    list.truncate(limit);
}

fn clamp_limit(limit: Option<u32>) -> usize {
    limit.map(|l| l as usize).unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn flag_strings(f: &Fetch) -> Vec<String> {
    f.flags()
        .map(|fl| match fl {
            Flag::Seen => "\\Seen".to_string(),
            Flag::Answered => "\\Answered".to_string(),
            Flag::Flagged => "\\Flagged".to_string(),
            Flag::Deleted => "\\Deleted".to_string(),
            Flag::Draft => "\\Draft".to_string(),
            Flag::Recent => "\\Recent".to_string(),
            Flag::MayCreate => "\\*".to_string(),
            Flag::Custom(c) => c.to_string(),
        })
        .collect()
}

fn has_flag(flags: &[String], f: &str) -> bool {
    flags.iter().any(|x| x.eq_ignore_ascii_case(f))
}

fn valid_flag(f: &str) -> bool {
    matches!(f, "\\Seen" | "\\Flagged" | "\\Answered" | "\\Draft" | "\\Deleted")
        || (!f.is_empty()
            && f.len() < 64
            && f.chars().all(|c| c.is_ascii_alphanumeric() || "$_-.".contains(c)))
}

fn strip_angle(s: &str) -> String {
    s.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

fn angle(s: &str) -> String {
    format!("<{}>", strip_angle(s))
}

fn ids_of(v: &HeaderValue<'_>) -> Vec<String> {
    let raw: Vec<String> = match v {
        HeaderValue::Text(t) => t.split_whitespace().map(|x| x.to_string()).collect(),
        HeaderValue::TextList(l) => l.iter().map(|x| x.to_string()).collect(),
        _ => Vec::new(),
    };
    raw.iter().map(|s| strip_angle(s)).filter(|s| !s.is_empty()).collect()
}

fn addrs(a: Option<&Address<'_>>) -> Vec<Addr> {
    match a {
        Some(a) => a
            .iter()
            .filter_map(|x| {
                x.address().map(|e| Addr {
                    name: x.name().map(|n| n.trim().trim_matches('"').trim().to_string()).filter(|n| !n.is_empty()),
                    email: e.trim().to_string(),
                })
            })
            .filter(|a| !a.email.is_empty())
            .collect(),
        None => Vec::new(),
    }
}

/// Nettoie un extrait : espaces normalisés, caractères invisibles des newsletters retirés.
fn clean_snippet(s: &str, max: usize) -> String {
    let filtered: String = s
        .chars()
        .filter(|c| !matches!(*c, '\u{200b}'..='\u{200f}' | '\u{034f}' | '\u{feff}' | '\u{00ad}' | '\u{2060}' | '\u{180e}'))
        .collect();
    let collapsed = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let mut t: String = collapsed.chars().take(max).collect();
        t.push('…');
        t
    } else {
        collapsed
    }
}

fn mime_of(part: &mail_parser::MessagePart<'_>) -> String {
    if part.is_message() {
        return "message/rfc822".into();
    }
    part.content_type()
        .map(|ct| match ct.subtype() {
            Some(st) => format!("{}/{}", ct.ctype(), st),
            None => ct.ctype().to_string(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
        .to_ascii_lowercase()
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "piece-jointe".into() } else { t }
}

fn default_name(i: usize, mime: &str) -> String {
    let ext = mime_guess::get_mime_extensions_str(mime)
        .and_then(|e| e.first().copied())
        .unwrap_or("bin");
    format!("piece-jointe-{}.{}", i + 1, ext)
}

/// Pièces jointes « réelles » (on exclut les images intégrées référencées par cid:).
fn real_attachment_count(msg: &mail_parser::Message<'_>) -> usize {
    msg.attachments()
        .filter(|p| {
            let has_cid = p.content_id().is_some();
            let disp_attach = p.content_disposition().map(|d| d.is_attachment()).unwrap_or(false);
            disp_attach || !has_cid
        })
        .count()
}

fn build_header(uid: u32, msg: Option<&mail_parser::Message<'_>>, flags: Vec<String>, size: u32, internal_ms: Option<i64>) -> HeaderInfo {
    let (subject, from, to, cc, reply_to, header_date, message_id, in_reply_to, references, snippet, has_attachments) = match msg {
        Some(m) => {
            let ct_mixed = m
                .content_type()
                .map(|ct| ct.ctype().eq_ignore_ascii_case("multipart") && ct.subtype().map(|s| s.eq_ignore_ascii_case("mixed")).unwrap_or(false))
                .unwrap_or(false);
            (
                m.subject().unwrap_or("").trim().to_string(),
                addrs(m.from()).into_iter().next(),
                addrs(m.to()),
                addrs(m.cc()),
                addrs(m.reply_to()),
                m.date().map(|d| d.to_timestamp() * 1000).filter(|t| *t > 0),
                m.message_id().map(strip_angle).filter(|s| !s.is_empty()),
                ids_of(m.in_reply_to()).into_iter().next(),
                ids_of(m.references()),
                clean_snippet(&m.body_preview(400).unwrap_or_default(), 240),
                ct_mixed || real_attachment_count(m) > 0,
            )
        }
        None => (String::new(), None, Vec::new(), Vec::new(), Vec::new(), None, None, None, Vec::new(), String::new(), false),
    };
    HeaderInfo {
        uid,
        message_id,
        in_reply_to,
        references,
        subject,
        from,
        to,
        cc,
        reply_to,
        date: internal_ms.or(header_date).unwrap_or(0),
        seen: has_flag(&flags, "\\Seen"),
        flagged: has_flag(&flags, "\\Flagged"),
        answered: has_flag(&flags, "\\Answered"),
        draft: has_flag(&flags, "\\Draft"),
        flags,
        size,
        snippet,
        has_attachments,
    }
}

fn header_from_fetch(f: &Fetch) -> Option<HeaderInfo> {
    let uid = f.uid?;
    let head = f.header()?;
    let text = f.text().unwrap_or(&[]);
    let mut raw = Vec::with_capacity(head.len() + text.len());
    raw.extend_from_slice(head);
    raw.extend_from_slice(text);
    let parsed = MessageParser::default().parse(&raw[..]);
    let internal = f.internal_date().map(|d| d.timestamp_millis());
    Some(build_header(uid, parsed.as_ref(), flag_strings(f), f.size.unwrap_or(0), internal))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AttMode {
    None,
    Inline,
    All,
}

fn att_mode(s: Option<&str>) -> AttMode {
    match s.unwrap_or("inline") {
        "none" => AttMode::None,
        "all" => AttMode::All,
        _ => AttMode::Inline,
    }
}

fn attachments_of(msg: &mail_parser::Message<'_>, mode: AttMode, only: Option<u32>) -> Vec<AttachmentInfo> {
    msg.attachments()
        .enumerate()
        .filter(|(i, _)| only.map(|o| o as usize == *i).unwrap_or(true))
        .map(|(i, part)| {
            let mime = mime_of(part);
            let content_id = part.content_id().map(strip_angle).filter(|c| !c.is_empty());
            let disp_inline = part.content_disposition().map(|d| d.is_inline()).unwrap_or(false);
            let disp_attach = part.content_disposition().map(|d| d.is_attachment()).unwrap_or(false);
            let name = part
                .attachment_name()
                .map(|n| n.to_string())
                .or_else(|| part.message().and_then(|m| m.subject()).map(|s| format!("{s}.eml")))
                .unwrap_or_else(|| default_name(i, &mime));
            let inline = content_id.is_some() && !disp_attach && (disp_inline || part.attachment_name().is_none() || mime.starts_with("image/"));
            let bytes = part.contents();
            let want = match mode {
                AttMode::All => true,
                AttMode::Inline => inline && bytes.len() <= INLINE_MAX,
                AttMode::None => false,
            };
            AttachmentInfo {
                index: i as u32,
                name: sanitize_filename(&name),
                mime,
                size: bytes.len(),
                content_id,
                inline,
                data: if want { Some(B64.encode(bytes)) } else { None },
            }
        })
        .collect()
}

fn role_of(path: &str, attrs: &[NameAttribute<'_>]) -> Option<String> {
    if path.eq_ignore_ascii_case("INBOX") {
        return Some("inbox".into());
    }
    for a in attrs {
        let r = match a {
            NameAttribute::Sent => "sent",
            NameAttribute::Drafts => "drafts",
            NameAttribute::Trash => "trash",
            NameAttribute::Junk => "junk",
            NameAttribute::Archive => "archive",
            NameAttribute::All => "all",
            NameAttribute::Flagged => "flagged",
            NameAttribute::Extension(e) if e.trim_start_matches('\\').eq_ignore_ascii_case("Important") => "important",
            _ => continue,
        };
        return Some(r.into());
    }
    None
}

// ───────────────────────────── Opérations IMAP ─────────────────────────────

async fn op_folders(s: &mut ImapSession, with_counts: bool) -> Result<Vec<FolderInfo>, OpError> {
    let names: Vec<Name> = s.list(Some(""), Some("*")).await?.try_collect().await?;
    let mut out: Vec<FolderInfo> = names
        .iter()
        .map(|n| {
            let path = n.name().to_string();
            let delimiter = n.delimiter().map(|d| d.to_string());
            let full_name = decode_mutf7(&path);
            let name = match &delimiter {
                Some(d) if !d.is_empty() => full_name.rsplit(d.as_str()).next().unwrap_or(&full_name).to_string(),
                _ => full_name.clone(),
            };
            let depth = match &delimiter {
                Some(d) if !d.is_empty() => path.matches(d.as_str()).count() as u32,
                _ => 0,
            };
            let attrs = n.attributes();
            let selectable = !attrs.iter().any(|a| match a {
                NameAttribute::NoSelect => true,
                NameAttribute::Extension(e) => e.trim_start_matches('\\').eq_ignore_ascii_case("NonExistent"),
                _ => false,
            });
            FolderInfo {
                role: role_of(&path, attrs),
                path,
                name: if name.eq_ignore_ascii_case("INBOX") { "Réception".into() } else { name },
                full_name,
                delimiter,
                selectable,
                depth,
                total: None,
                unread: None,
            }
        })
        .collect();
    if with_counts {
        let paths: Vec<String> = out.iter().filter(|f| f.selectable).take(40).map(|f| f.path.clone()).collect();
        for p in paths {
            if let Ok(st) = s.status(&p, "(MESSAGES UNSEEN)").await {
                if let Some(f) = out.iter_mut().find(|f| f.path == p) {
                    f.total = Some(st.exists);
                    f.unread = st.unseen;
                }
            }
        }
    }
    Ok(out)
}

async fn fetch_uids(s: &mut ImapSession, uids: &[u32], query: &str) -> Result<Vec<Fetch>, OpError> {
    let mut out = Vec::new();
    for chunk in uids.chunks(100) {
        if chunk.is_empty() {
            continue;
        }
        let stream = s.uid_fetch(uid_set(chunk), query).await?;
        let mut part: Vec<Fetch> = stream.try_collect().await?;
        out.append(&mut part);
    }
    Ok(out)
}

fn to_result(folder: &str, mbox: &async_imap::types::Mailbox, fetches: &[Fetch]) -> FetchResult {
    let mut messages: Vec<HeaderInfo> = fetches.iter().filter_map(header_from_fetch).collect();
    messages.sort_by(|a, b| b.uid.cmp(&a.uid));
    messages.dedup_by_key(|m| m.uid);
    FetchResult {
        folder: folder.to_string(),
        uid_validity: mbox.uid_validity,
        uid_next: mbox.uid_next,
        exists: mbox.exists,
        messages,
    }
}

async fn op_fetch(s: &mut ImapSession, folder: &str, since: Option<u32>, before: Option<u32>, limit: usize) -> Result<FetchResult, OpError> {
    let mbox = s.select(folder).await?;
    let exists = mbox.exists;
    let fetches: Vec<Fetch> = if exists == 0 {
        Vec::new()
    } else if let Some(since) = since.filter(|u| *u > 0) {
        let found = s.uid_search(format!("UID {}:*", since.saturating_add(1))).await?;
        let mut list: Vec<u32> = found.into_iter().filter(|u| *u > since).collect();
        newest(&mut list, limit);
        fetch_uids(s, &list, HEADER_QUERY).await?
    } else if let Some(before) = before {
        if before <= 1 {
            Vec::new()
        } else {
            let found = s.uid_search(format!("UID 1:{}", before - 1)).await?;
            let mut list: Vec<u32> = found.into_iter().filter(|u| *u < before).collect();
            newest(&mut list, limit);
            fetch_uids(s, &list, HEADER_QUERY).await?
        }
    } else {
        let start = exists.saturating_sub(limit as u32).saturating_add(1).max(1);
        let stream = s.fetch(format!("{start}:{exists}"), HEADER_QUERY).await?;
        stream.try_collect().await?
    };
    Ok(to_result(folder, &mbox, &fetches))
}

async fn fetch_raw(s: &mut ImapSession, folder: &str, uid: u32) -> Result<(Vec<u8>, Vec<String>, u32, Option<i64>), OpError> {
    s.select(folder).await?;
    let fetches = fetch_uids(s, &[uid], "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])").await?;
    let f = fetches
        .iter()
        .find(|f| f.uid == Some(uid) && f.body().is_some())
        .ok_or_else(|| OpError::Msg("Message introuvable sur le serveur (déplacé ou supprimé ?).".into()))?;
    let raw = f.body().map(|b| b.to_vec()).unwrap_or_default();
    Ok((raw, flag_strings(f), f.size.unwrap_or(0), f.internal_date().map(|d| d.timestamp_millis())))
}

async fn op_fetch_message(s: &mut ImapSession, folder: &str, uid: u32, mode: AttMode, include_raw: bool) -> Result<FullMessage, OpError> {
    let (raw, flags, size, internal) = fetch_raw(s, folder, uid).await?;
    let msg = MessageParser::default()
        .parse(&raw[..])
        .ok_or_else(|| OpError::Msg("Message illisible (format MIME invalide).".into()))?;
    let mut html_parts: Vec<String> = Vec::new();
    for i in 0..msg.html_body_count() {
        let is_html = msg.html_part(i as u32).map(|p| p.is_text_html()).unwrap_or(false);
        if is_html {
            if let Some(h) = msg.body_html(i) {
                html_parts.push(h.into_owned());
            }
        }
    }
    let mut text_parts: Vec<String> = Vec::new();
    for i in 0..msg.text_body_count() {
        if let Some(t) = msg.body_text(i) {
            text_parts.push(t.into_owned());
        }
    }
    let mut header = build_header(uid, Some(&msg), flags, size, internal);
    header.has_attachments = real_attachment_count(&msg) > 0;
    Ok(FullMessage {
        bcc: addrs(msg.bcc()),
        html: if html_parts.is_empty() { None } else { Some(html_parts.join("\n")) },
        text: text_parts.join("\n\n"),
        attachments: attachments_of(&msg, mode, None),
        list_unsubscribe: msg.header_raw("List-Unsubscribe").map(|v| v.trim().to_string()),
        raw: if include_raw { Some(B64.encode(&raw)) } else { None },
        header,
    })
}

async fn op_fetch_attachment(s: &mut ImapSession, folder: &str, uid: u32, index: u32) -> Result<AttachmentInfo, OpError> {
    let (raw, _, _, _) = fetch_raw(s, folder, uid).await?;
    let msg = MessageParser::default()
        .parse(&raw[..])
        .ok_or_else(|| OpError::Msg("Message illisible (format MIME invalide).".into()))?;
    attachments_of(&msg, AttMode::All, Some(index))
        .into_iter()
        .next()
        .ok_or_else(|| OpError::Msg("Pièce jointe introuvable.".into()))
}

async fn op_flags(s: &mut ImapSession, folder: &str, uids: &[u32]) -> Result<Vec<FlagsInfo>, OpError> {
    s.select(folder).await?;
    let mut out = Vec::new();
    for chunk in uids.chunks(250) {
        let stream = s.uid_fetch(uid_set(chunk), "(UID FLAGS)").await?;
        let fetches: Vec<Fetch> = stream.try_collect().await?;
        for f in &fetches {
            if let Some(uid) = f.uid {
                let flags = flag_strings(f);
                out.push(FlagsInfo {
                    uid,
                    seen: has_flag(&flags, "\\Seen"),
                    flagged: has_flag(&flags, "\\Flagged"),
                    answered: has_flag(&flags, "\\Answered"),
                    flags,
                });
            }
        }
    }
    out.sort_by_key(|f| f.uid);
    out.dedup_by_key(|f| f.uid);
    Ok(out)
}

async fn op_set_flags(s: &mut ImapSession, folder: &str, uids: &[u32], add: &[String], remove: &[String]) -> Result<(), OpError> {
    s.select(folder).await?;
    let set = uid_set(uids);
    if !add.is_empty() {
        let st = s.uid_store(&set, format!("+FLAGS.SILENT ({})", add.join(" "))).await?;
        let _: Vec<Fetch> = st.try_collect().await?;
    }
    if !remove.is_empty() {
        let st = s.uid_store(&set, format!("-FLAGS.SILENT ({})", remove.join(" "))).await?;
        let _: Vec<Fetch> = st.try_collect().await?;
    }
    Ok(())
}

async fn expunge_uids(s: &mut ImapSession, set: &str, uidplus: bool) -> Result<(), OpError> {
    let st = s.uid_store(set, "+FLAGS.SILENT (\\Deleted)").await?;
    let _: Vec<Fetch> = st.try_collect().await?;
    if uidplus {
        let st = s.uid_expunge(set).await?;
        let _: Vec<u32> = st.try_collect().await?;
    } else {
        let st = s.expunge().await?;
        let _: Vec<u32> = st.try_collect().await?;
    }
    Ok(())
}

async fn op_move(s: &mut ImapSession, folder: &str, uids: &[u32], target: &str) -> Result<(), OpError> {
    if folder == target {
        return Ok(());
    }
    let caps = s.capabilities().await?;
    let (has_move, uidplus) = (caps.has_str("MOVE"), caps.has_str("UIDPLUS"));
    s.select(folder).await?;
    let set = uid_set(uids);
    if has_move {
        s.uid_mv(&set, target).await?;
    } else {
        s.uid_copy(&set, quote_imap(target)).await?;
        expunge_uids(s, &set, uidplus).await?;
    }
    Ok(())
}

async fn op_delete(s: &mut ImapSession, folder: &str, uids: &[u32]) -> Result<(), OpError> {
    let caps = s.capabilities().await?;
    let uidplus = caps.has_str("UIDPLUS");
    s.select(folder).await?;
    expunge_uids(s, &uid_set(uids), uidplus).await
}

async fn wait_continue(s: &mut ImapSession, tag: &RequestId) -> Result<(), OpError> {
    loop {
        match s.read_response().await {
            Some(Ok(resp)) => match resp.parsed() {
                Response::Continue { .. } => return Ok(()),
                Response::Done { tag: t, information, .. } if t == tag => {
                    return Err(OpError::Msg(format!(
                        "Recherche refusée par le serveur : {}",
                        information.as_deref().unwrap_or("commande invalide")
                    )))
                }
                _ => {}
            },
            Some(Err(e)) => return Err(OpError::Imap(ImapError::Io(e))),
            None => return Err(OpError::Imap(ImapError::ConnectionLost)),
        }
    }
}

/// Recherche avec termes non ASCII : chaînes littérales `{n}` (RFC 3501 §4.3) en UTF-8.
async fn search_utf8(s: &mut ImapSession, terms: &[String]) -> Result<Vec<u32>, OpError> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::from("UID SEARCH CHARSET UTF-8");
    for t in terms {
        current.push_str(&format!(" TEXT {{{}}}", t.len()));
        chunks.push(std::mem::take(&mut current));
        current.push_str(t);
    }
    current.push_str(" NOT DELETED");
    chunks.push(current);
    let tag = s.run_command(&chunks[0]).await?;
    for chunk in &chunks[1..] {
        wait_continue(s, &tag).await?;
        s.run_command_untagged(chunk).await?;
    }
    let mut out = Vec::new();
    loop {
        match s.read_response().await {
            Some(Ok(resp)) => match resp.parsed() {
                Response::MailboxData(MailboxDatum::Search(ids)) => out.extend(ids.iter().copied()),
                Response::Done { tag: t, status, information, .. } if *t == tag => {
                    return match status {
                        Status::Ok => Ok(out),
                        _ => Err(OpError::Msg(format!(
                            "Recherche refusée par le serveur : {}",
                            information.as_deref().unwrap_or("critère non pris en charge")
                        ))),
                    };
                }
                _ => {}
            },
            Some(Err(e)) => return Err(OpError::Imap(ImapError::Io(e))),
            None => return Err(OpError::Imap(ImapError::ConnectionLost)),
        }
    }
}

async fn op_search(s: &mut ImapSession, folder: &str, query: &str, limit: usize) -> Result<FetchResult, OpError> {
    let mbox = s.select(folder).await?;
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|t| !t.is_empty())
        .take(8)
        .collect();
    if terms.is_empty() || mbox.exists == 0 {
        return Ok(to_result(folder, &mbox, &[]));
    }
    let mut uids: Vec<u32> = if terms.iter().all(|t| t.is_ascii()) {
        let crit = terms.iter().map(|t| format!("TEXT {}", quote_imap(t))).collect::<Vec<_>>().join(" ");
        s.uid_search(format!("{crit} NOT DELETED")).await?.into_iter().collect()
    } else {
        search_utf8(s, &terms).await?
    };
    newest(&mut uids, limit);
    let fetches = fetch_uids(s, &uids, HEADER_QUERY).await?;
    Ok(to_result(folder, &mbox, &fetches))
}

async fn op_append(s: &mut ImapSession, folder: &str, raw: &[u8], flags: &[String]) -> Result<(), OpError> {
    let flag_str = if flags.is_empty() { None } else { Some(format!("({})", flags.join(" "))) };
    s.append(folder, flag_str.as_deref(), None, raw).await?;
    Ok(())
}

// ───────────────────────────── Commandes IMAP ─────────────────────────────

/// Teste la connexion IMAP (identifiants + liste des dossiers).
#[tauri::command]
pub async fn mail_imap_test(account: MailAccount) -> Result<TestResult, String> {
    let cfg = imap_cfg(&account)?;
    let mut session = connect_imap(&account, cfg).await?;
    let probe = async {
        let caps = session.capabilities().await?;
        let capabilities: Vec<String> = ["IDLE", "MOVE", "UIDPLUS", "CONDSTORE", "SPECIAL-USE", "UTF8=ACCEPT"]
            .iter()
            .filter(|c| caps.has_str(c))
            .map(|c| c.to_string())
            .collect();
        let names: Vec<Name> = session.list(Some(""), Some("*")).await?.try_collect().await?;
        Ok::<_, OpError>((names.len(), capabilities))
    };
    let (folders, capabilities) = match timeout(OP_TIMEOUT, probe).await {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => return Err(OpError::Timeout.to_string()),
    };
    let _ = timeout(Duration::from_secs(3), session.logout()).await;
    Ok(TestResult {
        ok: true,
        folders,
        capabilities,
        message: format!("Connexion IMAP réussie — {folders} dossier(s) trouvé(s)."),
    })
}

/// Liste des dossiers (avec nombre de messages / non lus si `with_counts`).
#[tauri::command]
pub async fn mail_imap_folders(account: MailAccount, with_counts: Option<bool>) -> Result<Vec<FolderInfo>, String> {
    let counts = with_counts.unwrap_or(true);
    with_session!(&account, s, op_folders(s, counts).await)
}

/// En-têtes + drapeaux + extrait. `since_uid` : seulement les messages plus récents ;
/// `before_uid` : page plus ancienne ; sinon les `limit` derniers messages.
#[tauri::command]
pub async fn mail_imap_fetch(account: MailAccount, folder: String, since_uid: Option<u32>, limit: Option<u32>, before_uid: Option<u32>) -> Result<FetchResult, String> {
    let lim = clamp_limit(limit);
    with_session!(&account, s, op_fetch(s, &folder, since_uid, before_uid, lim).await)
}

/// Message complet : HTML / texte + pièces jointes (base64 selon `attachment_data` :
/// "none" | "inline" (défaut : images intégrées) | "all"). Ne marque pas le message comme lu.
#[tauri::command]
pub async fn mail_imap_fetch_message(account: MailAccount, folder: String, uid: u32, attachment_data: Option<String>, include_raw: Option<bool>) -> Result<FullMessage, String> {
    let mode = att_mode(attachment_data.as_deref());
    let raw = include_raw.unwrap_or(false);
    with_session!(&account, s, op_fetch_message(s, &folder, uid, mode, raw).await)
}

/// Une pièce jointe (contenu base64) par son index.
#[tauri::command]
pub async fn mail_imap_fetch_attachment(account: MailAccount, folder: String, uid: u32, index: u32) -> Result<AttachmentInfo, String> {
    with_session!(&account, s, op_fetch_attachment(s, &folder, uid, index).await)
}

/// Drapeaux actuels des messages encore présents (permet de détecter lus/supprimés ailleurs).
#[tauri::command]
pub async fn mail_imap_flags(account: MailAccount, folder: String, uids: Vec<u32>) -> Result<Vec<FlagsInfo>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    with_session!(&account, s, op_flags(s, &folder, &uids).await)
}

/// Ajoute / retire des drapeaux (\Seen, \Flagged, \Answered…).
#[tauri::command]
pub async fn mail_imap_set_flags(account: MailAccount, folder: String, uids: Vec<u32>, add: Vec<String>, remove: Vec<String>) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    if let Some(bad) = add.iter().chain(remove.iter()).find(|f| !valid_flag(f)) {
        return Err(format!("Drapeau IMAP invalide : {bad}"));
    }
    with_session!(&account, s, op_set_flags(s, &folder, &uids, &add, &remove).await)
}

/// Déplace des messages (MOVE, ou COPY + suppression si le serveur ne gère pas MOVE).
#[tauri::command]
pub async fn mail_imap_move(account: MailAccount, folder: String, uids: Vec<u32>, target: String) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    with_session!(&account, s, op_move(s, &folder, &uids, &target).await)
}

/// Suppression définitive (\Deleted + EXPUNGE). Le front demande confirmation avant.
#[tauri::command]
pub async fn mail_imap_delete(account: MailAccount, folder: String, uids: Vec<u32>) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    with_session!(&account, s, op_delete(s, &folder, &uids).await)
}

/// Recherche plein texte (sujet, expéditeur, corps) dans un dossier.
#[tauri::command]
pub async fn mail_imap_search(account: MailAccount, folder: String, query: String, limit: Option<u32>) -> Result<FetchResult, String> {
    let lim = clamp_limit(limit);
    with_session!(&account, s, op_search(s, &folder, &query, lim).await)
}

/// Ajoute un message brut (base64) dans un dossier (copie dans « Envoyés », brouillons…).
#[tauri::command]
pub async fn mail_imap_append(account: MailAccount, folder: String, raw: String, flags: Option<Vec<String>>) -> Result<(), String> {
    let bytes = B64.decode(raw.trim()).map_err(|_| "Message brut invalide (base64 attendu).".to_string())?;
    let flags = flags.unwrap_or_default();
    if let Some(bad) = flags.iter().find(|f| !valid_flag(f)) {
        return Err(format!("Drapeau IMAP invalide : {bad}"));
    }
    with_session!(&account, s, op_append(s, &folder, &bytes, &flags).await)
}

/// Crée un dossier (nom lisible, encodé en UTF-7 modifié). Renvoie son chemin IMAP.
#[tauri::command]
pub async fn mail_imap_create_folder(account: MailAccount, name: String) -> Result<String, String> {
    let path = encode_mutf7(name.trim());
    if path.is_empty() {
        return Err("Nom de dossier vide.".into());
    }
    let p = path.clone();
    with_session!(&account, s, async {
        s.create(&p).await?;
        Ok::<String, OpError>(p.clone())
    }
    .await)
}

/// Ferme la connexion IMAP gardée en mémoire (compte supprimé ou identifiants changés).
#[tauri::command]
pub async fn mail_imap_disconnect(account_id: String) -> Result<(), String> {
    let slots: Vec<Slot> = {
        let mut map = pool().lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<String> = map
            .keys()
            .filter(|k| *k == &account_id || k.starts_with(&format!("{account_id}#")))
            .cloned()
            .collect();
        keys.iter().filter_map(|k| map.remove(k)).collect()
    };
    for slot in slots {
        let mut guard = slot.lock().await;
        if let Some(mut p) = guard.take() {
            let _ = timeout(Duration::from_secs(3), p.session.logout()).await;
        }
    }
    Ok(())
}

// ───────────────────────────── SMTP ─────────────────────────────

fn smtp_cfg(acc: &MailAccount) -> Result<&ServerConfig, String> {
    acc.smtp
        .as_ref()
        .filter(|c| !c.host.trim().is_empty())
        .ok_or_else(|| "Serveur SMTP non configuré pour ce compte.".to_string())
}

fn smtp_transport(acc: &MailAccount, cfg: &ServerConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let host = cfg.host.trim();
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(cfg.port)
        .timeout(Some(Duration::from_secs(60)));
    if cfg.security != Security::None {
        let mut tp = TlsParameters::builder(host.to_string());
        if acc.accept_invalid_certs && is_local_host(host) {
            tp = tp.dangerous_accept_invalid_certs(true);
        }
        let params = tp.build().map_err(|e| format!("Configuration TLS SMTP invalide : {e}"))?;
        builder = builder.tls(if cfg.security == Security::Ssl { Tls::Wrapper(params) } else { Tls::Required(params) });
    }
    if !cfg.username.trim().is_empty() {
        builder = builder.credentials(Credentials::new(cfg.username.trim().to_string(), cfg.password.clone()));
    }
    Ok(builder.build())
}

fn smtp_err(e: &lettre::transport::smtp::Error) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if e.is_permanent() && (s.contains("535") || s.contains("534") || low.contains("auth")) {
        "Identifiants SMTP refusés — vérifie le mot de passe (ou le mot de passe d'application) et que l'envoi SMTP authentifié est activé.".into()
    } else if e.is_timeout() {
        "Le serveur SMTP ne répond pas (délai dépassé).".into()
    } else if e.is_tls() {
        format!("Échec de la connexion sécurisée SMTP : {s}. Vérifie le port et le mode (SSL/TLS = 465, STARTTLS = 587).")
    } else if e.is_permanent() {
        format!("Envoi refusé par le serveur SMTP : {s}")
    } else if e.is_transient() {
        format!("Erreur temporaire du serveur SMTP, réessaie dans un instant : {s}")
    } else if low.contains("connection") || low.contains("lookup") || low.contains("refused") {
        format!("Impossible de joindre le serveur SMTP : {s}")
    } else {
        format!("Échec de l'envoi : {s}")
    }
}

fn mailbox_of(a: &Addr) -> Result<Mailbox, String> {
    let email: lettre::Address = a
        .email
        .trim()
        .parse()
        .map_err(|_| format!("Adresse e-mail invalide : {}", a.email.trim()))?;
    let name = a
        .name
        .as_ref()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    Ok(Mailbox::new(name, email))
}

fn content_type_of(mime: &str) -> ContentType {
    ContentType::parse(mime.trim())
        .or_else(|_| ContentType::parse("application/octet-stream"))
        .unwrap_or(ContentType::TEXT_PLAIN)
}

enum Body {
    Single(SinglePart),
    Multi(MultiPart),
}

fn build_body(m: &OutgoingMessage) -> Result<Body, String> {
    let mut total = 0usize;
    let mut decoded: Vec<(&OutAttachment, Vec<u8>)> = Vec::new();
    for a in &m.attachments {
        let bytes = B64
            .decode(a.data.trim())
            .map_err(|_| format!("Pièce jointe illisible : {}", a.name))?;
        total += bytes.len();
        decoded.push((a, bytes));
    }
    if total > MAX_SEND_BYTES {
        return Err("Pièces jointes trop lourdes (25 Mo maximum au total).".into());
    }
    let is_inline = |a: &OutAttachment| a.inline && a.content_id.as_ref().map(|c| !c.trim().is_empty()).unwrap_or(false);
    let text_part = SinglePart::plain(m.text.clone());
    let core = match &m.html {
        Some(html) if !html.trim().is_empty() => {
            let html_part = SinglePart::html(html.clone());
            let inline: Vec<&(&OutAttachment, Vec<u8>)> = decoded.iter().filter(|(a, _)| is_inline(a)).collect();
            if inline.is_empty() {
                Body::Multi(MultiPart::alternative().singlepart(text_part).singlepart(html_part))
            } else {
                let mut related = MultiPart::related().singlepart(html_part);
                for (a, bytes) in inline {
                    let cid = strip_angle(a.content_id.as_deref().unwrap_or_default());
                    related = related.singlepart(
                        Attachment::new_inline_with_name(cid, sanitize_filename(&a.name)).body(bytes.clone(), content_type_of(&a.mime)),
                    );
                }
                Body::Multi(MultiPart::alternative().singlepart(text_part).multipart(related))
            }
        }
        _ => Body::Single(text_part),
    };
    let regular: Vec<&(&OutAttachment, Vec<u8>)> = decoded.iter().filter(|(a, _)| !is_inline(a)).collect();
    if regular.is_empty() {
        return Ok(core);
    }
    let mut mixed = match core {
        Body::Single(p) => MultiPart::mixed().singlepart(p),
        Body::Multi(mp) => MultiPart::mixed().multipart(mp),
    };
    for (a, bytes) in regular {
        let mime = if a.mime.trim().is_empty() {
            mime_guess::from_path(&a.name).first_or_octet_stream().to_string()
        } else {
            a.mime.clone()
        };
        mixed = mixed.singlepart(Attachment::new(sanitize_filename(&a.name)).body(bytes.clone(), content_type_of(&mime)));
    }
    Ok(Body::Multi(mixed))
}

fn build_email(m: &OutgoingMessage) -> Result<(Message, String), String> {
    if m.to.is_empty() && m.cc.is_empty() && m.bcc.is_empty() {
        return Err("Ajoute au moins un destinataire.".into());
    }
    let domain = m
        .from
        .email
        .rsplit('@')
        .next()
        .filter(|d| !d.is_empty() && d.contains('.'))
        .unwrap_or("prisme.local")
        .trim()
        .to_string();
    let message_id = format!("{}@{}", uuid::Uuid::new_v4(), domain);
    let mut b = Message::builder()
        .from(mailbox_of(&m.from)?)
        .subject(m.subject.clone())
        .message_id(Some(format!("<{message_id}>")))
        .user_agent("Prisme".to_string());
    if let Some(rt) = &m.reply_to {
        b = b.reply_to(mailbox_of(rt)?);
    }
    for a in &m.to {
        b = b.to(mailbox_of(a)?);
    }
    for a in &m.cc {
        b = b.cc(mailbox_of(a)?);
    }
    for a in &m.bcc {
        b = b.bcc(mailbox_of(a)?);
    }
    if let Some(irt) = m.in_reply_to.as_ref().filter(|s| !s.trim().is_empty()) {
        b = b.in_reply_to(angle(irt));
    }
    let refs: Vec<String> = m.references.iter().filter(|r| !r.trim().is_empty()).map(|r| angle(r)).collect();
    if !refs.is_empty() {
        b = b.references(refs.join(" "));
    }
    let email = match build_body(m)? {
        Body::Single(p) => b.singlepart(p),
        Body::Multi(mp) => b.multipart(mp),
    }
    .map_err(|e| format!("Message invalide : {e}"))?;
    Ok((email, message_id))
}

/// Teste la connexion SMTP (connexion + authentification).
#[tauri::command]
pub async fn mail_smtp_test(account: MailAccount) -> Result<String, String> {
    let cfg = smtp_cfg(&account)?;
    let transport = smtp_transport(&account, cfg)?;
    match timeout(Duration::from_secs(60), transport.test_connection()).await {
        Err(_) => Err("Le serveur SMTP ne répond pas (délai dépassé).".into()),
        Ok(Err(e)) => Err(smtp_err(&e)),
        Ok(Ok(true)) => Ok(format!("Connexion SMTP réussie ({}:{}).", cfg.host.trim(), cfg.port)),
        Ok(Ok(false)) => Err("Le serveur SMTP n'a pas accepté la connexion.".into()),
    }
}

/// Envoie un message (multipart HTML + texte + pièces jointes, In-Reply-To/References).
/// Appelé uniquement après un clic explicite « Envoyer » confirmé par l'utilisateur.
#[tauri::command]
pub async fn mail_smtp_send(account: MailAccount, message: OutgoingMessage) -> Result<SendResult, String> {
    let cfg = smtp_cfg(&account)?;
    let transport = smtp_transport(&account, cfg)?;
    let (email, message_id) = build_email(&message)?;
    let raw = email.formatted();
    match timeout(Duration::from_secs(180), transport.send(email)).await {
        Err(_) => Err("Le serveur SMTP ne répond pas (délai dépassé) — le message n'a peut-être pas été envoyé.".into()),
        Ok(Err(e)) => Err(smtp_err(&e)),
        Ok(Ok(_)) => Ok(SendResult { message_id, raw: B64.encode(raw) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutf7_roundtrip() {
        assert_eq!(decode_mutf7("&AMk-l&AOk-ments envoy&AOk-s"), "Éléments envoyés");
        assert_eq!(decode_mutf7("Foo &- Bar"), "Foo & Bar");
        assert_eq!(encode_mutf7("Éléments envoyés"), "&AMk-l&AOk-ments envoy&AOk-s");
        assert_eq!(encode_mutf7("A&B"), "A&-B");
        for s in ["Brouillons", "日本語", "Courrier indésirable", "Reçus 🧾"] {
            assert_eq!(decode_mutf7(&encode_mutf7(s)), s);
        }
    }

    #[test]
    fn header_parsing() {
        let raw = b"From: =?UTF-8?Q?Ren=C3=A9e?= <renee@example.com>\r\nTo: a@b.fr, \"C, D\" <cd@e.fr>\r\nSubject: =?UTF-8?B?UHJvcG9zaXRpb24gZOKAmXTDqQ==?=\r\nMessage-ID: <abc@x>\r\nIn-Reply-To: <p1@x>\r\nReferences: <p0@x> <p1@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBonjour\r\n  le monde\r\n";
        let msg = MessageParser::default().parse(&raw[..]);
        let h = build_header(7, msg.as_ref(), vec!["\\Seen".into()], 10, None);
        assert_eq!(h.subject, "Proposition d’té");
        assert_eq!(h.from.as_ref().map(|a| a.email.as_str()), Some("renee@example.com"));
        assert_eq!(h.from.as_ref().and_then(|a| a.name.clone()).as_deref(), Some("Renée"));
        assert_eq!(h.to.len(), 2);
        assert_eq!(h.message_id.as_deref(), Some("abc@x"));
        assert_eq!(h.in_reply_to.as_deref(), Some("p1@x"));
        assert_eq!(h.references, vec!["p0@x".to_string(), "p1@x".to_string()]);
        assert!(h.seen);
        assert_eq!(h.snippet, "Bonjour le monde");
    }

    #[test]
    fn builds_reply_with_attachment() {
        let m = OutgoingMessage {
            from: Addr { name: Some("Moi".into()), email: "moi@exemple.fr".into() },
            to: vec![Addr { name: None, email: "toi@exemple.fr".into() }],
            cc: vec![],
            bcc: vec![],
            reply_to: None,
            subject: "Re: Été".into(),
            text: "Salut".into(),
            html: Some("<p>Salut</p>".into()),
            in_reply_to: Some("orig@x".into()),
            references: vec!["root@x".into(), "<orig@x>".into()],
            attachments: vec![OutAttachment { name: "a.txt".into(), mime: "text/plain".into(), data: B64.encode("coucou"), content_id: None, inline: false }],
        };
        let (email, id) = build_email(&m).expect("message");
        let raw = String::from_utf8(email.formatted()).unwrap();
        assert!(id.ends_with("@exemple.fr"));
        assert!(raw.contains("In-Reply-To: <orig@x>"));
        assert!(raw.contains("References: <root@x> <orig@x>"));
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("multipart/alternative"));
    }
}
