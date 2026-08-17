//! Docker Sandboxes (`sbx`) — o isolamento das cargas DOCKER.
//!
//! ## A divisão, e por que ela é assim
//!
//! **`sbx` só para Docker. Todo o resto continua no Job Object** (`jail.rs`).
//!
//! Os dois resolvem problemas diferentes e nenhum substitui o outro:
//!
//! - O Job Object contém uma ÁRVORE DE PROCESSOS na própria máquina: mata neto
//!   órfão, limita memória e número de processos, morre junto com o handle. É
//!   o isolamento certo para rodar um comando qualquer que o agente propôs.
//! - O `sbx` levanta uma microVM com daemon Docker, filesystem e rede
//!   PRÓPRIOS. Isso é o que um `docker build` precisa e o Job Object não tem
//!   como dar: construir imagem exige um daemon, e usar o daemon do host
//!   significa que o build alcança a rede do host, o socket do host e as
//!   imagens do host. Um `Dockerfile` com `RUN curl ... | sh` roda com o
//!   alcance do daemon, não o do Job Object.
//!
//! Fora do Docker, exigir microVM seria caro e desnecessário — e quebraria
//! toda máquina que ainda não tem o `sbx`.
//!
//! ## Degradação é DITA, nunca silenciosa
//!
//! Sem `sbx` instalado, o comando Docker continua rodando pelo caminho comum:
//! a ausência dele reduz a garantia, não impede o build. Quem precisa saber
//! QUAL garantia está valendo pergunta a [`sbx_status`] — mesma disciplina do
//! campo `jailed` do `sandbox.rs`. Um app que diz "sandbox" e entrega execução
//! direta é pior que um que não promete nada.
//!
//! ## Licença
//!
//! O `sbx` é software PROPRIETÁRIO da Docker Inc. Os binários não são
//! compilados a partir deste repositório e não são cobertos pela licença dele
//! — ver `vendor/sbx/LEIAME.md` para a origem, a versão fixada e o que a TI
//! precisa ter aprovado antes de distribuir.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Nome do executável, por plataforma.
#[cfg(windows)]
const EXECUTAVEL: &str = "sbx.exe";
#[cfg(not(windows))]
const EXECUTAVEL: &str = "sbx";

/// Pasta, dentro do app instalado, onde os binários vendorizados moram.
const PASTA_VENDOR: &str = "sbx";

/// Onde o `sbx` foi encontrado, e como.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SbxDisponivel {
    pub disponivel: bool,
    /// Caminho resolvido, quando existe.
    pub caminho: Option<String>,
    /// `vendor` (distribuído com o app) ou `path` (instalado na máquina).
    pub origem: Option<String>,
}

/// O comando é uma carga Docker?
///
/// A checagem é do PRIMEIRO token, e não `contains("docker")`: um
/// `npm run build` cujo script mencione docker no meio não é uma carga
/// Docker, e mandá-lo para a microVM seria trocar o ambiente do build por
/// engano. `\b` importa — `dockerfile-lint` não é `docker`.
pub fn e_carga_docker(command: &str) -> bool {
    let base = Path::new(programa_do_comando(command))
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(base.as_str(), "docker" | "docker-compose" | "buildx")
}

/// O executável de uma linha de comando, respeitando aspas.
///
/// `split_whitespace` sozinho erra no caso mais comum do Windows:
/// `"C:\Program Files\Docker\docker.exe" ps` tem espaço DENTRO do caminho, e o
/// primeiro token sairia como `"C:\Program`. Chamar isso de "não é Docker"
/// mandaria o build para o caminho sem microVM justamente na máquina onde o
/// Docker está instalado no lugar padrão.
fn programa_do_comando(command: &str) -> &str {
    let limpo = command.trim_start();
    if let Some(resto) = limpo.strip_prefix('"') {
        return resto.split('"').next().unwrap_or("");
    }
    limpo.split_whitespace().next().unwrap_or("")
}

/// Diretório dos binários vendorizados, ao lado do executável do app.
///
/// `current_exe` e não uma constante de caminho: instalação por usuário
/// (`installMode: currentUser`, no `tauri.conf.json`) põe o app em
/// `%LOCALAPPDATA%`, e um caminho fixo apontaria para o lugar errado.
fn pasta_vendor() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?;
    // Instalado: <app>/sbx/. Em desenvolvimento, o binário fica em
    // target/debug/, e a pasta do repositório é a referência.
    let candidatos = [
        base.join(PASTA_VENDOR),
        base.join("resources").join(PASTA_VENDOR),
        base.join("..").join("..").join("vendor").join(PASTA_VENDOR),
    ];
    candidatos.into_iter().find(|caminho| caminho.join(EXECUTAVEL).is_file())
}

