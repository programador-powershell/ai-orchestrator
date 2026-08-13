//! Cliente SSH — executa comando num servidor cadastrado.
//!
//! ## Por que chamar o `ssh` do sistema, e não embutir uma biblioteca
//!
//! SSH é criptografia: troca de chaves, cifras, MAC, verificação de host key,
//! protocolo do agente. Uma implementação caseira aqui seria muito mais
//! perigosa que qualquer coisa que ela evitasse. E embutir uma crate nova cai
//! na regra de dependência externa — parecer de TI/SI antes de entrar.
//!
//! O OpenSSH já vem no Windows 10+, no macOS e no Linux. Chamando o binário do
//! sistema herdamos de graça o que a TI já administra: o **agente**, o
//! `~/.ssh/config`, o `known_hosts` e as políticas da máquina. É o mesmo
//! padrão do ffmpeg.
//!
//! ## O que este módulo garante
//!
//! - **Nenhum segredo passa por aqui.** Autenticação é por agente ou por
//!   CAMINHO de chave; senha é recusada por construção (`BatchMode` +
//!   `PasswordAuthentication=no`), então nem existe prompt para preencher.
//! - **Host key é verificada.** `StrictHostKeyChecking` nunca vira `no`, e
//!   quando o cadastro tem fingerprint fixada ela é comparada antes de
//!   conectar — TOFU no cadastro, verificação a cada uso.
//! - **Os parâmetros de conexão são argv separados**, nunca concatenados numa
//!   linha de shell. O comando remoto é o único texto livre, e ele vai como
//!   UM argumento — quem o interpreta é o shell do servidor, que é o ponto.
//!
//! A parte pura (validação e montagem de argumentos) é testada aqui.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Teto do comando remoto. Acima disso é script, e script se envia por arquivo.
const MAX_COMMAND: usize = 8_192;
/// Tempo máximo de conexão. Sem isto, host inalcançável trava a interface.
const CONNECT_TIMEOUT_SECS: u32 = 10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "agent" ou "keyFile".
    pub auth_method: String,
    /// CAMINHO do arquivo de chave. Nunca o conteúdo.
    pub key_path: Option<String>,
    /// Fingerprint fixada no cadastro (pública, não é segredo).
    pub host_key_fingerprint: Option<String>,
    /// Diretório remoto onde o comando roda.
    pub remote_workdir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Caracteres que não podem existir num campo de conexão.
///
/// Eles vão como argv e não seriam interpretados por shell nenhum, mas um
/// espaço ou aspas num host indicam cadastro corrompido — e recusar cedo é
/// melhor que uma mensagem de erro do `ssh` que ninguém entende.
fn campo_invalido(valor: &str) -> bool {
    valor.is_empty()
        || valor.len() > 255
        || valor
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\"'`$;&|<>()".contains(c))
}

/// Valida o alvo. Devolve o MOTIVO, não um booleano.
pub fn validate_target(target: &SshTarget) -> Result<(), String> {
    if campo_invalido(&target.host) {
        return Err("host inválido no cadastro do servidor".into());
    }
    if campo_invalido(&target.user) {
        return Err("usuário inválido no cadastro do servidor".into());
    }
    if target.port == 0 {
        return Err("porta inválida no cadastro do servidor".into());
    }
    if target.auth_method == "keyFile" {
        let caminho = target.key_path.as_deref().unwrap_or("").trim();
        if caminho.is_empty() {
            return Err("autenticação por arquivo exige o caminho da chave".into());
        }
        // Material de chave colado no campo de caminho: o cadastro já recusa,
        // mas quem chama pode ser outro caminho — e gravar isso seria
        // exatamente o que a política de segredos proíbe.
        if caminho.contains("PRIVATE KEY") || caminho.contains("BEGIN OPENSSH") {
            return Err("o campo é o CAMINHO do arquivo de chave, não o conteúdo".into());
        }
        if caminho.contains('\n') || caminho.contains('\r') {
            return Err("caminho de chave inválido".into());
        }
    }
    if let Some(dir) = target.remote_workdir.as_deref() {
        if dir.contains('\n') || dir.contains('\r') || dir.contains('\'') {
            return Err("diretório remoto inválido".into());
        }
    }
    Ok(())
}

