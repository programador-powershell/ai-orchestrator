//! A sobreposição da interface — a TRILHA B de `docs/atualizacao.md`.
//!
//! O bundle web continua EMBUTIDO no binário (`frontendDist: "../dist"`), e ele
//! continua sendo o padrão. Este módulo acrescenta um caminho de sobreposição:
//! se existir uma interface baixada e verificada em `<app_data>/ui/current`, a
//! janela carrega DALI; se não existir — ou se o recibo não convencer —, carrega
//! do embutido, exatamente como antes.
//!
//! # Por que trocar o provedor de ASSETS e não a URL da janela
//!
//! A tentação é apontar a janela para outro lugar (`file://`, um servidor local,
//! um protocolo `aibot://` próprio). Todos os três mudam a ORIGEM da página, e a
//! origem é o que decide três coisas de uma vez neste app:
//!
//! 1. a CSP — ela é emitida pelo protocolo de asset do Tauri e ninguém mais;
//! 2. o `localStorage` — tema, barra lateral e avatares são gravados por origem,
//!    então "atualizei a interface" viraria "perdi minhas preferências";
//! 3. o `invoke()` — a permissão do IPC é resolvida por janela, mas a página só
//!    é considerada local em uma lista fechada de esquemas.
//!
//! Trocar o `Assets` do contexto (`Context::set_assets`) não mexe em nenhuma das
//! três: a página continua sendo `tauri://localhost`, o Tauri continua colando o
//! cabeçalho de CSP e calculando o mime, e o único ponto que muda é de ONDE os
//! bytes vêm. A `Overlay` abaixo tenta o disco e cai no embutido quando o disco
//! não tem o arquivo pedido — o que também dá, de graça, o comportamento certo
//! para um bundle parcial.
//!
//! # A CADEIA DE CONFIANÇA — leia antes de mexer
//!
//! ```text
//! instalador assinado (Authenticode + updater do Tauri)
//!   └─→ casca Rust                confia porque foi instalada
//!        └─→ aibotd, lançado do diretório de INSTALAÇÃO
//!             └─→ manifesto Ed25519, conferido com crypto/ed25519 do Go
//!                  └─→ dados, bundle da interface, próximo aibotd
//! ```
//!
//! **O Rust NÃO verifica assinatura nenhuma aqui, e isso é deliberado.** Ele
//! confia no recibo `.verified` porque confia em quem o escreveu — o `aibotd` —,
//! e confia no `aibotd` porque foi ELE quem o lançou, do próprio diretório de
//! instalação, que veio do instalador assinado (ver `gateway::find_binary`).
//! Quebrar qualquer elo dessa corrente quebra a garantia inteira: se um dia o
//! gateway passar a ser procurado em pasta gravável por terceiros, ou se o
//! recibo passar a ser aceito de outro lugar, este módulo deixa de ter base para
//! confiar em qualquer coisa e a verificação de assinatura precisa subir para cá.
//!
//! Registre também o que está em jogo: **o bundle da interface roda com acesso a
//! `invoke()`**. Ele alcança todos os comandos Tauri registrados — cofre do SO,
//! terminal, encerramento. Um bundle adulterado é uma máquina comprometida, no
//! mesmo grau que um instalador adulterado. Não existe "é só o front-end" aqui.
//!
//! # Rollback
//!
//! Atualização que não sabe voltar transforma um bug em um app que não abre. Por
//! isso a interface baixada precisa se apresentar: o front chama `ui_ready` no
//! primeiro render e, se isso não acontecer em `HEALTH_DEADLINE`, a pasta vira
//! `ui/quarantine-<hora>` e o app reinicia no embutido. O caso que isso salva é
//! justamente o que nenhum teste pega: um bundle que compila, baixa, confere o
//! sha256 e **estoura no primeiro import** — tela branca, sem console, sem
//! ninguém para ler o erro.

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{AppHandle, Assets, Context, Manager, Runtime};

/// Pasta das interfaces baixadas, dentro da pasta de dados do app.
const UI_DIR: &str = "ui";