/// Procura o `sbx` — primeiro o vendorizado, depois o do sistema.
///
/// A precedência é deliberada: o binário que veio COM o app é o que foi
/// homologado e teve a versão fixada. Um `sbx` mais novo no PATH da máquina
/// pode ter mudado a linha de comando, e o app passaria a falhar por uma
/// atualização que ninguém aqui pediu.
pub fn localizar() -> SbxDisponivel {
    if let Some(pasta) = pasta_vendor() {
        let caminho = pasta.join(EXECUTAVEL);
        return SbxDisponivel {
            disponivel: true,
            caminho: Some(caminho.to_string_lossy().into_owned()),
            origem: Some("vendor".into()),
        };
    }
    if let Some(caminho) = which_no_path() {
        return SbxDisponivel {
            disponivel: true,
            caminho: Some(caminho.to_string_lossy().into_owned()),
            origem: Some("path".into()),
        };
    }
    SbxDisponivel { disponivel: false, caminho: None, origem: None }
}

/// `which` sem dependência nova: varre o PATH à mão.
fn which_no_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(EXECUTAVEL))
        .find(|caminho| caminho.is_file())
}

/// Diz à interface se a microVM está disponível.
#[tauri::command]
pub fn sbx_status() -> SbxDisponivel {
    localizar()
}

/// Monta a linha de comando que roda `command` DENTRO da microVM.
///
/// Devolve `None` quando o comando não é carga Docker ou o `sbx` não existe —
/// e nesse caso quem chama segue pelo caminho de sempre. Erro seria a resposta
/// errada: a ausência do `sbx` não deve impedir um build de rodar, só reduz a
/// garantia, e é [`sbx_status`] que conta isso à tela.
pub fn envolver(command: &str, cwd: Option<&str>) -> Option<(String, Vec<String>)> {
    if !e_carga_docker(command) {
        return None;
    }
    let sbx = localizar();
    let caminho = sbx.caminho?;
    let mut argumentos = vec!["run".to_string()];
    if let Some(dir) = cwd.filter(|valor| !valor.trim().is_empty()) {
        // O diretório do projeto entra montado: sem ele a microVM não enxerga
        // o Dockerfile nem o contexto do build.
        argumentos.push("--workdir".to_string());
        argumentos.push(dir.to_string());
    }
    argumentos.push("--".to_string());
    argumentos.push(command.to_string());
    Some((caminho, argumentos))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconhece_carga_docker_pelo_primeiro_token() {
        assert!(e_carga_docker("docker build -f Dockerfile.orchestrator -t app:1 ."));
        assert!(e_carga_docker("  docker   ps"));
        assert!(e_carga_docker("docker-compose up -d"));
        assert!(e_carga_docker("buildx bake"));
    }

    #[test]
    fn nao_confunde_comando_que_so_menciona_docker() {
        // O engano que um `contains` cometeria: trocar o ambiente do build
        // porque a palavra apareceu no meio da linha.
        assert!(!e_carga_docker("npm run build:docker"));
        assert!(!e_carga_docker("dockerfile-lint Dockerfile"));
        assert!(!e_carga_docker("echo docker"));
        assert!(!e_carga_docker("cat Dockerfile"));
        assert!(!e_carga_docker(""));
    }

    #[test]
    fn aceita_caminho_completo_do_executavel() {
        assert!(e_carga_docker("/usr/bin/docker ps"));
        assert!(e_carga_docker("C:\\Docker\\docker.exe ps"));
    }

    #[test]
    fn caminho_ENTRE_ASPAS_com_espaco_ainda_e_docker() {
        /*
         * O caso mais comum do Windows: o Docker instala em
         * `C:\Program Files\Docker`, e o espaco no meio faria
         * `split_whitespace` devolver `"C:\Program` como programa. Tratar
         * isso como "nao e Docker" mandaria o build para o caminho SEM microVM
         * justamente na maquina onde o Docker esta no lugar padrao.
         */
        assert!(e_carga_docker(
            "\"C:\\Program Files\\Docker\\docker.exe\" build -t app ."
        ));
        assert!(!e_carga_docker("\"C:\\Program Files\\Node\\npm.exe\" ci"));
    }

    #[test]
    fn nao_envolve_o_que_nao_e_docker() {
        assert!(envolver("npm ci", None).is_none());
    }
}
