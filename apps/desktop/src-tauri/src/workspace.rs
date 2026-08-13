//! Área de trabalho do agente — o "computer use" confinado.
//!
//! Para um agente operar a máquina ele precisa de continuidade: escrever um
//! script, rodá-lo, ler a saída, corrigir e rodar de novo. O `sandbox_execute`
//! sozinho não serve para isso — ele cria um diretório efêmero e o APAGA a
//! cada chamada, então nada sobrevive de um passo para o outro.
//!
//! Aqui existe uma SESSÃO: um diretório criado uma vez, reaproveitado entre
//! chamadas e removido ao fechar. Todas as operações de arquivo do agente são
//! confinadas a ele.
//!
//! ## O buraco que este módulo fecha
//!
//! `sandbox_execute` aceita um `cwd` arbitrário do chamador. Para uma pessoa
//! clicando no painel isso é uma escolha; para um AGENTE seria uma porta
//! aberta — bastaria pedir `cwd: "C:\Users\<você>"` para sair da caixa. Por
//! isso o agente nunca recebe um caminho: ele recebe um **id de sessão**, e é
//! este módulo que resolve o caminho real.
//!
//! ## O que isto NÃO é
//!
//! Confinamento de CAMINHO, não de privilégio. O processo continua com o token
//! do usuário — some com o `..`, mas não com os direitos de quem executa. Um
//! comando dentro da sessão ainda alcança a rede e, se souber um caminho
//! absoluto, ainda o lê pelo shell. O que garante o encerramento é o Job
//! Object (jail.rs); o que garante o não-vazamento por caminho relativo é
//! `resolve_inside` aqui.

use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// Teto do arquivo que o agente escreve — evita encher o disco por engano.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
/// Teto de leitura devolvida ao modelo.
const MAX_READ_BYTES: usize = 200 * 1024;
/// Sessões simultâneas. Mais que isso é sinal de vazamento, não de uso.
const MAX_SESSIONS: usize = 8;

fn sessions() -> &'static Mutex<HashMap<String, PathBuf>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSession {
    id: String,
    /// Caminho só para EXIBIÇÃO na UI; o agente nunca o recebe.
    display_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

/// Resolve um caminho relativo DENTRO da base, recusando qualquer fuga.
///
/// Recusa em três frentes, porque cada uma sozinha tem furo:
/// - componentes `..` e raiz/prefixo (`C:\`, `\`) são rejeitados no texto;
/// - o pai é canonicalizado e comparado com a base — pega link simbólico
///   apontando para fora, que a checagem textual não veria;
/// - o arquivo pode não existir ainda (é uma escrita), então canonicaliza-se
///   o diretório pai, não o alvo.
pub(crate) fn resolve_inside(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative);
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err("caminho não pode subir de diretório (..)".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("caminho precisa ser relativo à sessão".into())
            }
        }
    }
    let target = base.join(candidate);
    let parent = target.parent().unwrap_or(base);
    // O pai precisa existir para ser canonicalizado; criar aqui é o esperado
    // numa escrita em subpasta nova.
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let real_parent = parent
        .canonicalize()
        .map_err(|_| "caminho inválido dentro da sessão".to_string())?;
    let real_base = base
        .canonicalize()
        .map_err(|_| "sessão da sandbox não existe mais".to_string())?;
    if !real_parent.starts_with(&real_base) {
        return Err("caminho aponta para fora da sessão".into());
    }
    Ok(real_parent.join(target.file_name().unwrap_or_default()))
}

/// Caminho da sessão, ou erro se o id não existe (ou já foi fechada).
pub(crate) fn session_path(id: &str) -> Result<PathBuf, String> {
    sessions()
        .lock()
        .map_err(|_| "registro de sessões indisponível".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "sessão da sandbox não existe (abra uma antes)".to_string())
}

#[tauri::command]
pub fn sandbox_open() -> Result<SandboxSession, String> {
    let mut guard = sessions()
        .lock()
        .map_err(|_| "registro de sessões indisponível".to_string())?;
    if guard.len() >= MAX_SESSIONS {
        return Err(format!(
            "já existem {MAX_SESSIONS} sessões abertas — feche alguma antes"
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = std::env::temp_dir().join(format!("ai-work-{id}"));
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    let display_path = path.to_string_lossy().into_owned();
    guard.insert(id.clone(), path);
    Ok(SandboxSession { id, display_path })
}

#[tauri::command]
pub fn sandbox_close(session: String) -> Result<(), String> {
    let path = {
        let mut guard = sessions()
            .lock()
            .map_err(|_| "registro de sessões indisponível".to_string())?;
        guard.remove(&session)
    };
    // Fechar sessão inexistente não é erro: fechar duas vezes é normal quando
    // o usuário para a execução e a UI também limpa.
    if let Some(path) = path {
        let _ = std::fs::remove_dir_all(path);
    }
    Ok(())
}

#[tauri::command]
pub fn sandbox_write(session: String, path: String, content: String) -> Result<String, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "conteúdo excede o limite de {} KB da sessão",
            MAX_WRITE_BYTES / 1024
        ));
    }
    let base = session_path(&session)?;
    let target = resolve_inside(&base, &path)?;
    std::fs::write(&target, content.as_bytes()).map_err(|error| error.to_string())?;
    Ok(format!("gravado: {path} ({} bytes)", content.len()))
}