/// A que está em uso. Nome fixo porque quem troca é o gateway, com um `rename`:
/// pasta nova ao lado, `rename` por cima, e nunca uma pasta meio escrita em uso.
const CURRENT_DIR: &str = "current";

/// O recibo que o `aibotd` escreve DEPOIS de conferir assinatura e sha256.
const RECEIPT_FILE: &str = ".verified";

/// O arquivo sem o qual não há interface nenhuma para servir.
const ENTRY_FILE: &str = "index.html";

/// Quanto a janela tem para dizer que abriu.
///
/// Vinte segundos é folgado de propósito: numa estação fria, com antivírus
/// inspecionando cada leitura, o primeiro render do React depois do boot do
/// WebView2 passa dos cinco segundos com facilidade. Curto demais aqui não
/// "protege mais" — só coloca em quarentena uma interface que estava boa.
pub const HEALTH_DEADLINE: Duration = Duration::from_secs(20);

/// A interface em uso, ou `None` para o embutido.
///
/// Estático porque o provedor de assets é consultado pelo Tauri de dentro do
/// protocolo, sem nenhum caminho para receber estado nosso — e porque a decisão
/// é do PROCESSO, não de uma janela. `RwLock` e não `OnceLock` porque a
/// quarentena precisa desligá-la em tempo de execução.
static ACTIVE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// A janela chamou `ui_ready`?
static UI_HEALTHY: AtomicBool = AtomicBool::new(false);

/// O recibo escrito pelo gateway.
///
/// Os campos são os do manifesto (ver `docs/atualizacao.md` e
/// `scripts/gerar-manifesto.mjs`): a versão publicada e o sha256 do artefato que
/// foi conferido em streaming durante a descompactação.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub version: String,
    pub sha256: String,
}

/* ------------------------------- a decisão ------------------------------- */

/// Escolhe entre a interface baixada e a embutida. Chamada UMA vez, no `setup`,
/// antes de qualquer janela existir.
///
/// Devolve o recibo quando a sobreposição entra em uso — é o que o chamador
/// registra no log e o sinal de que o relógio de rollback precisa ser armado.
/// `None` é o caminho normal: máquina que nunca recebeu atualização de interface.
pub fn choose(data_dir: &Path) -> Option<Receipt> {
    let current = data_dir.join(UI_DIR).join(CURRENT_DIR);
    if !current.exists() {
        return None;
    }

    match inspect(&current) {
        Ok(receipt) => {
            *ACTIVE.write().unwrap_or_else(PoisonError::into_inner) = Some(current);
            Some(receipt)
        }
        Err(reason) => {
            // Recusar em silêncio seria pior do que não ter a trilha B: a pessoa
            // veria a versão antiga sem nenhuma pista de por quê.
            eprintln!("[aibot] a interface baixada foi ignorada: {reason}");
            None
        }
    }
}

/// Confere o que precisa existir para a pasta ser servível.
///
/// A checagem é de INTEGRIDADE DE ESTRUTURA, não de autenticidade — quem
/// autentica é o gateway, antes de escrever o recibo (ver o cabeçalho). O que
/// esta função pega é o meio-termo perigoso: uma pasta escrita pela metade, um
/// recibo de outra coisa, um JSON truncado por falta de disco.
fn inspect(current: &Path) -> Result<Receipt, String> {
    if !current.join(ENTRY_FILE).is_file() {
        return Err(format!(
            "{} não tem {ENTRY_FILE}",
            current.display()
        ));
    }

    let receipt_path = current.join(RECEIPT_FILE);
    let raw = std::fs::read_to_string(&receipt_path).map_err(|error| {
        format!(
            "sem o recibo {}: {error}. Só o gateway escreve esse arquivo, e sem ele \
não há como saber que o bundle foi verificado",
            receipt_path.display()
        )
    })?;

    let receipt: Receipt = serde_json::from_str(&raw)
        .map_err(|error| format!("o recibo {} não é JSON válido: {error}", receipt_path.display()))?;

    if receipt.version.trim().is_empty() {
        return Err(format!("o recibo {} está sem versão", receipt_path.display()));
    }
    // Um sha256 é 64 dígitos hexadecimais. Não conferimos o hash do conteúdo
    // aqui (é o gateway quem confere, em streaming, enquanto baixa); o que se
    // recusa é um recibo que nem se parece com um recibo.
    if receipt.sha256.len() != 64 || !receipt.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "o recibo {} traz um sha256 que não é sha256: {:?}",
            receipt_path.display(),
            receipt.sha256
        ));
    }

    Ok(receipt)
}

