use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_READ_BYTES: u64 = 512 * 1024;
const IGNORED: [&str; 3] = ["node_modules", ".git", "target"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(root)
        .canonicalize()
        .map_err(|_| "raiz do workspace não encontrada".to_string())?;
    if !canonical.is_dir() {
        return Err("a raiz do workspace deve ser uma pasta".into());
    }
    Ok(canonical)
}

fn resolve_existing(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let canonical = canonical_root(root)?;
    let resolved = Path::new(root)
        .join(relative)
        .canonicalize()
        .map_err(|_| "caminho não encontrado".to_string())?;
    if !resolved.starts_with(&canonical) {
        return Err("fora da raiz".into());
    }
    Ok((canonical, resolved))
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[tauri::command]
pub fn fs_list(root: String, sub: String) -> Result<Vec<FsEntry>, String> {
    let (canonical, directory) = resolve_existing(&root, &sub)?;
    if !directory.is_dir() {
        return Err("o caminho informado não é uma pasta".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        entries.push(FsEntry {
            path: relative_display(&canonical, &entry.path()),
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            name,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn fs_read(root: String, path: String) -> Result<String, String> {
    let (_, file) = resolve_existing(&root, &path)?;
    if !file.is_file() {
        return Err("o caminho informado não é um arquivo".into());
    }
    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_READ_BYTES {
        return Err("arquivo excede o limite de leitura de 512 KB".into());
    }
    let bytes = fs::read(&file).map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn fs_write(root: String, path: String, content: String) -> Result<(), String> {
    let canonical = canonical_root(&root)?;
    let candidate = Path::new(&root).join(&path);
    let target = if candidate.exists() {
        let existing = candidate
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !existing.is_file() {
            return Err("o caminho informado não é um arquivo".into());
        }
        existing
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "caminho inválido".to_string())?
            .canonicalize()
            .map_err(|_| "pasta do arquivo não encontrada".to_string())?;
        let name = candidate
            .file_name()
            .ok_or_else(|| "caminho inválido".to_string())?;
        parent.join(name)
    };
    if !target.starts_with(&canonical) {
        return Err("fora da raiz".into());
    }
    // Symlink escapa da checagem acima: o caminho `raiz/link` está dentro da
    // raiz, mas `fs::write` segue o link e grava no alvo — que pode estar
    // fora. Com alvo INEXISTENTE (link pendurado) nem o `canonicalize` do
    // ramo de cima pega, porque ele nunca roda para arquivo novo.
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("o caminho é um link simbólico — gravação recusada".into());
        }
    }
    fs::write(&target, content).map_err(|error| error.to_string())
}
