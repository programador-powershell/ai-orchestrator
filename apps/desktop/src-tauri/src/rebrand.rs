//! Migração do rebranding — o dado do usuário atravessa a troca de nome.
//!
//! O produto já se chamou "AI Orchestrator" (até a 0.10) e "Multiplike-AI"
//! (0.11). O nome atual é "AI-BOT", e a migração conhece as gerações
//! anteriores: quem vem da 0.11 migra de Multiplike-AI; quem nunca saiu da
//! 0.10 migra direto de AI Orchestrator. ("AI-Orchestrator", com hífen, foi um
//! nome de transição que nunca chegou a uma release — não há dado sob ele para
//! migrar.) A troca alcança coisas que NÃO são cosmética: o nome do
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

/// Nomes antigos do produto, do MAIS recente para o mais velho. A ordem
/// importa: quem atualizou 0.10 → 0.11 tem os dados sob o nome do meio, e
/// migrar primeiro o mais velho deixaria a geração intermediária para trás.
pub const SERVICOS_ANTIGOS: [&str; 2] = ["Multiplike-AI", "AI Orchestrator"];
/// Compatibilidade com quem consulta um único legado (o mais recente).
pub const SERVICO_ANTIGO: &str = SERVICOS_ANTIGOS[0];
/// Nome atual.
pub const SERVICO: &str = "AI-BOT";

/// Identifiers antigos, na mesma ordem dos serviços: a geração 0.11 e a 0.10.
const IDENTIFIERS_ANTIGOS: [&str; 2] = ["com.multiplike.desktop", "com.aiorchestrator.desktop"];
const IDENTIFIER: &str = "com.aibot.desktop";

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

    // Do legado mais RECENTE para o mais velho: se os dois existirem, vale o
    // mais novo (é o que a pessoa estava usando); o renomear seguinte encontra
    // o destino ocupado e não sobrescreve nada.
    for antigo in SERVICOS_ANTIGOS {
        // Roaming (%APPDATA%): memória, política e o banco dos runs.
        tentar(
            dirs::data_dir(),
            antigo,
            SERVICO,
            "dados (memória, política, runs)",
        );
        // Local (%LOCALAPPDATA%): runtimes, modelos GGUF e extensões.
        tentar(
            dirs::data_local_dir(),
            antigo,
            SERVICO,
            "runtime (modelos e extensões)",
        );
    }
    // A origem do webview — conversas, configurações, tema, tudo o que vive
    // no localStorage.
    for antigo in IDENTIFIERS_ANTIGOS {
        tentar(
            dirs::data_local_dir(),
            antigo,
            IDENTIFIER,
            "conversas e configurações",
        );
    }

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

    // Tenta cada geração de nome, da mais recente para a mais velha.
    let (antiga, valor) = SERVICOS_ANTIGOS.iter().find_map(|servico| {
        let entrada = keyring::Entry::new(servico, conta).ok()?;
        let valor = entrada.get_password().ok()?;
        Some((entrada, valor))
    })?;

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