#[tauri::command]
pub fn sandbox_read(session: String, path: String) -> Result<String, String> {
    let base = session_path(&session)?;
    let target = resolve_inside(&base, &path)?;
    let bytes = std::fs::read(&target).map_err(|_| format!("não foi possível ler {path}"))?;
    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    Ok(String::from_utf8_lossy(slice).into_owned())
}

#[tauri::command]
pub fn sandbox_list(session: String, sub: Option<String>) -> Result<Vec<SandboxEntry>, String> {
    let base = session_path(&session)?;
    let dir = match sub.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => resolve_inside(&base, value)?,
        None => base,
    };
    let mut entries: Vec<SandboxEntry> = std::fs::read_dir(&dir)
        .map_err(|_| "pasta não encontrada na sessão".to_string())?
        .filter_map(Result::ok)
        .map(|entry| {
            let meta = entry.metadata().ok();
            SandboxEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            }
        })
        .collect();
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_temporaria(nome: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("ai-work-test-{nome}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("criar base");
        path
    }

    #[test]
    fn aceita_caminho_relativo_simples() {
        let base = base_temporaria("simples");
        let alvo = resolve_inside(&base, "script.py").expect("deveria aceitar");
        assert!(alvo.starts_with(base.canonicalize().unwrap()));
        assert_eq!(alvo.file_name().unwrap(), "script.py");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cria_subpasta_que_ainda_nao_existe() {
        let base = base_temporaria("subpasta");
        let alvo = resolve_inside(&base, "src/lib/mod.rs").expect("deveria aceitar");
        assert!(alvo.parent().unwrap().exists(), "o pai deveria ter sido criado");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// O buraco principal: sem isto o agente sairia da caixa com `..`.
    #[test]
    fn recusa_subir_de_diretorio() {
        let base = base_temporaria("subir");
        for tentativa in ["../fora.txt", "a/../../fora.txt", "..\\fora.txt", "./../x"] {
            let erro = resolve_inside(&base, tentativa).unwrap_err();
            assert!(
                erro.contains("subir de diretório"),
                "esperava recusa de {tentativa}, veio: {erro}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn recusa_caminho_absoluto() {
        let base = base_temporaria("absoluto");
        for tentativa in ["C:\\Windows\\System32\\config\\sam", "\\servidor\\share\\x", "/etc/passwd"] {
            assert!(
                resolve_inside(&base, tentativa).is_err(),
                "deveria recusar {tentativa}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sessao_inexistente_nao_resolve() {
        let erro = session_path("id-que-nao-existe").unwrap_err();
        assert!(erro.contains("não existe"), "erro inesperado: {erro}");
    }

    #[test]
    fn abrir_e_fechar_remove_o_diretorio() {
        let sessao = sandbox_open().expect("abrir");
        let path = session_path(&sessao.id).expect("resolver");
        assert!(path.is_dir());
        sandbox_close(sessao.id.clone()).expect("fechar");
        assert!(!path.exists(), "o diretório deveria ter sido removido");
        // Fechar de novo não pode ser erro (UI e usuário podem fechar juntos).
        assert!(sandbox_close(sessao.id).is_ok());
    }

    #[test]
    fn escreve_e_le_dentro_da_sessao() {
        let sessao = sandbox_open().expect("abrir");
        sandbox_write(sessao.id.clone(), "nota.txt".into(), "olá".into()).expect("gravar");
        let lido = sandbox_read(sessao.id.clone(), "nota.txt".into()).expect("ler");
        assert_eq!(lido, "olá");
        let listado = sandbox_list(sessao.id.clone(), None).expect("listar");
        assert!(listado.iter().any(|entry| entry.name == "nota.txt"));
        sandbox_close(sessao.id).expect("fechar");
    }

    #[test]
    fn escrita_fora_da_sessao_e_recusada_antes_de_tocar_o_disco() {
        let sessao = sandbox_open().expect("abrir");
        let erro = sandbox_write(sessao.id.clone(), "../fuga.txt".into(), "x".into()).unwrap_err();
        assert!(erro.contains("subir de diretório"));
        let fora = std::env::temp_dir().join("fuga.txt");
        assert!(!fora.exists(), "não deveria ter criado nada fora");
        sandbox_close(sessao.id).expect("fechar");
    }

    #[test]
    fn conteudo_gigante_e_recusado() {
        let sessao = sandbox_open().expect("abrir");
        let gordo = "x".repeat(MAX_WRITE_BYTES + 1);
        assert!(sandbox_write(sessao.id.clone(), "g.txt".into(), gordo).is_err());
        sandbox_close(sessao.id).expect("fechar");
    }

    /// Continuidade é o motivo de a sessão existir: sem ela, o arquivo
    /// escrito no passo 1 não estaria lá no passo 2.
    #[test]
    fn arquivo_sobrevive_entre_chamadas() {
        let sessao = sandbox_open().expect("abrir");
        sandbox_write(sessao.id.clone(), "passo1.txt".into(), "estado".into()).expect("gravar");
        // outra chamada, mesma sessão
        let lido = sandbox_read(sessao.id.clone(), "passo1.txt".into()).expect("ler");
        assert_eq!(lido, "estado");
        sandbox_close(sessao.id).expect("fechar");
    }
}
