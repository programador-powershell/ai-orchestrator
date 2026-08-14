//! Migração do rebranding — o dado do usuário atravessa a troca de nome.
//!
//! A versão 0.11.0 renomeou o produto de "AI Orchestrator" para
//! "Multiplike-AI". A troca alcançou coisas que NÃO são cosmética: o nome do
//! serviço no cofre do sistema operacional, os diretórios de dados e o
//! `identifier` do Tauri. Cada uma dessas é uma chave de busca — mudá-la sem
//! mais nada não apaga nada, e é justamente por isso que engana: o arquivo
//! continua no disco, a credencial continua no cofre, e o app simplesmente não
//! olha mais para lá.
//!
//! Sem este módulo, quem atualizasse encontraria:
//!
//! - **conversas, configurações e tema zerados.** No Windows o Tauri põe os
//!   dados do WebView2 em `%LOCALAPPDATA%\<identifier>`. Trocar o identifier
//!   move a origem física inteira, então preservar as CHAVES do
//!   `localStorage` (`orchestrator.v2`, `aio.*`) não adiantou nada — elas
//!   ficaram num armazenamento que ninguém mais abre.
//! - **chaves de API "desaparecidas".** Continuam no Gerenciador de
//!   Credenciais, sob o serviço antigo.
//! - **modelos GGUF baixados de novo.** São gigabytes, na pasta antiga.
//! - **memória, política e runtimes** idem.
//!
//! ## Como
//!
//! Diretório: RENOMEIA o antigo para o novo, e só quando o novo ainda não
//! existe. Renomear é atômico dentro do mesmo volume e não duplica gigabyte de
//! modelo; a condição garante que uma segunda execução (ou uma instalação
//! nova que já criou a pasta) não sobrescreva nada.
//!
//! Cofre: não dá para listar entradas de forma portável, então a migração é
//! PREGUIÇOSA — ver [`segredo_com_fallback`]. Quem lê tenta o nome novo,
//! cai para o antigo, e ao achar regrava sob o novo e apaga o velho.
//!
//! ## Prazo
//!
//! Isto é ponte, não moradia. Some quando não houver mais instalação anterior
//! a 0.11.0 no parque — até lá, remover é reintroduzir a perda.

use std::path::PathBuf;

/// Nome antigo do produto, usado em pasta e no cofre até a 0.10.
pub const SERVICO_ANTIGO: &str = "AI Orchestrator";
/// Nome atual.
pub const SERVICO: &str = "Multiplike-AI";

const IDENTIFIER_ANTIGO: &str = "com.aiorchestrator.desktop";
const IDENTIFIER: &str = "com.multiplike.desktop";

/// Renomeia `antigo` para `novo` quando faz sentido. Devolve `true` se migrou.
///
/// Silencioso de propósito em todo caso que não é migração: pasta antiga
/// inexistente (instalação nova), pasta nova já existente (já migrou, ou o app
/// rodou antes desta versão). Falha de E/S também não interrompe o boot — o
/// pior resultado é o estado de hoje, que é o app subir com dados vazios.
fn renomear(antigo: PathBuf, novo: PathBuf) -> bool {
    if !antigo.is_dir() || novo.exists() {
        return false;
    }
    if let Some(pai) = novo.parent() {
        if !pai.exists() && std::fs::create_dir_all(pai).is_err() {
            return false;
        }
    }
    std::fs::rename(&antigo, &novo).is_ok()
}

/// Roda a migração de diretórios. Chamada uma vez, no início de `run()`.
///
/// **Precisa acontecer antes de o webview nascer**: a pasta do WebView2 é
/// criada na inicialização da janela, e renomear depois encontraria o destino
/// já existente (e portanto não migraria nada).
pub fn migrar_diretorios() -> Vec<String> {
    let mut migrados = Vec::new();

    let mut tentar = |base: Option<PathBuf>, de: &str, para: &str, rotulo: &str| {
        if let Some(raiz) = base {
            if renomear(raiz.join(de), raiz.join(para)) {
                migrados.push(rotulo.to_string());
            }
        }
    };

    // Roaming (%APPDATA%): memória, política e o banco dos runs.
    tentar(
        dirs::data_dir(),
        SERVICO_ANTIGO,
        SERVICO,
        "dados (memória, política, runs)",
    );
    // Local (%LOCALAPPDATA%): runtimes, modelos GGUF e extensões.
    tentar(
        dirs::data_local_dir(),
        SERVICO_ANTIGO,
        SERVICO,
        "runtime (modelos e extensões)",
    );
    // A origem do webview — conversas, configurações, tema, tudo o que vive
    // no localStorage.
    tentar(
        dirs::data_local_dir(),
        IDENTIFIER_ANTIGO,
        IDENTIFIER,
        "conversas e configurações",
    );

    migrados
}