/// Aspas simples POSIX para o diretório remoto entrar no comando com segurança.
fn quote_posix(valor: &str) -> String {
    format!("'{}'", valor.replace('\'', r"'\''"))
}

/// Monta o comando remoto final: entra no diretório e roda o que foi pedido.
pub fn remote_payload(workdir: Option<&str>, command: &str) -> String {
    match workdir.map(str::trim).filter(|dir| !dir.is_empty()) {
        // `cd ... &&` faz o comando não rodar se o diretório não existir —
        // melhor falhar do que executar no `$HOME` por engano.
        Some(dir) => format!("cd {} && {}", quote_posix(dir), command),
        None => command.to_string(),
    }
}

/// Argumentos do `ssh`, na ordem. Puro e testável — é aqui que as garantias moram.
pub fn build_args(target: &SshTarget, command: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        // Sem prompt: se a autenticação não resolver sozinha, falha em vez de
        // travar esperando alguém digitar numa janela que não existe.
        "BatchMode=yes".into(),
        "-o".into(),
        "PasswordAuthentication=no".into(),
        "-o".into(),
        "KbdInteractiveAuthentication=no".into(),
        "-o".into(),
        // NUNCA `no`. `accept-new` aceita host novo e **recusa host trocado**,
        // que é o caso que interessa: chave diferente é ataque ou reinstalação.
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        "ClearAllForwardings=yes".into(),
        "-p".into(),
        target.port.to_string(),
    ];
    if target.auth_method == "keyFile" {
        if let Some(caminho) = target.key_path.as_deref() {
            args.push("-i".into());
            args.push(caminho.to_string());
            // Com chave explícita, não deixa o agente escolher outra.
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
    }
    args.push(format!("{}@{}", target.user, target.host));
    args.push(remote_payload(target.remote_workdir.as_deref(), command));
    args
}

/// Extrai o fingerprint de uma linha do `ssh-keyscan`/`ssh-keygen -lf`.
pub fn parse_fingerprint(saida: &str) -> Option<String> {
    saida
        .split_whitespace()
        .find(|parte| parte.starts_with("SHA256:"))
        .map(str::to_string)
}

/// A fingerprint apresentada bate com a fixada no cadastro?
///
/// Cadastro sem fingerprint aceita (é o primeiro uso, TOFU); cadastro COM
/// fingerprint diferente recusa — é o ponto todo de fixar.
pub fn fingerprint_ok(fixada: Option<&str>, apresentada: Option<&str>) -> bool {
    match (fixada.map(str::trim).filter(|f| !f.is_empty()), apresentada) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(esperada), Some(vista)) => esperada == vista,
    }
}