/// A pasta em uso agora, se houver.
fn active_dir() -> Option<PathBuf> {
    ACTIVE
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// O arquivo do disco correspondente a uma chave de asset, ou `None`.
fn overlay_path(key: &AssetKey) -> Option<PathBuf> {
    let dir = active_dir()?;
    resolve_inside(&dir, key.as_ref())
}

/// Resolve a chave DENTRO da pasta, ou recusa.
///
/// A chave de asset vem da URL pedida pelo WebView e chega normalizada com raiz
/// (`/index.html`), mas `..` sobrevive à normalização — e a página que pede o
/// arquivo é justamente a que pode ter sido adulterada. Sem este confinamento,
/// `GET /../../../token` serviria o token do gateway para dentro do webview.
///
/// Duas camadas, de propósito: os componentes são conferidos ANTES de tocar o
/// disco (é o que barra `..` e caminho absoluto) e o resultado canonicalizado é
/// conferido DEPOIS (é o que barra um link simbólico apontando para fora).
fn resolve_inside(dir: &Path, key: &str) -> Option<PathBuf> {
    let mut candidate = dir.to_path_buf();
    for part in key.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        let mut components = Path::new(part).components();
        // Um pedaço legítimo é UM componente normal. `..`, `C:` e qualquer
        // outra forma de sair da pasta caem aqui.
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => candidate.push(name),
            _ => return None,
        }
    }

    let root = dir.canonicalize().ok()?;
    let full = candidate.canonicalize().ok()?;
    if !full.starts_with(&root) || !full.is_file() {
        return None;
    }
    Some(full)
}

/* ------------------------------ a quarentena ----------------------------- */

/// Tira a interface baixada de uso e a guarda para análise.
pub fn quarantine() -> Result<PathBuf, String> {
    let current = ACTIVE
        .write()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .ok_or_else(|| "não havia interface baixada em uso".to_string())?;
    quarantine_dir(&current)
}

