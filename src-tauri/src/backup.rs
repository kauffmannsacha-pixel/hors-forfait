// Sauvegarde quotidienne de la base SQLite (prisme.db) : une copie par jour, 14 conservées.
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const KEEP: usize = 14;

/// Emplacements possibles de prisme.db (tauri-plugin-sql v2 le place dans app_config_dir).
fn db_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let p = app.path();
    [p.app_config_dir().ok(), p.app_data_dir().ok()]
        .into_iter()
        .flatten()
        .map(|d| d.join("prisme.db"))
        .collect()
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Impossible de créer le dossier de sauvegarde : {e}"))?;
    Ok(dir)
}

fn prune(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
        .collect();
    files.sort();
    if files.len() > KEEP {
        for old in &files[..files.len() - KEEP] {
            let _ = std::fs::remove_file(old);
        }
    }
}

/// Crée la sauvegarde du jour si elle n'existe pas encore. Renvoie le chemin.
fn backup_today(app: &AppHandle, force: bool) -> Result<Option<String>, String> {
    let Some(src) = db_candidates(app).into_iter().find(|p| p.exists()) else {
        return Ok(None);
    };
    let dir = backups_dir(app)?;
    let name = format!("prisme-{}.db", chrono::Local::now().format("%Y-%m-%d"));
    let dest = dir.join(name);
    if dest.exists() && !force {
        return Ok(Some(dest.to_string_lossy().into_owned()));
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("Sauvegarde impossible : {e}"))?;
    // Fichiers WAL éventuels : on les copie aussi pour une sauvegarde cohérente.
    for ext in ["db-wal", "db-shm"] {
        let side = src.with_extension(ext);
        if side.exists() {
            let _ = std::fs::copy(&side, dest.with_extension(ext));
        }
    }
    prune(&dir);
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Lance la sauvegarde au démarrage puis toutes les heures (une seule copie par jour).
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if let Err(e) = backup_today(&app, false) {
                eprintln!("[sauvegarde] {e}");
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

#[tauri::command]
pub fn backup_now(app: AppHandle) -> Result<Option<String>, String> {
    backup_today(&app, true)
}

#[tauri::command]
pub fn backup_list(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = backups_dir(&app)?;
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    v.sort();
    v.reverse();
    Ok(v)
}