/// O `ssh` existe nesta máquina?
pub async fn ssh_available() -> bool {
    Command::new("ssh")
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Lê o fingerprint que o servidor apresenta, via `ssh-keyscan`.
#[tauri::command]
pub async fn ssh_fingerprint(host: String, port: u16) -> Result<String, String> {
    if campo_invalido(&host) || port == 0 {
        return Err("host ou porta inválidos".into());
    }
    let saida = Command::new("ssh-keyscan")
        .args(["-p", &port.to_string(), "-T", "5", &host])
        .output()
        .await
        .map_err(|erro| format!("ssh-keyscan indisponível: {erro}"))?;
    let texto = String::from_utf8_lossy(&saida.stdout);
    let primeira = texto
        .lines()
        .find(|linha| !linha.trim_start().starts_with('#') && !linha.trim().is_empty())
        .ok_or_else(|| "o servidor não respondeu com uma chave".to_string())?;

    // `ssh-keygen -lf -` transforma a chave no fingerprint SHA256.
    let mut filho = Command::new("ssh-keygen")
        .args(["-lf", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|erro| format!("ssh-keygen indisponível: {erro}"))?;
    if let Some(mut entrada) = filho.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = entrada.write_all(primeira.as_bytes()).await;
        let _ = entrada.write_all(b"\n").await;
    }
    let resultado = filho
        .wait_with_output()
        .await
        .map_err(|erro| format!("falha ao calcular o fingerprint: {erro}"))?;
    parse_fingerprint(&String::from_utf8_lossy(&resultado.stdout))
        .ok_or_else(|| "não foi possível ler o fingerprint".into())
}

/// Executa um comando no servidor.
///
/// O comando remoto é texto livre de propósito — é o que se pediu para rodar
/// lá. O que NÃO é livre é a conexão: host, usuário, porta e chave viram argv
/// separados e passam pela validação acima.
#[tauri::command]
pub async fn ssh_exec(target: SshTarget, command: String) -> Result<SshResult, String> {
    let command = command.trim().to_owned();
    if command.is_empty() || command.len() > MAX_COMMAND {
        return Err(format!("o comando deve ter entre 1 e {MAX_COMMAND} caracteres"));
    }
    validate_target(&target)?;
    if !ssh_available().await {
        return Err(
            "o cliente ssh do sistema não foi encontrado. No Windows ele faz parte do OpenSSH Client, \
             um recurso opcional do próprio Windows — peça a instalação à TI."
                .into(),
        );
    }

    // Fingerprint fixada no cadastro é verificada A CADA uso: fixar e não
    // conferir seria decoração.
    if let Some(esperada) = target.host_key_fingerprint.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        let vista = ssh_fingerprint(target.host.clone(), target.port).await.ok();
        if !fingerprint_ok(Some(esperada), vista.as_deref()) {
            return Err(format!(
                "a chave do servidor MUDOU desde o cadastro (esperada {esperada}, apresentada {}). \
                 Conexão recusada — confirme com a TI antes de atualizar o cadastro.",
                vista.as_deref().unwrap_or("nenhuma")
            ));
        }
    }

    let inicio = Instant::now();
    let saida = tokio::time::timeout(
        Duration::from_secs(300),
        Command::new("ssh")
            .args(build_args(&target, &command))
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "o comando remoto passou de 5 minutos e foi interrompido".to_string())?
    .map_err(|erro| format!("falha ao executar o ssh: {erro}"))?;

    Ok(SshResult {
        exit_code: saida.status.code(),
        stdout: String::from_utf8_lossy(&saida.stdout).to_string(),
        stderr: String::from_utf8_lossy(&saida.stderr).to_string(),
        duration_ms: inicio.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alvo() -> SshTarget {
        SshTarget {
            host: "vps.multiplike.local".into(),
            port: 22,
            user: "deploy".into(),
            auth_method: "agent".into(),
            key_path: None,
            host_key_fingerprint: None,
            remote_workdir: Some("/srv/app".into()),
        }
    }

    #[test]
    fn nunca_desliga_a_verificacao_de_host_key() {
        let args = build_args(&alvo(), "ls").join(" ");
        assert!(args.contains("StrictHostKeyChecking=accept-new"));
        // O valor perigoso não pode aparecer de jeito nenhum.
        assert!(!args.contains("StrictHostKeyChecking=no"));
    }

    #[test]
    fn nunca_abre_caminho_para_senha() {
        let args = build_args(&alvo(), "ls").join(" ");
        assert!(args.contains("BatchMode=yes"));
        assert!(args.contains("PasswordAuthentication=no"));
        assert!(args.contains("KbdInteractiveAuthentication=no"));
    }

    #[test]
    fn conexao_vai_em_argv_separado() {
        let args = build_args(&alvo(), "ls");
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"22".to_string()));
        assert!(args.contains(&"deploy@vps.multiplike.local".to_string()));
    }

    #[test]
    fn comando_remoto_e_um_argumento_so() {
        let args = build_args(&alvo(), "docker compose up -d");
        // Se ele fosse dividido, o `ssh` juntaria com espaço e o shell remoto
        // veria outra coisa; como argumento único, chega intacto.
        assert_eq!(args.last().unwrap(), "cd '/srv/app' && docker compose up -d");
    }

    #[test]
    fn chave_por_arquivo_fixa_a_identidade() {
        let mut alvo = alvo();
        alvo.auth_method = "keyFile".into();
        alvo.key_path = Some("C:/Users/x/.ssh/id_ed25519".into());
        let args = build_args(&alvo, "ls");
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"IdentitiesOnly=yes".to_string()));
    }

    #[test]
    fn agente_nao_passa_arquivo_de_chave() {
        let args = build_args(&alvo(), "ls");
        assert!(!args.contains(&"-i".to_string()));
    }

    #[test]
    fn workdir_e_escapado() {
        let mut alvo = alvo();
        alvo.remote_workdir = Some("/srv/app com espaço".into());
        assert_eq!(
            remote_payload(alvo.remote_workdir.as_deref(), "ls"),
            "cd '/srv/app com espaço' && ls"
        );
    }

    #[test]
    fn sem_workdir_o_comando_vai_puro() {
        assert_eq!(remote_payload(None, "uptime"), "uptime");
        assert_eq!(remote_payload(Some("  "), "uptime"), "uptime");
    }

    #[test]
    fn host_com_metacaractere_e_recusado() {
        for ruim in ["vps.local; rm -rf /", "vps local", "vps`whoami`", "vps$(id)"] {
            let mut alvo = alvo();
            alvo.host = ruim.into();
            assert!(validate_target(&alvo).is_err(), "aceitou host: {ruim}");
        }
    }

    #[test]
    fn usuario_com_metacaractere_e_recusado() {
        let mut alvo = alvo();
        alvo.user = "deploy|sh".into();
        assert!(validate_target(&alvo).is_err());
    }

    #[test]
    fn porta_zero_e_recusada() {
        let mut alvo = alvo();
        alvo.port = 0;
        assert!(validate_target(&alvo).is_err());
    }

    #[test]
    fn material_de_chave_no_campo_de_caminho_e_recusado() {
        let mut alvo = alvo();
        alvo.auth_method = "keyFile".into();
        alvo.key_path = Some("-----BEGIN OPENSSH PRIVATE KEY-----".into());
        let erro = validate_target(&alvo).unwrap_err();
        assert!(erro.contains("CAMINHO"));
    }

    #[test]
    fn keyfile_sem_caminho_e_recusado() {
        let mut alvo = alvo();
        alvo.auth_method = "keyFile".into();
        alvo.key_path = None;
        assert!(validate_target(&alvo).is_err());
    }

    #[test]
    fn workdir_com_quebra_de_linha_e_recusado() {
        let mut alvo = alvo();
        alvo.remote_workdir = Some("/srv\nrm -rf /".into());
        assert!(validate_target(&alvo).is_err());
    }

    #[test]
    fn alvo_bem_formado_passa() {
        assert!(validate_target(&alvo()).is_ok());
    }

    #[test]
    fn fingerprint_e_lido_da_saida_do_keygen() {
        let saida = "256 SHA256:abcdEFGH1234 vps.local (ED25519)";
        assert_eq!(parse_fingerprint(saida), Some("SHA256:abcdEFGH1234".into()));
        assert_eq!(parse_fingerprint("sem nada"), None);
    }

    #[test]
    fn cadastro_sem_fingerprint_aceita_o_primeiro_uso() {
        assert!(fingerprint_ok(None, Some("SHA256:x")));
        assert!(fingerprint_ok(Some("   "), Some("SHA256:x")));
    }

    #[test]
    fn chave_trocada_e_recusada() {
        assert!(!fingerprint_ok(Some("SHA256:antiga"), Some("SHA256:nova")));
        // Servidor que não respondeu também não passa: fixada sem conferir
        // seria o mesmo que não ter fixado.
        assert!(!fingerprint_ok(Some("SHA256:antiga"), None));
    }

    #[test]
    fn mesma_chave_passa() {
        assert!(fingerprint_ok(Some("SHA256:igual"), Some("SHA256:igual")));
    }
}