/// Renomeia a pasta para `quarantine-<hora>`, ao lado da que estava em uso.
///
/// Guardar em vez de apagar é o que permite descobrir DEPOIS por que o bundle
/// não abriu — apagando, o defeito vira boato. O carimbo é o epoch em segundos
/// porque não há crate de data nesta camada e o que importa é ordenar, não
/// apresentar.
///
/// Se o `rename` falhar (no Windows, uma pasta com arquivo aberto recusa), o
/// plano B é APAGAR O RECIBO: sem ele a pasta não passa mais pelo `inspect` e a
/// próxima abertura cai no embutido de qualquer jeito. O que não pode acontecer
/// é a falha do `rename` deixar a interface quebrada em uso.
fn quarantine_dir(current: &Path) -> Result<PathBuf, String> {
    let parent = current
        .parent()
        .ok_or_else(|| format!("{} não tem pasta acima", current.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    let target = parent.join(format!("quarantine-{stamp}"));

    match std::fs::rename(current, &target) {
        Ok(()) => Ok(target),
        Err(error) => {
            let receipt = current.join(RECEIPT_FILE);
            let removed = std::fs::remove_file(&receipt).is_ok();
            Err(format!(
                "não foi possível mover {} para {}: {error}. {}",
                current.display(),
                target.display(),
                if removed {
                    "O recibo foi apagado, então a próxima abertura já usa a interface embutida."
                } else {
                    "O recibo TAMBÉM não pôde ser apagado — apague a pasta à mão."
                }
            ))
        }
    }
}

/* -------------------------- saúde e relógio ------------------------------ */

/// A janela abriu.
///
/// Chamado pelo front no primeiro render (ver `App.tsx`). É o único sinal de
/// vida que existe: o processo Rust não tem como saber se o React montou — a
/// janela "abre" do mesmo jeito com a tela branca.
#[tauri::command]
pub fn ui_ready() {
    UI_HEALTHY.store(true, Ordering::SeqCst);
}

/// Arma o relógio de rollback. Só é chamado quando a sobreposição está em uso.
pub fn watch<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HEALTH_DEADLINE).await;
        if UI_HEALTHY.load(Ordering::SeqCst) {
            return;
        }

        eprintln!(
            "[aibot] a interface baixada não reportou saúde em {} s; voltando para a embutida",
            HEALTH_DEADLINE.as_secs()
        );
        match quarantine() {
            Ok(path) => eprintln!("[aibot] interface em quarentena: {}", path.display()),
            Err(error) => eprintln!("[aibot] a quarentena falhou: {error}"),
        }

        // Ninguém mais olhando? Então a quarentena basta. Sem esta saída, quem
        // desistiu de esperar a tela branca e fechou o app dentro dos vinte
        // segundos veria a janela VOLTAR sozinha — o conserto certo chegando na
        // forma mais assustadora possível. A próxima abertura já usa a embutida.
        if app.webview_windows().is_empty() {
            return;
        }

        // Reiniciar, e não só recarregar a página: o provedor de assets decide
        // no boot (ver `choose`), e uma recarga voltaria a servir a mesma pasta.
        // A chamada não volta.
        app.restart();
    });
}

/* --------------------------- o provedor de assets ------------------------ */

/// Disco primeiro, embutido depois.
pub struct Overlay<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
}

impl<R: Runtime> Assets<R> for Overlay<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(path) = overlay_path(key) {
            match std::fs::read(&path) {
                Ok(bytes) => return Some(Cow::Owned(bytes)),
                // Cair no embutido é melhor do que devolver `None` (que vira 500
                // na tela): o arquivo existe e não pôde ser lido é falha de
                // disco, não pedido inválido.
                Err(error) => eprintln!("[aibot] não foi possível ler {}: {error}", path.display()),
            }
        }
        self.embedded.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        // A listagem só é usada em caminhos de desenvolvimento e do padrão de
        // isolamento; nenhum dos dois convive com a sobreposição, que é um
        // recurso do app INSTALADO. Delegar mantém o comportamento de hoje.
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        if overlay_path(html_path).is_some() {
            // Os hashes `sha256-` de script inline são calculados pelo
            // `tauri-build` em tempo de compilação, sobre o HTML EMBUTIDO —
            // eles não descrevem o HTML do disco. Devolvê-los aqui autorizaria,
            // na CSP, um script que ninguém conferiu.
            //
            // A consequência para quem publica a trilha B: um `<script>` INLINE
            // no bundle novo é BLOQUEADO (não há hash para ele) e um `<style>`
            // inline continua funcionando (`style-src` tem `'unsafe-inline'`).
            // Saída do Vite não tem script inline; um plugin que embuta tudo num
            // arquivo só teria, e a tela ficaria branca sem erro de rede.
            return Box::new(std::iter::empty());
        }
        self.embedded.csp_hashes(html_path)
    }
}

/// Só existe para TIRAR o embutido de dentro do contexto: `set_assets` devolve o
/// provedor anterior, mas exige receber um no lugar. Este é descartado na linha
/// seguinte, sem nunca ser consultado.
struct Placeholder;

