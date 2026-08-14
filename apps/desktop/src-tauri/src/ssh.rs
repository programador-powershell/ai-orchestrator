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

/// Argumentos do `ssh` para uma sessão INTERATIVA (PTY).
///
/// Difere de [`build_args`] em três pontos, e cada um tem motivo:
///
/// - **`-tt`** força alocação de TTY no remoto. Sem isso o shell remoto nasce
///   sem terminal, `bash` não carrega perfil interativo e programa de tela
///   (`vim`, `top`) simplesmente não funciona. O `-t` duplicado força mesmo
///   quando a entrada local não é um tty — e aqui ela não é: é um pipe do PTY.
/// - **Sem `BatchMode=yes`.** Em [`build_args`] ele existe para o comando
///   falhar em vez de travar esperando alguém digitar numa janela que não
///   existe. Aqui a janela EXISTE — é o terminal da aba — então travar
///   esperando uma passphrase de chave é o comportamento certo. As duas
///   recusas que importam continuam de pé: `PasswordAuthentication=no` e
///   `KbdInteractiveAuthentication=no`, para senha nunca ser digitada aqui.
/// - **Sem comando com `&&`.** `remote_payload` monta `cd X && cmd`; com
///   comando vazio isso viraria `cd X && `, erro de sintaxe. Para a sessão
///   interativa o payload é `cd X && exec $SHELL -l`: o `exec` substitui o
///   processo, então sair do shell encerra a conexão em vez de deixar um
///   processo pai pendurado.
///
/// Puro e testável, como `build_args` — é aqui que as garantias moram.
pub fn build_interactive_args(target: &SshTarget) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-tt".into(),
        "-o".into(),
        "PasswordAuthentication=no".into(),
        "-o".into(),
        "KbdInteractiveAuthentication=no".into(),
        "-o".into(),
        // NUNCA `no`, pelo mesmo motivo de `build_args`.
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
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
    }
    args.push(format!("{}@{}", target.user, target.host));
    if let Some(dir) = target
        .remote_workdir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        // `${SHELL:-/bin/sh}`: conta sem SHELL definido não pode ficar sem
        // shell nenhum. `-l` para o perfil de login carregar (PATH, nvm, etc.).
        args.push(format!(
            "cd {} && exec ${{SHELL:-/bin/sh}} -l",
            quote_posix(dir)
        ));
    }
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
    /*
     * O app NAO INSTALA. Regra da organizacao, verificada aqui.
     *
     * Este e um dos tres caminhos que o MODELO dirige (ssh_exec — a maquina remota tambem e uma maquina). O terminal
     * interativo fica de fora de proposito: la quem digita sao as maos de
     * quem opera, e essa pessoa responde pelo que faz — a mesma razao pela
     * qual `pty_*` nunca entrou no registro de ferramentas do agente.
     *
     * O gate de aprovacao nao substitui esta checagem: quem clica "aprovar"
     * raramente distingue `npm i -D vitest` de `npm i -g`, e a diferenca
     * entre as duas e a maquina inteira.
     */
    if let Some(recusa) = crate::instalacao::tenta_instalar(&command) {
        return Err(format!("{}: {}", recusa.codigo, recusa.motivo));
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

/* --------------------------- Arquivos remotos --------------------------- */

/// Caminho relativo seguro dentro do diretório remoto.
///
/// Mesma regra do sandbox local: sem `..`, sem raiz absoluta, sem `~`. Sem
/// isto, `fs_read` com `../../etc/shadow` sairia do diretório do projeto — e
/// no servidor isso é bem pior que na estação.
pub fn safe_remote_path(workdir: &str, relativo: &str) -> Result<String, String> {
    let limpo = relativo.trim().replace('\\', "/");
    if limpo.is_empty() {
        return Err("informe o caminho".into());
    }
    if limpo.starts_with('/') || limpo.starts_with('~') || limpo.contains(':') {
        return Err("use caminho relativo ao diretório do projeto".into());
    }
    if limpo.split('/').any(|parte| parte == "..") {
        return Err("caminho não pode subir de diretório".into());
    }
    if limpo.contains('\n') || limpo.contains('\r') || limpo.contains('\0') {
        return Err("caminho inválido".into());
    }
    let base = workdir.trim().trim_end_matches('/');
    Ok(if base.is_empty() {
        limpo
    } else {
        format!("{base}/{limpo}")
    })
}

/// Roda um comando remoto opcionalmente alimentando o stdin.
///
/// O stdin existe para a GRAVAÇÃO: mandar o conteúdo do arquivo dentro da
/// linha de comando exigiria escapá-lo, e conteúdo de arquivo é justamente o
/// texto mais hostil que existe para escape.
async fn run_ssh(target: &SshTarget, command: &str, stdin: Option<&str>) -> Result<SshResult, String> {
    validate_target(target)?;
    let inicio = Instant::now();
    let mut cmd = Command::new("ssh");
    // Aqui o comando já vem montado com caminho absoluto: não usa o workdir.
    let mut alvo_sem_cd = target.clone();
    alvo_sem_cd.remote_workdir = None;
    cmd.args(build_args(&alvo_sem_cd, command))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut filho = cmd.spawn().map_err(|erro| format!("falha ao executar o ssh: {erro}"))?;
    if let (Some(texto), Some(mut entrada)) = (stdin, filho.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        entrada
            .write_all(texto.as_bytes())
            .await
            .map_err(|erro| format!("falha ao enviar o conteúdo: {erro}"))?;
        // Fechar o stdin é o que faz o `cat` remoto terminar; sem isso o
        // comando fica esperando para sempre.
        drop(entrada);
    }
    let saida = tokio::time::timeout(Duration::from_secs(120), filho.wait_with_output())
        .await
        .map_err(|_| "a operação remota passou de 2 minutos".to_string())?
        .map_err(|erro| format!("falha ao executar o ssh: {erro}"))?;
    Ok(SshResult {
        exit_code: saida.status.code(),
        stdout: String::from_utf8_lossy(&saida.stdout).to_string(),
        stderr: String::from_utf8_lossy(&saida.stderr).to_string(),
        duration_ms: inicio.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn ssh_read(target: SshTarget, path: String) -> Result<String, String> {
    let alvo = safe_remote_path(target.remote_workdir.as_deref().unwrap_or(""), &path)?;
    let saida = run_ssh(&target, &format!("cat -- {}", quote_posix(&alvo)), None).await?;
    if saida.exit_code != Some(0) {
        return Err(saida.stderr.trim().to_string());
    }
    Ok(saida.stdout)
}

#[tauri::command]
pub async fn ssh_write(target: SshTarget, path: String, content: String) -> Result<(), String> {
    let alvo = safe_remote_path(target.remote_workdir.as_deref().unwrap_or(""), &path)?;
    let citado = quote_posix(&alvo);
    // `mkdir -p` do diretório-pai: gravar num caminho novo é o caso comum, e
    // falhar por pasta inexistente seria ruído.
    let comando = format!("mkdir -p -- \"$(dirname {citado})\" && cat > {citado}");
    let saida = run_ssh(&target, &comando, Some(&content)).await?;
    if saida.exit_code != Some(0) {
        return Err(saida.stderr.trim().to_string());
    }
    Ok(())
}

/// Decodifica base64 sem depender de crate — só o alfabeto padrão.
///
/// É o suficiente para trazer um binário do servidor, e evita mais uma
/// dependência num projeto que já escreve o que precisa.
pub fn decode_base64(texto: &str) -> Result<Vec<u8>, String> {
    let mut saida = Vec::with_capacity(texto.len() * 3 / 4);
    let mut acumulado: u32 = 0;
    let mut bits = 0u32;
    for byte in texto.bytes() {
        let valor = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // `=` e espaço em branco (o `base64` quebra linha) são ignorados.
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err("resposta do servidor não é base64 válido".into()),
        } as u32;
        acumulado = (acumulado << 6) | valor;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            saida.push(((acumulado >> bits) & 0xFF) as u8);
        }
    }
    Ok(saida)
}

/// Lê um arquivo BINÁRIO do servidor.
///
/// Vai em base64 porque o stdout do `ssh` é texto: mandar bytes crus os
/// corromperia na primeira sequência inválida de UTF-8 — que num `.docx`
/// aparece já no cabeçalho do zip.
pub async fn read_remote_bytes(target: &SshTarget, path: &str) -> Result<Vec<u8>, String> {
    let alvo = safe_remote_path(target.remote_workdir.as_deref().unwrap_or(""), path)?;
    let comando = format!("base64 {} 2>/dev/null || base64 -i {}", quote_posix(&alvo), quote_posix(&alvo));
    let saida = run_ssh(target, &comando, None).await?;
    if saida.exit_code != Some(0) {
        return Err(if saida.stderr.trim().is_empty() {
            "não foi possível ler o arquivo no servidor".into()
        } else {
            saida.stderr.trim().to_string()
        });
    }
    decode_base64(&saida.stdout)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Lê uma linha do `ls -1Ap`, onde a barra final marca diretório.
pub fn parse_ls_line(linha: &str, sub: &str) -> Option<RemoteEntry> {
    let bruto = linha.trim_end_matches(['\r', '\n']);
    if bruto.is_empty() {
        return None;
    }
    let is_dir = bruto.ends_with('/');
    let name = bruto.trim_end_matches('/').to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let base = sub.trim().trim_matches('/');
    let path = if base.is_empty() {
        name.clone()
    } else {
        format!("{base}/{name}")
    };
    Some(RemoteEntry { name, path, is_dir, size: 0 })
}

#[tauri::command]
pub async fn ssh_list(target: SshTarget, sub: String) -> Result<Vec<RemoteEntry>, String> {
    let base = target.remote_workdir.clone().unwrap_or_default();
    let alvo = if sub.trim().is_empty() {
        let limpo = base.trim().trim_end_matches('/');
        if limpo.is_empty() { ".".to_string() } else { limpo.to_string() }
    } else {
        safe_remote_path(&base, &sub)?
    };
    // `-p` põe barra nos diretórios; `-A` mostra ocultos sem `.` e `..`.
    let saida = run_ssh(&target, &format!("ls -1Ap -- {}", quote_posix(&alvo)), None).await?;
    if saida.exit_code != Some(0) {
        return Err(saida.stderr.trim().to_string());
    }
    Ok(saida
        .stdout
        .lines()
        .filter_map(|linha| parse_ls_line(linha, &sub))
        .collect())
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

    /* ---------------- Sessão interativa (PTY) ---------------- */

    #[test]
    fn interativo_forca_tty_no_remoto() {
        // Sem `-tt` o shell remoto nasce sem terminal: perfil interativo não
        // carrega e programa de tela não funciona. A entrada local é um pipe do
        // PTY, então o `-t` simples não bastaria — daí o duplicado.
        let args = build_interactive_args(&alvo());
        assert_eq!(args.first().map(String::as_str), Some("-tt"));
    }

    #[test]
    fn interativo_mantem_a_verificacao_de_host_key() {
        let args = build_interactive_args(&alvo()).join(" ");
        assert!(args.contains("StrictHostKeyChecking=accept-new"));
        assert!(!args.contains("StrictHostKeyChecking=no"));
    }

    #[test]
    fn interativo_continua_recusando_senha() {
        // A janela existe (é o terminal da aba), então BatchMode sai para uma
        // passphrase de CHAVE poder ser digitada. Senha de conta, nunca.
        let args = build_interactive_args(&alvo()).join(" ");
        assert!(args.contains("PasswordAuthentication=no"));
        assert!(args.contains("KbdInteractiveAuthentication=no"));
        assert!(!args.contains("BatchMode=yes"));
    }

    #[test]
    fn interativo_nao_encaminha_porta() {
        assert!(build_interactive_args(&alvo())
            .join(" ")
            .contains("ClearAllForwardings=yes"));
    }

    #[test]
    fn interativo_entra_no_workdir_com_exec() {
        // `exec` substitui o processo: sair do shell encerra a conexão em vez
        // de deixar um pai pendurado.
        let payload = build_interactive_args(&alvo()).last().cloned().unwrap();
        assert_eq!(payload, "cd '/srv/app' && exec ${SHELL:-/bin/sh} -l");
    }

    #[test]
    fn interativo_sem_workdir_nao_monta_cd_vazio() {
        // `remote_payload` com comando vazio daria `cd X && `, erro de sintaxe.
        // Sem workdir o certo é não mandar comando nenhum: shell de login.
        let mut sem_dir = alvo();
        sem_dir.remote_workdir = None;
        let args = build_interactive_args(&sem_dir);
        assert_eq!(args.last().map(String::as_str), Some("deploy@vps.multiplike.local"));
        assert!(!args.iter().any(|a| a.contains("&&")));
    }

    #[test]
    fn interativo_escapa_workdir_com_apostrofo() {
        let mut hostil = alvo();
        hostil.remote_workdir = Some("/srv/it's here".into());
        let payload = build_interactive_args(&hostil).last().cloned().unwrap();
        // Fecha, escapa e reabre — o apóstrofo não pode terminar a string e
        // deixar o resto virar comando.
        assert_eq!(payload, r"cd '/srv/it'\''s here' && exec ${SHELL:-/bin/sh} -l");
    }

    #[test]
    fn interativo_com_chave_fixa_nao_deixa_o_agente_escolher_outra() {
        let mut com_chave = alvo();
        com_chave.auth_method = "keyFile".into();
        com_chave.key_path = Some("/home/deploy/.ssh/id_ed25519".into());
        let args = build_interactive_args(&com_chave).join(" ");
        assert!(args.contains("-i /home/deploy/.ssh/id_ed25519"));
        assert!(args.contains("IdentitiesOnly=yes"));
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

    #[test]
    fn caminho_remoto_e_relativo_ao_projeto() {
        assert_eq!(safe_remote_path("/srv/app", "src/main.rs").unwrap(), "/srv/app/src/main.rs");
        assert_eq!(safe_remote_path("/srv/app/", "a.txt").unwrap(), "/srv/app/a.txt");
        assert_eq!(safe_remote_path("", "a.txt").unwrap(), "a.txt");
    }

    #[test]
    fn caminho_remoto_nao_sobe_de_diretorio() {
        // No servidor isso e bem pior que na estacao.
        for ruim in ["../etc/shadow", "src/../../x", ".."] {
            assert!(safe_remote_path("/srv/app", ruim).is_err(), "aceitou: {ruim}");
        }
    }

    #[test]
    fn caminho_remoto_recusa_raiz_e_til() {
        assert!(safe_remote_path("/srv/app", "/etc/passwd").is_err());
        assert!(safe_remote_path("/srv/app", "~/.ssh/id_rsa").is_err());
        assert!(safe_remote_path("/srv/app", "C:/Windows").is_err());
    }

    #[test]
    fn caminho_remoto_normaliza_barra_do_windows() {
        assert_eq!(safe_remote_path("/srv/app", "src\\lib.rs").unwrap(), "/srv/app/src/lib.rs");
    }

    #[test]
    fn caminho_remoto_recusa_quebra_de_linha() {
        assert!(safe_remote_path("/srv/app", "a\nrm -rf /").is_err());
    }

    #[test]
    fn caminho_remoto_vazio_e_recusado() {
        assert!(safe_remote_path("/srv/app", "  ").is_err());
    }

    #[test]
    fn caminho_com_aspas_e_escapado_no_comando() {
        // Nome de arquivo com aspas simples nao pode fechar o argumento.
        let alvo = safe_remote_path("/srv/app", "rel'atorio.txt").unwrap();
        let citado = quote_posix(&alvo);
        assert!(citado.starts_with('\'') && citado.ends_with('\''));
        assert!(citado.contains(r"'\''"));
    }

    #[test]
    fn ls_marca_diretorio_pela_barra() {
        let arquivo = parse_ls_line("main.rs", "src").unwrap();
        assert!(!arquivo.is_dir);
        assert_eq!(arquivo.path, "src/main.rs");

        let pasta = parse_ls_line("lib/", "src").unwrap();
        assert!(pasta.is_dir);
        assert_eq!(pasta.name, "lib");
        assert_eq!(pasta.path, "src/lib");
    }

    #[test]
    fn ls_na_raiz_nao_prefixa_barra() {
        assert_eq!(parse_ls_line("README.md", "").unwrap().path, "README.md");
        assert_eq!(parse_ls_line("README.md", "/").unwrap().path, "README.md");
    }

    #[test]
    fn base64_decodifica_o_alfabeto_padrao() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn base64_ignora_quebra_de_linha_do_utilitario() {
        // O `base64` do coreutils quebra em 76 colunas por padrão.
        assert_eq!(decode_base64("aGVs\nbG8=\n").unwrap(), b"hello");
    }

    #[test]
    fn base64_traz_byte_binario_intacto() {
        // Cabeçalho de zip (docx): é onde a leitura como texto corromperia.
        assert_eq!(decode_base64("UEsDBBQA").unwrap(), vec![0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    }

    #[test]
    fn base64_recusa_caractere_invalido() {
        assert!(decode_base64("aGVs*bG8=").is_err());
    }

    #[test]
    fn ls_descarta_linha_vazia_e_pontos() {
        assert!(parse_ls_line("", "src").is_none());
        assert!(parse_ls_line(".", "src").is_none());
        assert!(parse_ls_line("../", "src").is_none());
    }
}