/// Lê um segredo do cofre tentando o nome NOVO e caindo para o antigo.
///
/// Ao achar sob o nome antigo, regrava sob o novo e apaga o velho — assim a
/// conversão acontece uma vez por conta, no primeiro uso, sem precisar listar
/// o cofre (o que a `keyring` não oferece de forma portável).
///
/// Devolve `None` quando não existe em nenhum dos dois, que é o mesmo que a
/// chamada direta devolveria.
pub fn segredo_com_fallback(conta: &str) -> Option<String> {
    if let Ok(entrada) = keyring::Entry::new(SERVICO, conta) {
        if let Ok(valor) = entrada.get_password() {
            return Some(valor);
        }
    }

    let antiga = keyring::Entry::new(SERVICO_ANTIGO, conta).ok()?;
    let valor = antiga.get_password().ok()?;

    // Regrava sob o nome novo. Se falhar, ainda devolvemos o valor: ler é o
    // que o chamador pediu, e uma migração malsucedida não deve virar
    // "credencial não encontrada".
    if let Ok(nova) = keyring::Entry::new(SERVICO, conta) {
        if nova.set_password(&valor).is_ok() {
            let _ = antiga.delete_credential();
        }
    }
    Some(valor)
}

/// Só para o teste: expõe a regra de `renomear` sem tocar no cofre.
#[cfg(test)]
pub(crate) fn renomear_para_teste(antigo: &std::path::Path, novo: &std::path::Path) -> bool {
    renomear(antigo.to_path_buf(), novo.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporaria(nome: &str) -> PathBuf {
        let raiz = std::env::temp_dir().join(format!("multiplike-rebrand-{nome}"));
        let _ = std::fs::remove_dir_all(&raiz);
        std::fs::create_dir_all(&raiz).expect("criar raiz de teste");
        raiz
    }

    #[test]
    fn renomeia_quando_so_a_antiga_existe() {
        let raiz = temporaria("simples");
        let antiga = raiz.join(SERVICO_ANTIGO);
        let nova = raiz.join(SERVICO);
        std::fs::create_dir_all(antiga.join("Runtime")).unwrap();
        std::fs::write(antiga.join("memory.db"), b"dados").unwrap();

        assert!(renomear_para_teste(&antiga, &nova));
        assert!(!antiga.exists());
        assert_eq!(std::fs::read(nova.join("memory.db")).unwrap(), b"dados");
        assert!(nova.join("Runtime").is_dir());
    }

    #[test]
    fn nao_toca_quando_a_nova_ja_existe() {
        // Cenário real: o app já rodou nesta versão e criou a pasta. Migrar
        // aqui sobrescreveria o estado atual com o de antes da atualização.
        let raiz = temporaria("ja-existe");
        let antiga = raiz.join(SERVICO_ANTIGO);
        let nova = raiz.join(SERVICO);
        std::fs::create_dir_all(&antiga).unwrap();
        std::fs::create_dir_all(&nova).unwrap();
        std::fs::write(nova.join("memory.db"), b"atual").unwrap();

        assert!(!renomear_para_teste(&antiga, &nova));
        assert_eq!(std::fs::read(nova.join("memory.db")).unwrap(), b"atual");
        assert!(antiga.exists(), "a antiga fica para inspeção manual");
    }

    #[test]
    fn instalacao_nova_nao_migra_nada() {
        let raiz = temporaria("nova");
        assert!(!renomear_para_teste(
            &raiz.join(SERVICO_ANTIGO),
            &raiz.join(SERVICO)
        ));
    }

    #[test]
    fn rodar_duas_vezes_e_inofensivo() {
        let raiz = temporaria("idempotente");
        let antiga = raiz.join(SERVICO_ANTIGO);
        let nova = raiz.join(SERVICO);
        std::fs::create_dir_all(&antiga).unwrap();
        std::fs::write(antiga.join("policy.json"), b"{}").unwrap();

        assert!(renomear_para_teste(&antiga, &nova));
        assert!(!renomear_para_teste(&antiga, &nova));
        assert!(nova.join("policy.json").exists());
    }

    #[test]
    fn arquivo_no_lugar_da_pasta_antiga_nao_migra() {
        let raiz = temporaria("arquivo");
        let antiga = raiz.join(SERVICO_ANTIGO);
        std::fs::write(&antiga, b"nao sou pasta").unwrap();
        assert!(!renomear_para_teste(&antiga, &raiz.join(SERVICO)));
    }
}