impl<R: Runtime> Assets<R> for Placeholder {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Põe a sobreposição na frente do provedor embutido do contexto.
///
/// Chamado em `run()`, antes do `Builder::run`. Nada acontece por causa disto
/// sozinho: enquanto `choose` não escolher uma pasta, todo `get` cai no
/// embutido, byte por byte igual ao de hoje.
pub fn install<R: Runtime>(context: &mut Context<R>) {
    let embedded = context.set_assets(Box::new(Placeholder));
    context.set_assets(Box::new(Overlay { embedded }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(nome: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aibot-overlay-{nome}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("criar raiz de teste");
        dir.canonicalize().expect("canonicalizar raiz de teste")
    }

    /// Uma pasta `current` pronta: entrada + recibo.
    fn bundle(root: &Path, receipt: &str) -> PathBuf {
        let current = root.join(UI_DIR).join(CURRENT_DIR);
        std::fs::create_dir_all(&current).expect("criar current");
        std::fs::write(current.join(ENTRY_FILE), b"<!doctype html>").expect("gravar index");
        if !receipt.is_empty() {
            std::fs::write(current.join(RECEIPT_FILE), receipt).expect("gravar recibo");
        }
        current
    }

    const RECIBO_BOM: &str = r#"{"version":"0.2.0","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#;

    #[test]
    fn recibo_valido_libera_a_pasta() {
        let root = temp_root("recibo-bom");
        let current = bundle(&root, RECIBO_BOM);
        let receipt = inspect(&current).expect("deveria aceitar");
        assert_eq!(receipt.version, "0.2.0");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Sem recibo não há sobreposição: é o arquivo que prova que ALGUÉM
    /// verificou assinatura e hash. Uma pasta que qualquer processo do usuário
    /// pode criar não pode virar código executando com acesso a `invoke()`.
    #[test]
    fn pasta_sem_recibo_e_recusada() {
        let root = temp_root("sem-recibo");
        let current = bundle(&root, "");
        let erro = inspect(&current).expect_err("deveria recusar");
        assert!(erro.contains("recibo"), "erro pouco explicativo: {erro}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recibo_sem_sha256_de_verdade_e_recusado() {
        let root = temp_root("sha-torto");
        let current = bundle(&root, r#"{"version":"0.2.0","sha256":"nao-e-hash"}"#);
        assert!(inspect(&current).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pasta_sem_index_e_recusada() {
        let root = temp_root("sem-index");
        let current = root.join(UI_DIR).join(CURRENT_DIR);
        std::fs::create_dir_all(&current).expect("criar current");
        std::fs::write(current.join(RECEIPT_FILE), RECIBO_BOM).expect("gravar recibo");
        assert!(inspect(&current).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn arquivo_de_dentro_da_pasta_e_servido() {
        let root = temp_root("serve");
        let current = bundle(&root, RECIBO_BOM);
        std::fs::create_dir_all(current.join("assets")).expect("criar assets");
        std::fs::write(current.join("assets").join("app.js"), b"ok").expect("gravar js");
        assert!(resolve_inside(&current, "/index.html").is_some());
        assert!(resolve_inside(&current, "/assets/app.js").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// O confinamento. A página que pede o arquivo é a que pode estar
    /// adulterada, e ao lado da pasta de interfaces moram o token do gateway e o
    /// banco das conversas.
    #[test]
    fn caminho_para_fora_da_pasta_e_recusado() {
        let root = temp_root("fuga");
        let current = bundle(&root, RECIBO_BOM);
        std::fs::write(root.join("token"), b"segredo").expect("gravar token");

        for chave in [
            "/../../token",
            "/..\\..\\token",
            "/assets/../../../token",
            "/./../token",
        ] {
            assert!(
                resolve_inside(&current, chave).is_none(),
                "{chave} deveria ser recusado"
            );
        }
        // Arquivo que não existe também não vira caminho.
        assert!(resolve_inside(&current, "/nao-existe.js").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn quarentena_move_a_pasta_para_o_lado() {
        let root = temp_root("quarentena");
        let current = bundle(&root, RECIBO_BOM);
        let guardada = quarantine_dir(&current).expect("deveria mover");

        assert!(!current.exists(), "a pasta em uso deveria ter saído do lugar");
        assert!(guardada.join(ENTRY_FILE).is_file(), "o bundle tem de sobreviver para análise");
        assert!(
            guardada
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("quarantine-")),
            "nome inesperado: {}",
            guardada.display()
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
