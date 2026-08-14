use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 2_000;
const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBundle {
    name: String,
    format: String,
    version: Option<String>,
    source_path: String,
    skills: Vec<String>,
    agents: Vec<String>,
    artifacts: Vec<String>,
    has_mcp: bool,
    compatible: bool,
    warnings: Vec<String>,
}

#[derive(Default)]
struct Scan {
    files: Vec<PathBuf>,
    bytes: u64,
}

fn scan_dir(root: &Path, current: &Path, scan: &mut Scan) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "links simbólicos não são aceitos: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            scan_dir(root, &path, scan)?;
        } else if metadata.is_file() {
            scan.bytes = scan.bytes.saturating_add(metadata.len());
            scan.files.push(
                path.strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_path_buf(),
            );
            if scan.files.len() > MAX_FILES || scan.bytes > MAX_BYTES {
                return Err("pacote excede o limite seguro de 2.000 arquivos ou 128 MB".into());
            }
        }
    }
    Ok(())
}

fn manifest_value(path: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn manifest_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(str::to_owned)
}

fn display_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn inspect(path: &Path) -> Result<ExtensionBundle, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("caminho não encontrado: {}", path.display()))?;
    let (root, standalone_skill) = if canonical.is_file() {
        let is_skill = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"));
        (
            canonical
                .parent()
                .ok_or("SKILL.md sem pasta pai")?
                .to_path_buf(),
            is_skill,
        )
    } else {
        (canonical.clone(), false)
    };
    let openai_manifest = root.join(".codex-plugin").join("plugin.json");
    let anthropic_manifest = root.join(".claude-plugin").join("plugin.json");
    let (format, manifest) = if openai_manifest.is_file() {
        ("openai-plugin", manifest_value(&openai_manifest))
    } else if anthropic_manifest.is_file() {
        ("anthropic-plugin", manifest_value(&anthropic_manifest))
    } else if standalone_skill || root.join("SKILL.md").is_file() || root.join("skills").is_dir() {
        ("agent-skill", None)
    } else {
        ("artifact-bundle", None)
    };

    let mut scan = Scan::default();
    scan_dir(&root, &root, &mut scan)?;
    let mut skills = Vec::new();
    let mut agents = Vec::new();
    let mut artifacts = Vec::new();
    let mut has_mcp = false;
    for relative in &scan.files {
        let normalized = display_relative(relative);
        let lower = normalized.to_ascii_lowercase();
        if lower == "skill.md" || (lower.starts_with("skills/") && lower.ends_with("/skill.md")) {
            skills.push(normalized.clone());
        }
        if lower.starts_with("agents/") && lower.ends_with(".md") {
            agents.push(normalized.clone());
        }
        if lower == ".mcp.json" || lower.ends_with("/.mcp.json") || lower.ends_with(".app.json") {
            has_mcp = true;
        }
        if ["artifacts/", "assets/", "templates/", "references/"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        {
            artifacts.push(normalized);
        }
    }
    let fallback_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("extension")
        .to_owned();
    let name = manifest
        .as_ref()
        .and_then(|value| manifest_string(value, "name"))
        .unwrap_or(fallback_name);
    let version = manifest
        .as_ref()
        .and_then(|value| manifest_string(value, "version"));
    let mut warnings = Vec::new();
    if skills.is_empty() && agents.is_empty() && artifacts.is_empty() {
        warnings.push("nenhum skill, agent ou artifact reconhecido".into());
    }
    if has_mcp {
        warnings
            .push("configurações MCP exigem revisão e aprovação antes de serem ativadas".into());
    }
    Ok(ExtensionBundle {
        name,
        format: format.into(),
        version,
        source_path: root.to_string_lossy().into_owned(),
        skills,
        agents,
        artifacts,
        has_mcp,
        compatible: true,
        warnings,
    })
}

fn safe_name(value: &str) -> String {
    let result: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = result.trim_matches(['-', '.']).to_owned();
    if trimmed.is_empty() {
        "extension".into()
    } else {
        trimmed
    }
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let target = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "links simbólicos não são aceitos: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            copy_tree(&path, &target)?;
        } else if metadata.is_file() {
            fs::copy(&path, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn extension_inspect(path: String) -> Result<ExtensionBundle, String> {
    inspect(Path::new(path.trim()))
}

#[tauri::command]
pub fn extension_import(path: String) -> Result<ExtensionBundle, String> {
    let bundle = inspect(Path::new(path.trim()))?;
    let source = PathBuf::from(&bundle.source_path);
    let destination = dirs::data_local_dir()
        .ok_or("LOCALAPPDATA indisponível")?
        .join("Multiplike-AI")
        .join("Extensions")
        .join(safe_name(&bundle.name));
    if destination.exists() {
        return Err(format!("a extensão {} já foi importada", bundle.name));
    }
    copy_tree(&source, &destination)?;
    inspect(&destination)
}

#[tauri::command]
pub fn extension_list() -> Result<Vec<ExtensionBundle>, String> {
    let root = dirs::data_local_dir()
        .ok_or("LOCALAPPDATA indisponível")?
        .join("Multiplike-AI")
        .join("Extensions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut bundles = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().is_dir() {
            bundles.push(inspect(&entry.path())?);
        }
    }
    Ok(bundles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_openai_and_anthropic_layouts() {
        let root = std::env::temp_dir().join(format!("ao-extension-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(root.join("skills/reviewer")).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"review-suite","version":"1.2.0"}"#,
        )
        .unwrap();
        fs::write(
            root.join("skills/reviewer/SKILL.md"),
            "---\nname: reviewer\n---",
        )
        .unwrap();
        let bundle = inspect(&root).unwrap();
        assert_eq!(bundle.format, "openai-plugin");
        assert_eq!(bundle.name, "review-suite");
        assert_eq!(bundle.skills.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
