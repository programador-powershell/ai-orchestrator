//! As ferramentas de MÁQUINA — o que o gateway Go não tem como executar.
//!
//! O Go é o cérebro e já implementa tudo o que é lógica: ler arquivo, git,
//! memória, rede, MCP. O que sobra para cá é o que depende do sistema
//! operacional e não existe na biblioteca padrão do Go: Job Object do Windows,
//! ConPTY, o binário de um DOCX no disco da pessoa, o runtime local. O gateway
//! despacha pelo mesmo `tool.call` do protocolo canônico — o host é mais um
//! participante, não um caso especial (ver `hostbridge.rs`).
//!
//! ## O que NÃO está aqui, e não vai estar
//!
//! `pty_write` NÃO é ferramenta. Escrever num terminal interativo é execução
//! sem portão de aprovação: bastaria o modelo mandar `rm -rf .\n` e nenhuma
//! política teria sido consultada. Quem precisa de shell usa `proc.run`, que
//! passa pelo gate do gateway.
//!
//! `term.open` também não é — não por risco, mas por honestidade: ela abria um
//! terminal que a interface não mostra em lugar nenhum. Ver o bloco no fim deste
//! arquivo, que explica o defeito e como religá-la.
//!
//! ## Três superfícies de execução, separadas de propósito
//!
//! 1. `proc.run` — comando único, com timeout e com aprovação;
//! 2. sandbox com Job Object — a árvore inteira morre junto;
//! 3. `pty_*` — interativo, humano.
//!
//! Fundi-las desfaz o modelo de aprovação: um shell interativo aceitando
//! comando do modelo é o item 1 sem o gate, e a sandbox sem job é o item 2 sem
//! a garantia. Aqui elas continuam três.
//!
//! ## Nunca um sucesso vazio
//!
//! Ferramenta desconhecida devolve ERRO dizendo que esta máquina não a serve.
//! Uma string vazia com `ok: true` é lida pelo modelo como "funcionou, não
//! havia nada" — e ele segue construindo em cima de algo que não aconteceu.

use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::jail::Jail;

// `CREATION_FLAGS` e `creation_flags` só existem no Windows; importá-los sempre
// deixaria um aviso de import não usado nas outras plataformas.
#[cfg(windows)]
use crate::jail::CREATION_FLAGS;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Teto de cada fluxo de saída de um processo. 100 KiB é muito mais do que um
/// humano lê e mais do que um modelo precisa; acima disso é log, e log inteiro
/// no prompt gasta a janela de contexto sem informar nada.
const OUTPUT_LIMIT: usize = 100 * 1024;

/// Timeout padrão do `proc.run`.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Teto do timeout. Combina com o prazo que o gateway dá ao host
/// (`hostToolTimeout`, 15 min): pedir mais do que isso é pedir um resultado que
/// já ninguém está esperando.
const MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Timeout do `diagnostics.run`. Maior que o padrão porque um `cargo check` num
/// projeto frio passa de dois minutos com facilidade.
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(300);

/// Intervalo de espera pelo fim do processo.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Carência para os canos fecharem depois que o processo já terminou. Ver o uso
/// em `run_shell`: é o caso do neto que herdou a saída e continua vivo.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Teto do comando aceito.
const MAX_COMMAND_CHARS: usize = 8_192;

/// Teto do texto extraído de um documento.
const MAX_DOCUMENT_TEXT: usize = 400 * 1024;

/// Endereço do runtime local (o mesmo que o catálogo do gateway usa para o
/// provedor `local`).
const RUNTIME_AUTHORITY: &str = "127.0.0.1:8788";

/// Prazo da consulta ao runtime local. Curto: a resposta interessante aqui é
/// "está de pé ou não", e ninguém espera cinco segundos por isso.
const RUNTIME_TIMEOUT: Duration = Duration::from_millis(1_500);

/* ------------------------------- despacho -------------------------------- */

/// Executa uma ferramenta de máquina.
///
/// Assinatura síncrona de propósito: quem chama é a thread da ponte, e cada
/// chamada roda na sua própria thread (ver `hostbridge.rs`). Um executor
/// assíncrono aqui só acrescentaria um runtime para bloquear do mesmo jeito no
/// primeiro `cargo build`.
pub fn execute(tool: &str, args: &Value) -> Result<String, String> {
    match tool {
        "proc.run" => proc_run(args),
        "diagnostics.run" => diagnostics_run(),
        "office.open" => office_open(args),
        "office.edit" => office_edit(args),
        "office.export" => office_export(args),
        "pdf.extract" => pdf_extract(args),
        "runtime.status" => runtime_status(),
        // Vídeo mora em módulo próprio (video.rs): é o ffmpeg DA ESTAÇÃO, com
        // regras próprias de timeout e de escape que não se misturam com o
        // resto deste arquivo.
        "video.probe" => crate::video::probe(args),
        "video.trim" => crate::video::trim(args),
        "video.concat" => crate::video::concat(args),
        "video.text" => crate::video::text(args),
        "video.export" => crate::video::export(args),
        // `term.open` FOI TIRADA DAQUI DE PROPÓSITO — ver o bloco no fim deste
        // arquivo. Ela volta no dia em que a interface tiver painel de terminal.
        other => Err(format!(
            "a ferramenta {other} não é servida por esta máquina. \
As ferramentas de máquina são: proc.run, diagnostics.run, office.open, office.edit, \
office.export, pdf.extract, runtime.status, video.probe, video.trim, video.concat, \
video.text e video.export."
        )),
    }
}

/* ---------------------------- raiz do projeto ---------------------------- */

/// Pasta de projeto da janela. Todo caminho de arquivo é confinado a ela.
///
/// Fica em estado de módulo porque o gateway NÃO manda a raiz junto do
/// `tool.call` — ele manda `{path}` relativo, e quem sabe qual pasta a pessoa
/// abriu é o aplicativo. Estado global assusta com razão; a alternativa era
/// carregar a raiz por dentro de sete assinaturas até chegar em quem abre o
/// arquivo, e aí o dia em que alguém esquecer de passar vira "abre em qualquer
/// lugar" em vez de erro de compilação.
static PROJECT_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Define (ou limpa) a pasta de projeto.
///
/// Chamado DUAS vezes pelo `lib.rs`, e as duas importam: no `setup`, com a pasta
/// de onde o aplicativo foi aberto — um padrão honesto, que é o que faz as
/// ferramentas funcionarem sem configuração —, e depois pelo comando Tauri de
/// mesmo nome, quando a pessoa escolhe outra pasta na tela. Enquanto nenhuma das
/// duas acontece, `project_root()` recusa tudo (ver a mensagem lá embaixo).
pub fn set_project_root(root: Option<PathBuf>) -> Result<(), String> {
    let resolved = match root {
        Some(path) => {
            let canonical = path.canonicalize().map_err(|error| {
                format!("pasta de projeto inválida ({}): {error}", path.display())
            })?;
            if !canonical.is_dir() {
                return Err(format!(
                    "a pasta de projeto precisa ser um diretório: {}",
                    canonical.display()
                ));
            }
            Some(canonical)
        }
        None => None,
    };
    let mut slot = PROJECT_ROOT
        .lock()
        .map_err(|_| "o estado da pasta de projeto ficou inconsistente".to_string())?;
    *slot = resolved;
    Ok(())
}

/// Raiz atual, ou erro legível.
///
/// Recusar é melhor que cair na pasta do processo: a pasta do processo é onde
/// mora o executável do AI-BOT, e um `proc.run` ali roda dentro da instalação
/// do aplicativo — o lugar mais errado possível.
///
/// `pub(crate)` porque `video.rs` confina caminhos à MESMA raiz — uma segunda
/// cópia deste estado seria duas verdades sobre qual pasta está aberta.
pub(crate) fn project_root() -> Result<PathBuf, String> {
    let slot = PROJECT_ROOT
        .lock()
        .map_err(|_| "o estado da pasta de projeto ficou inconsistente".to_string())?;
    slot.clone()
        .ok_or_else(|| "esta sessão não tem pasta de projeto aberta — escolha a pasta do projeto antes de usar ferramentas que tocam arquivo ou rodam comando".to_string())
}

/* ------------------------- confinamento de caminho ------------------------ */

/// Devolve o caminho absoluto de `relative` dentro de `root`, recusando
/// qualquer coisa que escape.
///
/// São quatro checagens, e nenhuma delas basta sozinha:
///
/// 1. **texto** — recusa caminho absoluto, raiz (`\pasta`), prefixo de unidade
///    (`C:algo`, que NÃO é absoluto no Windows e ainda assim sai da raiz) e `~`;
/// 2. **componente** — recusa `..` olhando os componentes já normalizados, e
///    não por `contains("..")`, que reprova `arquivo..txt` e aprova `a\..\b`
///    conforme o separador;
/// 3. **prefixo** — compara o candidato com a raiz JÁ canonicalizada, o que
///    pega o que sobrou de qualquer normalização;
/// 4. **symlink** — via `symlink_metadata`, ANTES de qualquer escrita. O
///    caminho `raiz/link` ESTÁ dentro da raiz; escrever nele escreve no ALVO,
///    que pode estar em qualquer lugar do disco. É a checagem que quase todo
///    mundo esquece, e a única que fecha o caso do atalho apontando para fora.
///
/// Quando o alvo não existe (o caso de `office.export` gravando um `.txt`
/// novo), quem é conferido é o PAI: um arquivo criado dentro de um diretório
/// que é atalho nasce do outro lado do atalho.
pub fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim();
    let candidate_relative = if relative.is_empty() { "." } else { relative };

    if candidate_relative.starts_with('~') {
        return Err(format!(
            "o caminho precisa ser relativo à pasta do projeto: {relative:?}"
        ));
    }

    let as_path = Path::new(candidate_relative);
    for component in as_path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!(
                    "o caminho precisa ser relativo à pasta do projeto (sem unidade e sem barra inicial): {relative:?}"
                ))
            }
            Component::ParentDir => {
                return Err(format!(
                    "o caminho não pode sair da pasta do projeto com \"..\": {relative:?}"
                ))
            }
            _ => {}
        }
    }

    // A própria raiz pode estar atrás de um atalho (o caso comum de
    // `C:\Users\...\OneDrive`); comparar contra o caminho não resolvido
    // reprovaria tudo.
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("pasta de projeto inválida ({}): {error}", root.display()))?;

    let candidate = canonical_root.join(as_path);
    if !candidate.starts_with(&canonical_root) {
        return Err(format!(
            "o caminho fica fora da pasta do projeto: {relative:?}"
        ));
    }

    match std::fs::symlink_metadata(&candidate) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "o caminho é um atalho e não pode ser usado: {relative:?}"
                ));
            }
            // Existe e não é atalho: a canonicalização confirma que nenhum
            // pedaço do meio do caminho é atalho para fora.
            let resolved = candidate.canonicalize().map_err(|error| {
                format!("não foi possível resolver {relative:?}: {error}")
            })?;
            if !resolved.starts_with(&canonical_root) {
                return Err(format!(
                    "o caminho aponta para fora da pasta do projeto: {relative:?}"
                ));
            }
            Ok(resolved)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = candidate
                .parent()
                .ok_or_else(|| format!("caminho sem pasta de destino: {relative:?}"))?;
            let resolved_parent = parent.canonicalize().map_err(|error| {
                format!("a pasta de destino de {relative:?} não existe: {error}")
            })?;
            if !resolved_parent.starts_with(&canonical_root) {
                return Err(format!(
                    "a pasta de destino de {relative:?} aponta para fora do projeto"
                ));
            }
            let name = candidate
                .file_name()
                .ok_or_else(|| format!("caminho sem nome de arquivo: {relative:?}"))?;
            Ok(resolved_parent.join(name))
        }
        Err(error) => Err(format!("não foi possível verificar {relative:?}: {error}")),
    }
}

/* --------------------------------- proc.run ------------------------------- */

/// Saída de um processo já colhida.
struct Outcome {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    elapsed: Duration,
    timed_out: bool,
}

fn proc_run(args: &Value) -> Result<String, String> {
    let command = arg_str(args, "command")?;
    if command.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "o comando passa de {MAX_COMMAND_CHARS} caracteres — quebre em passos menores"
        ));
    }
    let root = project_root()?;
    let directory = match arg_opt_str(args, "cwd") {
        Some(cwd) => {
            let resolved = resolve_inside(&root, cwd)?;
            if !resolved.is_dir() {
                return Err(format!("a pasta {cwd:?} não existe dentro do projeto"));
            }
            resolved
        }
        None => root.clone(),
    };

    let timeout = match args.get("timeoutMs").and_then(Value::as_u64) {
        Some(0) => return Err("timeoutMs precisa ser maior que zero".into()),
        Some(millis) => Duration::from_millis(millis).min(MAX_TIMEOUT),
        None => DEFAULT_TIMEOUT,
    };

    let outcome = run_shell(command, &directory, timeout)?;
    Ok(render(command, &root, &directory, &outcome))
}

/// Roda um comando único dentro de um Job Object.
///
/// O job é o que garante que a ÁRVORE morre junto: matar o `cmd.exe` deixaria
/// vivo qualquer neto (`start`, um script que sobe outro processo) rodando com
/// os direitos do usuário. Falha ao criar o job é ERRO, não degradação — rodar
/// sem isolamento enquanto a interface diz "isolado" é mentir. E, como o
/// processo nasce `CREATE_SUSPENDED`, sem job ele também nunca sairia do lugar.
///
/// O ambiente NÃO é limpo, ao contrário da sandbox. Aqui o comando é o que a
/// pessoa aprovou — `pnpm lint`, `cargo check` —, e sem o PATH do usuário
/// nenhum deles existe. Quem quer ambiente limpo usa a sandbox, que é a outra
/// superfície justamente por isso.
fn run_shell(command: &str, directory: &Path, timeout: Duration) -> Result<Outcome, String> {
    let mut process = shell_command(command);
    process
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CREATE_SUSPENDED | CREATE_NO_WINDOW: nasce parado, para ser preso ao job
    // ANTES de rodar (senão, entre o spawn e a captura, ele já teria criado um
    // neto fora do job), e sem console próprio, para não piscar janela preta.
    #[cfg(windows)]
    process.creation_flags(CREATION_FLAGS);

    let jail = Jail::new()
        .map_err(|error| format!("não foi possível criar o isolamento do comando: {error}"))?;

    let start = Instant::now();
    let mut child = process
        .spawn()
        .map_err(|error| format!("não foi possível iniciar o comando: {error}"))?;

    if let Err(error) = jail.capture_and_resume(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("não foi possível isolar o comando: {error}"));
    }

    // A partir daqui o job vive numa `Option` para poder ser FECHADO antes do
    // fim da função: fechar o handle é o que mata a árvore, e há dois momentos
    // em que isso precisa acontecer cedo — o timeout e o cano preso por um neto.
    let mut job = Some(jail);

    // Os dois canos são lidos em threads próprias. Ler um depois do outro
    // trava: o processo enche o cano que ninguém está lendo e para de escrever
    // — é o clássico deadlock de captura de saída.
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_capped(out_pipe));
    let err_reader = std::thread::spawn(move || read_capped(err_pipe));

    let deadline = start + timeout;
    let mut timed_out = false;
    let mut status = None;
    loop {
        match child.try_wait() {
            Ok(Some(finished)) => {
                status = Some(finished);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return Err(format!("não foi possível acompanhar o comando: {error}"));
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    if timed_out {
        // Fechar o handle do job dispara o KILL_ON_JOB_CLOSE e derruba a árvore
        // inteira. Só depois disso os canos fecham e as threads de leitura
        // terminam — sem isso, um neto vivo segurando o cano prenderia o `join`
        // abaixo para sempre.
        drop(job.take());
        let _ = child.kill();
        let _ = child.wait();
    }

    // O processo pode ter TERMINADO deixando neto vivo: `cmd /c start /B algo`
    // faz exatamente isso, e o neto herda os canos. Aí o processo está morto, o
    // `try_wait` já respondeu, e as threads de leitura continuam esperando um
    // cano que ninguém vai fechar. A carência abaixo dá um tempo para a saída
    // normal chegar e, se ela passar, fecha o job — que é o que solta os canos.
    let grace = Instant::now() + PIPE_GRACE;
    while !(out_reader.is_finished() && err_reader.is_finished()) && Instant::now() < grace {
        std::thread::sleep(POLL_INTERVAL);
    }
    if !(out_reader.is_finished() && err_reader.is_finished()) {
        drop(job.take());
    }

    let (stdout, stdout_total) = out_reader.join().unwrap_or_else(|_| (Vec::new(), 0));
    let (stderr, stderr_total) = err_reader.join().unwrap_or_else(|_| (Vec::new(), 0));

    Ok(Outcome {
        exit_code: status.and_then(|status| status.code()),
        stdout: decode_capped(&stdout, stdout_total),
        stderr: decode_capped(&stderr, stderr_total),
        elapsed: start.elapsed(),
        timed_out,
    })
}

/// Monta o processo do shell.
///
/// `cmd.exe /D /S /C`: `/D` ignora os `AutoRun` do registro (comando que
/// alguém deixou para rodar em todo prompt), `/S` fixa a regra de aspas para o
/// resto da linha e `/C` executa e sai.
#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("cmd.exe");
    process.args(["/D", "/S", "/C", command]);
    process
}

/// O AI-BOT é um produto de estação Windows; esta versão existe para o crate
/// compilar e para os testes rodarem fora dela, não como suporte anunciado.
#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("sh");
    process.args(["-c", command]);
    process
}

/// Lê um cano até o fim, guardando no máximo `OUTPUT_LIMIT` bytes.
///
/// Continua LENDO depois do teto, e só para de guardar. Parar de ler encheria o
/// cano e travaria o processo que escreve — o teto é de memória nossa, não de
/// permissão para o outro lado.
fn read_capped<R: Read>(source: Option<R>) -> (Vec<u8>, usize) {
    let Some(mut source) = source else {
        return (Vec::new(), 0);
    };
    let mut kept: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                total += read;
                if kept.len() < OUTPUT_LIMIT {
                    let room = OUTPUT_LIMIT - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
            Err(_) => break,
        }
    }
    (kept, total)
}

/// Decodifica a saída guardada, avisando quando ela foi cortada.
fn decode_capped(bytes: &[u8], total: usize) -> String {
    let mut text = String::from_utf8_lossy(floor_utf8(bytes)).into_owned();
    if total > bytes.len() {
        text.push_str(&format!(
            "\n… (saída cortada: {} de {} bytes)",
            bytes.len(),
            total
        ));
    }
    text
}

/// Recua o corte até o fim de um caractere COMPLETO.
///
/// O teto é contado em bytes e cai no meio de um caractere multibyte quase
/// sempre que a saída tem acento — e `from_utf8_lossy` transformaria essa
/// metade num U+FFFD no fim do texto. Um `dir` de pasta com acento já exibe
/// isso.
fn floor_utf8(bytes: &[u8]) -> &[u8] {
    let mut start = bytes.len();
    // Recua até o byte que INICIA o último caractere (o que não é continuação
    // `10xxxxxx`). Um caractere tem no máximo 4 bytes, então três passos bastam.
    while start > 0 && (bytes[start - 1] & 0b1100_0000) == 0b1000_0000 && bytes.len() - start < 3 {
        start -= 1;
    }
    if start == 0 {
        return bytes;
    }
    let lead = bytes[start - 1];
    let needed = if lead < 0x80 {
        1
    } else if lead >= 0xF0 {
        4
    } else if lead >= 0xE0 {
        3
    } else if lead >= 0xC0 {
        2
    } else {
        // Continuação solta: não é caractere partido pelo corte, é lixo do
        // próprio processo. Deixa passar para o `lossy` marcar.
        1
    };
    if bytes.len() - (start - 1) >= needed {
        bytes
    } else {
        &bytes[..start - 1]
    }
}

/// Monta o texto que o modelo lê.
///
/// Código de saída diferente de zero NÃO vira erro da ferramenta: o comando
/// rodou, e o que ele imprimiu é justamente o que o modelo precisa ler. Devolver
/// `ok: false` faria o modelo concluir que a ferramenta está quebrada e tentar
/// de novo, em vez de ler o erro do compilador que já está na tela.
fn render(command: &str, root: &Path, directory: &Path, outcome: &Outcome) -> String {
    let relative = directory
        .strip_prefix(root)
        .ok()
        .map(|path| path.display().to_string())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| ".".to_string());

    let veredito = if outcome.timed_out {
        format!(
            "INTERROMPIDO por tempo — a árvore de processos foi encerrada depois de {}",
            human(outcome.elapsed)
        )
    } else {
        match outcome.exit_code {
            Some(0) => format!("terminou bem (código 0) em {}", human(outcome.elapsed)),
            Some(code) => format!("terminou com código {code} em {}", human(outcome.elapsed)),
            None => format!(
                "foi encerrado por sinal, sem código de saída, depois de {}",
                human(outcome.elapsed)
            ),
        }
    };

    let mut out = String::new();
    out.push_str(&format!("$ {command}\n"));
    out.push_str(&format!("pasta: {relative}\n"));
    out.push_str(&format!("{veredito}\n"));
    out.push_str("\n--- saída padrão ---\n");
    out.push_str(non_empty(&outcome.stdout));
    out.push_str("\n--- saída de erro ---\n");
    out.push_str(non_empty(&outcome.stderr));
    out
}

fn non_empty(text: &str) -> &str {
    if text.trim().is_empty() {
        "(vazio)"
    } else {
        text
    }
}

/// Duração legível, com vírgula decimal.
fn human(elapsed: Duration) -> String {
    let millis = elapsed.as_millis();
    if millis < 1_000 {
        return format!("{millis} ms");
    }
    format!("{},{} s", millis / 1_000, (millis % 1_000) / 100)
}

/* ----------------------------- diagnostics.run ---------------------------- */

/// Marcadores de projeto, na ordem em que são procurados.
///
/// A ordem é a do caso comum de monorepo: um repositório com `package.json` na
/// raiz e um `Cargo.toml` dentro de `src-tauri` é, para quem abriu a raiz, um
/// projeto de front — e é o `lint` que ele espera ver rodar.
const DIAGNOSTICS: [(&str, &str); 4] = [
    ("package.json", "pnpm -s lint"),
    ("Cargo.toml", "cargo check --message-format short"),
    ("go.mod", "go vet ./..."),
    ("pyproject.toml", "ruff check ."),
];

fn diagnostics_run() -> Result<String, String> {
    let root = project_root()?;
    let found = DIAGNOSTICS
        .iter()
        .copied()
        .find(|(marker, _)| root.join(marker).is_file());

    let Some((marker, command)) = found else {
        let procurados = DIAGNOSTICS
            .iter()
            .map(|(marker, _)| *marker)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "não reconheci o projeto em {}: procurei por {procurados} na raiz e não achei nenhum. \
Rode o verificador com proc.run informando o comando.",
            root.display()
        ));
    };

    // Mesmo caminho do `proc.run`: um segundo executor aqui seria uma segunda
    // regra de isolamento e de timeout para divergir da primeira.
    let outcome = run_shell(command, &root, DIAGNOSTICS_TIMEOUT)?;
    Ok(format!(
        "projeto reconhecido por {marker}\n{}",
        render(command, &root, &root, &outcome)
    ))
}

/* --------------------------------- office --------------------------------- */

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Docx,
    Pptx,
    Xlsx,
    Pdf,
}

fn format_of(path: &str) -> Option<Format> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".docx") {
        Some(Format::Docx)
    } else if lower.ends_with(".pptx") {
        Some(Format::Pptx)
    } else if lower.ends_with(".xlsx") {
        Some(Format::Xlsx)
    } else if lower.ends_with(".pdf") {
        // PDF não é OOXML — não é zip e o texto sai do extrator próprio. Entra
        // aqui porque, para quem usa, "abrir documento" é a mesma ação.
        Some(Format::Pdf)
    } else {
        None
    }
}

type Archive = zip::ZipArchive<std::io::Cursor<Vec<u8>>>;

fn office_open(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let root = project_root()?;
    let path = resolve_inside(&root, relative)?;
    let format = format_of(relative).ok_or_else(|| {
        format!("formato não reconhecido em {relative:?} — sei ler .docx, .pptx, .xlsx e .pdf")
    })?;

    let text = extract_document(&path, format)?;
    if text.trim().is_empty() {
        return Err(format!(
            "{relative} não tem texto extraível — o conteúdo pode ser só imagem, ou estar em partes que este leitor não abre"
        ));
    }
    Ok(cap_document(text))
}

/// Extrai o texto de um documento já resolvido no disco.
fn extract_document(path: &Path, format: Format) -> Result<String, String> {
    if format == Format::Pdf {
        // Abrir um PDF como zip daria "arquivo corrompido" — um erro que
        // mandaria a pessoa procurar problema no arquivo dela.
        return crate::pdf::extract_text(path);
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("não foi possível ler {}: {error}", path.display()))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "o arquivo não é um Office válido (zip corrompido)".to_string())?;
    Ok(match format {
        Format::Docx => extract_docx(&mut archive),
        Format::Pptx => extract_pptx(&mut archive),
        Format::Xlsx => extract_xlsx(&mut archive),
        Format::Pdf => String::new(),
    })
}

fn cap_document(text: String) -> String {
    if text.len() <= MAX_DOCUMENT_TEXT {
        return text;
    }
    let cut = crate::pdf::floor_char_boundary(&text, MAX_DOCUMENT_TEXT);
    format!("{}\n\n[… texto cortado no limite de leitura …]", &text[..cut])
}

/// Texto puro de um trecho de XML: joga fora as tags, decodifica as cinco
/// entidades e trata as tags de bloco como quebra de linha.
///
/// Puro e testável de propósito — é a parte que erra, e o IO em volta é trivial.
fn xml_text(xml: &str, block_tags: &[&str]) -> String {
    let mut out = String::new();
    let mut inside_tag = false;
    let mut tag = String::new();
    for symbol in xml.chars() {
        match symbol {
            '<' => {
                inside_tag = true;
                tag.clear();
            }
            '>' => {
                inside_tag = false;
                let name = tag
                    .trim_start_matches('/')
                    .split([' ', '/'])
                    .next()
                    .unwrap_or_default();
                if block_tags.contains(&name) && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ if inside_tag => tag.push(symbol),
            _ => out.push(symbol),
        }
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // `&amp;` por último: antes dos outros, `&amp;lt;` viraria `<` e o
        // documento perderia o texto que a pessoa escreveu.
        .replace("&amp;", "&")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Colapsa as linhas vazias que o OOXML deixa por parágrafo sem conteúdo.
fn tidy(text: &str) -> String {
    let mut out = String::new();
    let mut blanks = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks <= 1 {
                out.push('\n');
            }
        } else {
            blanks = 0;
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn entry(archive: &mut Archive, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut buffer = String::new();
    file.read_to_string(&mut buffer).ok()?;
    Some(buffer)
}

/// Entradas cujo nome casa prefixo e sufixo, em ordem NUMÉRICA — slide2 antes
/// de slide10, que a ordem lexical inverteria.
fn sorted_entries(archive: &mut Archive, prefix: &str, suffix: &str) -> Vec<String> {
    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|file| file.name().to_string()))
        .filter(|name| name.starts_with(prefix) && name.ends_with(suffix))
        .collect();
    names.sort_by(|left, right| natural_cmp(left, right));
    names
        .iter()
        .filter_map(|name| entry(archive, name))
        .collect()
}

fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    fn number(text: &str) -> u32 {
        text.chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    }
    number(left).cmp(&number(right)).then_with(|| left.cmp(right))
}

fn extract_docx(archive: &mut Archive) -> String {
    let xml = entry(archive, "word/document.xml").unwrap_or_default();
    // `w:p` é parágrafo; `w:br` e `w:tab` são as quebras dentro dele.
    tidy(&xml_text(&xml, &["w:p", "w:br", "w:tab"]))
}

fn extract_pptx(archive: &mut Archive) -> String {
    let slides = sorted_entries(archive, "ppt/slides/slide", ".xml");
    let mut out = String::new();
    for (index, slide) in slides.iter().enumerate() {
        out.push_str(&format!("--- Slide {} ---\n", index + 1));
        out.push_str(&tidy(&xml_text(slide, &["a:p", "a:br"])));
        out.push_str("\n\n");
    }
    out.trim().to_string()
}

/// XLSX guarda o texto numa TABELA COMPARTILHADA e as células referenciam por
/// índice; os números moram nas planilhas. Sem resolver a referência célula a
/// célula, o que sai é o conjunto de textos mais os valores das linhas — o
/// bastante para o modelo LER a planilha, e não o bastante para calcular sobre
/// ela. Dizer isso aqui é melhor que descobrir depois que a coluna não bate.
fn extract_xlsx(archive: &mut Archive) -> String {
    let shared = entry(archive, "xl/sharedStrings.xml").unwrap_or_default();
    let strings = tidy(&xml_text(&shared, &["si"]));
    let sheets = sorted_entries(archive, "xl/worksheets/sheet", ".xml");

    let mut out = String::new();
    if !strings.is_empty() {
        out.push_str("Textos da planilha:\n");
        out.push_str(&strings);
        out.push_str("\n\n");
    }
    for (index, sheet) in sheets.iter().enumerate() {
        let text = tidy(&xml_text(sheet, &["row"]));
        if !text.trim().is_empty() {
            out.push_str(&format!("Planilha {}:\n{text}\n\n", index + 1));
        }
    }
    out.trim().to_string()
}

/* ------------------------------- office.edit ------------------------------ */

/// Dialeto OOXML: onde mora o parágrafo e onde mora o texto.
#[derive(Clone, Copy)]
struct Dialect {
    paragraph: &'static str,
    text: &'static str,
}

const DOCX_DIALECT: Dialect = Dialect {
    paragraph: "w:p",
    text: "w:t",
};
const PPTX_DIALECT: Dialect = Dialect {
    paragraph: "a:p",
    text: "a:t",
};

/// Um nó de texto: onde começa a tag de abertura e onde fica o CONTEÚDO.
#[derive(Clone)]
struct TextSpan {
    tag_start: usize,
    content: std::ops::Range<usize>,
}

/// Escapa para chardata XML.
///
/// **A única forma de este código corromper um documento é esquecer isto**: um
/// `&` ou `<` cru gera XML malformado e o Word abre com "conteúdo ilegível".
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for symbol in text.chars() {
        match symbol {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(symbol),
        }
    }
    out
}

/// A posição é o fim do NOME da tag?
///
/// Sem esta checagem, procurar por `<w:t` casaria `<w:tab>`, `<w:tbl>`,
/// `<w:trPr>` e `<w:tcPr>` — e o texto seria escrito dentro de uma tabela,
/// destruindo o documento.
fn is_tag_boundary(xml: &str, after: usize) -> bool {
    matches!(xml.as_bytes().get(after), Some(b'>' | b' ' | b'/'))
}

fn text_spans(xml: &str, dialect: &Dialect) -> Vec<TextSpan> {
    let open = format!("<{}", dialect.text);
    let close = format!("</{}>", dialect.text);
    let mut spans = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = xml[cursor..].find(&open) {
        let tag_start = cursor + found;
        let after = tag_start + open.len();
        if !is_tag_boundary(xml, after) {
            cursor = after;
            continue;
        }
        let Some(gt) = xml[tag_start..].find('>') else {
            break;
        };
        let open_end = tag_start + gt + 1;
        // `<w:t/>` é vazio: não tem conteúdo para casar.
        if xml.as_bytes().get(open_end.saturating_sub(2)) == Some(&b'/') {
            cursor = open_end;
            continue;
        }
        let Some(relative_close) = xml[open_end..].find(&close) else {
            break;
        };
        let content_end = open_end + relative_close;
        spans.push(TextSpan {
            tag_start,
            content: open_end..content_end,
        });
        cursor = content_end + close.len();
    }
    spans
}

fn paragraph_ranges(xml: &str, dialect: &Dialect) -> Vec<std::ops::Range<usize>> {
    let open = format!("<{}", dialect.paragraph);
    let close = format!("</{}>", dialect.paragraph);
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = xml[cursor..].find(&open) {
        let start = cursor + found;
        let after = start + open.len();
        if !is_tag_boundary(xml, after) {
            cursor = after;
            continue;
        }
        let Some(gt) = xml[start..].find('>') else {
            break;
        };
        let body_start = start + gt + 1;
        match xml[body_start..].find(&close) {
            Some(relative) => {
                out.push(body_start..body_start + relative);
                cursor = body_start + relative + close.len();
            }
            None => break,
        }
    }
    out
}

/// O parágrafo está sob controle de alterações ou é código de campo?
///
/// - `<w:ins>`/`<w:del>`: escrever ali atribui o texto do modelo ao revisor
///   humano original no painel de revisão do Word;
/// - `<w:instrText>`: é o CÓDIGO do campo (índice, mala direta). Escrever ali
///   muda a semântica do campo, não o texto que se vê.
fn is_protected(paragraph: &str) -> bool {
    paragraph.contains("<w:ins ")
        || paragraph.contains("<w:ins>")
        || paragraph.contains("<w:del ")
        || paragraph.contains("<w:del>")
        || paragraph.contains("<w:instrText")
}

/// Sem `xml:space="preserve"` o Word COME os espaços das bordas e a palavra
/// gruda na vizinha.
fn needs_preserve(value: &str) -> bool {
    value.starts_with(' ') || value.ends_with(' ')
}

/// Índice do span e deslocamento dentro dele, para uma posição do texto
/// concatenado.
fn span_at(map: &[(usize, usize)], spans: &[TextSpan], position: usize) -> Option<(usize, usize)> {
    for (offset, index) in map {
        let length = spans[*index].content.len();
        if position >= *offset && position < offset + length {
            return Some((*index, position - offset));
        }
    }
    None
}

/// Onde inserir `xml:space="preserve"` — logo depois do nome da tag, e só se
/// ainda não existir.
fn preserve_insert(xml: &str, tag_start: usize, dialect: &Dialect) -> Option<usize> {
    let gt = xml[tag_start..].find('>')? + tag_start;
    if xml[tag_start..gt].contains("xml:space") {
        return None;
    }
    Some(tag_start + 1 + dialect.text.len())
}

/// Substitui `needle` por `value` casando no texto CONCATENADO de cada
/// parágrafo. Devolve o XML novo e quantas ocorrências trocou.
///
/// ## Por que não é um `replace` dentro de cada `<w:t>`
///
/// O Word FRAGMENTA o texto em vários `<w:t>` por revisão, correção ortográfica
/// e `w:proofErr` — não só por formatação. Num documento real medido, 92% dos
/// parágrafos tinham mais de um nó de texto, com mediana de três caracteres por
/// nó. Uma agulha que atravessa a fronteira de dois nós faz o `replace` ingênuo
/// substituir ZERO ocorrências — e reportar "pronto".
///
/// Por isso o casamento acontece no texto concatenado do parágrafo, com um mapa
/// de volta para os spans: o valor entra no primeiro span coberto, o resto do
/// último span é esvaziado e os do meio ficam vazios. NENHUMA TAG NASCE OU
/// MORRE — é isso que mantém `w:rPr`, `w:pStyle`, `w:numPr`, marcadores e
/// relações intactos, e é por isso que o zip não precisa ser reconstruído
/// inteiro.
///
/// Puro: não toca em disco. Toda a lógica arriscada está aqui, separada do IO.
fn replace_in_xml(xml: &str, needle: &str, value: &str, dialect: &Dialect) -> (String, usize) {
    if needle.is_empty() {
        return (xml.to_string(), 0);
    }
    // A agulha vem como texto puro; o XML guarda `A &amp; B`.
    let needle_xml = escape_xml(needle);
    let value_xml = escape_xml(value);

    // Edições acumuladas como (intervalo absoluto, texto novo), aplicadas do
    // fim para o começo — assim os deslocamentos anteriores continuam válidos.
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    let mut replaced = 0usize;

    for paragraph in paragraph_ranges(xml, dialect) {
        let body = &xml[paragraph.clone()];
        if is_protected(body) {
            continue;
        }
        let spans = text_spans(body, dialect);
        if spans.is_empty() {
            continue;
        }

        let mut flat = String::new();
        let mut map: Vec<(usize, usize)> = Vec::new();
        for (index, span) in spans.iter().enumerate() {
            map.push((flat.len(), index));
            flat.push_str(&body[span.content.clone()]);
        }

        let mut hits: Vec<usize> = Vec::new();
        let mut from = 0usize;
        while let Some(found) = flat[from..].find(&needle_xml) {
            let at = from + found;
            hits.push(at);
            from = at + needle_xml.len();
        }
        if hits.is_empty() {
            continue;
        }

        for hit in hits.iter().rev() {
            let start = *hit;
            let end = start + needle_xml.len();
            let (Some(first), Some(last)) = (
                span_at(&map, &spans, start),
                span_at(&map, &spans, end.saturating_sub(1)),
            ) else {
                continue;
            };
            let (first_index, first_offset) = first;
            let (last_index, last_offset) = last;
            let first_span = &spans[first_index];
            let last_span = &spans[last_index];

            if first_index == last_index {
                let absolute = paragraph.start + first_span.content.start + first_offset;
                edits.push((absolute..absolute + needle_xml.len(), value_xml.clone()));
            } else {
                // Atravessa nós: valor no primeiro, meio esvaziado, sobra do
                // último removida.
                let first_start = paragraph.start + first_span.content.start + first_offset;
                let first_end = paragraph.start + first_span.content.end;
                edits.push((first_start..first_end, value_xml.clone()));
                for span in &spans[(first_index + 1)..last_index] {
                    edits.push((
                        paragraph.start + span.content.start..paragraph.start + span.content.end,
                        String::new(),
                    ));
                }
                let last_start = paragraph.start + last_span.content.start;
                edits.push((last_start..last_start + last_offset + 1, String::new()));
            }

            if needs_preserve(value) {
                if let Some(insert) =
                    preserve_insert(xml, paragraph.start + first_span.tag_start, dialect)
                {
                    edits.push((insert..insert, " xml:space=\"preserve\"".to_string()));
                }
            }
            replaced += 1;
        }
    }

    if edits.is_empty() {
        return (xml.to_string(), 0);
    }
    // UMA passada, do começo para o fim, montando o XML novo em pedaços.
    //
    // # Por que não é mais `replace_range` de trás para frente
    //
    // A versão anterior copiava o XML inteiro e aplicava cada edição com
    // `replace_range`, do fim para o começo — correto, mas CARO do jeito que
    // não aparece em documento pequeno: toda edição que muda o tamanho do texto
    // MOVE todo o resto da string. O custo cresce com o produto "tamanho do
    // documento × número de ocorrências", ou seja, com o QUADRADO num
    // "substituir tudo" de verdade. Medido num contrato de 1,2 MB com 750
    // ocorrências: 119 ms contra 13 ms do mesmo documento sem nenhuma
    // ocorrência — quase todo o tempo era memória sendo arrastada.
    //
    // Aqui o XML é lido uma vez só: copia-se o trecho entre uma edição e a
    // seguinte, depois o texto novo. Nada é movido duas vezes.
    //
    // # Por que a ordem direta é segura
    //
    // As edições são DISJUNTAS por construção — as ocorrências não se
    // sobrepõem (o `from` da busca pula o comprimento da agulha) e cada uma
    // toca spans distintos; a inserção do `xml:space` cai dentro da TAG de
    // abertura, que nenhum intervalo de conteúdo cobre. Com intervalos
    // disjuntos, percorrer em ordem crescente produz exatamente o mesmo texto
    // que a aplicação de trás para frente produzia.
    edits.sort_by_key(|edit| edit.0.start);
    let mut out = String::with_capacity(xml.len() + value_xml.len() * replaced);
    let mut cursor = 0usize;
    for (range, text) in &edits {
        // Rede contra sobreposição: fatiar o XML num índice que o cursor já
        // passou entraria em PÂNICO, e pânico aqui derruba a ferramenta com um
        // "erro desconhecido" no meio de uma edição de arquivo.
        if range.start < cursor {
            continue;
        }
        out.push_str(&xml[cursor..range.start]);
        out.push_str(text);
        cursor = range.end;
    }
    out.push_str(&xml[cursor..]);
    (out, replaced)
}

/// Partes do DOCX que carregam texto visível.
///
/// Substituir só em `document.xml` faria um "substituir tudo" PARCIAL e
/// silencioso: cabeçalho, rodapé e notas de um contrato ficariam com o texto
/// antigo, e o número devolvido ao modelo estaria errado.
fn docx_text_parts(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| {
            name.as_str() == "word/document.xml"
                || (name.starts_with("word/header") && name.ends_with(".xml"))
                || (name.starts_with("word/footer") && name.ends_with(".xml"))
                || name.as_str() == "word/footnotes.xml"
                || name.as_str() == "word/endnotes.xml"
        })
        .cloned()
        .collect()
}

fn pptx_text_parts(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .cloned()
        .collect()
}

fn office_edit(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let needle = arg_str(args, "find")?;
    // O valor PODE ser vazio: apagar um trecho é edição legítima.
    let value = args.get("replace").and_then(Value::as_str).unwrap_or("");

    let dialect = match format_of(relative) {
        Some(Format::Docx) => DOCX_DIALECT,
        Some(Format::Pptx) => PPTX_DIALECT,
        Some(Format::Xlsx) => {
            // O texto do XLSX mora numa tabela compartilhada indexada por
            // célula, e a mesma string costuma ser referenciada por várias
            // células. Trocar ali muda células que ninguém pediu — recusar é
            // melhor que editar a célula errada.
            return Err(
                "edição de XLSX ainda não é suportada (só .docx e .pptx)".to_string()
            );
        }
        _ => return Err(format!("formato não suportado em {relative:?} (só .docx e .pptx)")),
    };

    let root = project_root()?;
    let path = resolve_inside(&root, relative)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("não foi possível ler {relative}: {error}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "o arquivo não é um Office válido (zip corrompido)".to_string())?;

    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|file| file.name().to_string()))
        .collect();
    let targets = if dialect.text == DOCX_DIALECT.text {
        docx_text_parts(&names)
    } else {
        pptx_text_parts(&names)
    };

    // 1ª passada: calcula o XML novo de cada parte que tem ocorrência.
    let mut rewritten: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut replaced = 0usize;
    for name in &targets {
        let mut buffer = String::new();
        let read = match archive.by_name(name) {
            Ok(mut file) => file.read_to_string(&mut buffer).is_ok(),
            Err(_) => false,
        };
        if !read {
            continue;
        }
        let (novo, count) = replace_in_xml(&buffer, needle, value, &dialect);
        if count > 0 {
            replaced += count;
            rewritten.insert(name.clone(), novo);
        }
    }
    if replaced == 0 {
        return Err(format!(
            "nenhuma ocorrência de {needle:?} em {relative} — abra o documento com office.open e copie o texto exato"
        ));
    }

    // 2ª passada: reescreve o zip. As partes não tocadas são copiadas JÁ
    // COMPRIMIDAS, preservando ordem, CRC e método de compressão.
    let mut output = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = zip::ZipWriter::new(&mut output);
        for index in 0..archive.len() {
            let file = archive
                .by_index_raw(index)
                .map_err(|error| format!("não foi possível ler o pacote: {error}"))?;
            let name = file.name().to_string();
            match rewritten.get(&name) {
                Some(content) => {
                    drop(file);
                    writer
                        .start_file(&name, zip::write::SimpleFileOptions::default())
                        .map_err(|error| format!("não foi possível gravar {name}: {error}"))?;
                    writer
                        .write_all(content.as_bytes())
                        .map_err(|error| format!("não foi possível gravar {name}: {error}"))?;
                }
                None => writer
                    .raw_copy_file(file)
                    .map_err(|error| format!("não foi possível copiar {name}: {error}"))?,
            }
        }
        writer
            .finish()
            .map_err(|error| format!("não foi possível fechar o pacote: {error}"))?;
    }

    // Escrita ATÔMICA: monta em memória, grava num temporário AO LADO do
    // destino (mesmo volume, para o rename ser atômico) e só então substitui.
    // Um corte no meio da serialização deixaria um `.docx` truncado e
    // irrecuperável — ao contrário de um `.md`, onde ao menos sobra o texto.
    let temporary = path.with_extension("aibot-tmp");
    // Um temporário que já existe pode ser um atalho plantado apontando para
    // fora; `remove_file` não segue atalho, `write` seguiria.
    if std::fs::symlink_metadata(&temporary).is_ok() {
        std::fs::remove_file(&temporary)
            .map_err(|error| format!("não foi possível limpar o arquivo temporário: {error}"))?;
    }
    std::fs::write(&temporary, output.into_inner())
        .map_err(|error| format!("não foi possível gravar o arquivo temporário: {error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("não foi possível substituir {relative}: {error}")
    })?;

    let mut parts: Vec<String> = rewritten.into_keys().collect();
    parts.sort();
    Ok(format!(
        "{replaced} ocorrência(s) de {needle:?} trocadas em {relative} (partes: {})",
        parts.join(", ")
    ))
}

/* ------------------------------ office.export ----------------------------- */

fn office_export(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let format = arg_str(args, "format")?.to_ascii_lowercase();
    if format != "txt" {
        // PDF e DOCX de saída exigem um MOTOR de documento (layout, fonte,
        // paginação), não um serializador. Prometer "exporta para pdf" e
        // entregar texto renomeado seria pior do que recusar.
        return Err(format!(
            "por ora só exporto para \"txt\" — {format:?} precisa de um motor de documento que esta máquina não tem"
        ));
    }

    let source_format = format_of(relative).ok_or_else(|| {
        format!("formato não reconhecido em {relative:?} — sei ler .docx, .pptx, .xlsx e .pdf")
    })?;
    let root = project_root()?;
    let source = resolve_inside(&root, relative)?;
    let text = extract_document(&source, source_format)?;
    if text.trim().is_empty() {
        return Err(format!("{relative} não tem texto para exportar"));
    }

    // O destino é derivado do caminho RELATIVO e passa pelo mesmo confinamento:
    // um `.txt` já existente pode ser um atalho apontando para fora do projeto.
    let destination_relative = Path::new(relative).with_extension("txt");
    let destination_relative = destination_relative.to_string_lossy().into_owned();
    let destination = resolve_inside(&root, &destination_relative)?;

    std::fs::write(&destination, text.as_bytes())
        .map_err(|error| format!("não foi possível gravar {destination_relative}: {error}"))?;
    Ok(format!(
        "texto exportado para {destination_relative} ({} bytes)",
        text.len()
    ))
}

/* ------------------------------- pdf.extract ------------------------------ */

fn pdf_extract(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let root = project_root()?;
    let path = resolve_inside(&root, relative)?;
    let text = crate::pdf::extract_text(&path)?;
    Ok(cap_document(text))
}

/* ----------------------------- runtime.status ----------------------------- */

/// Estado do runtime local de modelos.
///
/// "Não está rodando" é uma RESPOSTA, não uma falha da ferramenta: quem
/// perguntou queria justamente saber isso. Devolver erro faria o modelo tratar
/// a ausência do runtime como defeito do host e tentar de novo.
fn runtime_status() -> Result<String, String> {
    match crate::gateway::loopback_get(RUNTIME_AUTHORITY, "/v1/models", RUNTIME_TIMEOUT) {
        Ok(reply) if reply.status == 200 => Ok(format!(
            "o runtime local está de pé em http://{RUNTIME_AUTHORITY}\nmodelos: {}",
            reply.body.trim()
        )),
        Ok(reply) => Ok(format!(
            "o runtime local respondeu HTTP {} em http://{RUNTIME_AUTHORITY} — está subindo ou sem modelo carregado",
            reply.status
        )),
        Err(error) => Ok(format!(
            "o runtime local NÃO está rodando em http://{RUNTIME_AUTHORITY} ({error}). \
Os modelos locais ficam indisponíveis até ele subir; os modelos de provedor seguem funcionando."
        )),
    }
}

/* ------------------- term.open: por que ela NÃO está aqui ----------------- */

// A ferramenta existia e foi RETIRADA — junto com o gancho `set_terminal_opener`
// que o `lib.rs` preenchia no boot.
//
// O motivo é o mesmo do cabeçalho deste arquivo, virado do avesso: ela devolvia
// "terminal aberto para a pessoa usar (sessão pty-3)" e NÃO EXISTE painel de
// terminal na interface. Ninguém via nada. O sucesso era verdadeiro do lado do
// sistema (o ConPTY abria, o shell subia) e mentira do lado do produto: o modelo
// lia "abri o terminal" e seguia raciocinando em cima de uma janela que a pessoa
// não tem. Pior, cada chamada deixava um `powershell.exe` invisível vivo e uma
// sessão no mapa; como o teto é de oito, na nona chamada a ferramenta passava a
// recusar para sempre, sem que nada na tela explicasse por quê.
//
// Ferramenta ausente é melhor que ferramenta que promete o que não entrega: o
// modelo que não a encontra usa `proc.run`, que passa pelo portão de aprovação e
// cuja saída a pessoa realmente lê.
//
// COMO ELA VOLTA: quando a interface tiver painel de terminal (xterm.js ligado
// em `pty-data`/`pty_write`), volta o gancho no `lib.rs`, volta o `term_open`
// aqui, volta o braço no `execute` e volta o `RegisterHost("term.open")` no
// gateway Go. Os comandos `pty_*` continuam todos de pé — não é preciso
// reescrever nada do PTY, só religar as pontas. E a regra que não muda em
// nenhuma dessas voltas: `pty_write` NÃO é ferramenta.

/* -------------------------------- argumentos ------------------------------ */

/// Argumento de texto obrigatório e não vazio. `pub(crate)` para `video.rs`
/// validar argumentos com as MESMAS mensagens que o resto das ferramentas.
pub(crate) fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("falta o argumento \"{key}\" (texto)"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("o argumento \"{key}\" não pode ser vazio"));
    }
    Ok(trimmed)
}

/// Argumento de texto opcional; branco conta como ausente.
pub(crate) fn arg_opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ferramenta_desconhecida_nunca_devolve_sucesso_vazio() {
        let erro = execute("fs.write", &json!({})).expect_err("deveria recusar");
        assert!(erro.contains("não é servida por esta máquina"), "veio: {erro}");
        assert!(erro.contains("proc.run"), "o erro deveria listar o que existe");
    }

    /// `term.open` abria um terminal que a interface não mostra: sucesso de
    /// mentira, um shell invisível por chamada e, na nona, recusa permanente
    /// pelo teto de sessões. Enquanto não houver painel de terminal na tela, a
    /// resposta certa é RECUSAR — e a recusa não pode citar a ferramenta na
    /// lista do que existe, senão o modelo tenta de novo achando que errou o
    /// nome.
    #[test]
    fn term_open_nao_e_servida_enquanto_nao_houver_painel_de_terminal() {
        let erro = execute("term.open", &json!({})).expect_err(
            "term.open não pode responder sucesso: não existe painel de terminal na interface",
        );
        assert!(erro.contains("não é servida por esta máquina"), "veio: {erro}");
        let lista = erro.split("são:").nth(1).unwrap_or_default();
        assert!(
            !lista.contains("term.open"),
            "a lista do que esta máquina serve não pode oferecer term.open: {lista}"
        );
    }

    #[test]
    fn argumento_obrigatorio_ausente_tem_mensagem_util() {
        let erro = arg_str(&json!({}), "command").expect_err("deveria recusar");
        assert!(erro.contains("command"), "veio: {erro}");
    }

    #[test]
    fn argumento_em_branco_conta_como_ausente() {
        assert!(arg_str(&json!({ "command": "   " }), "command").is_err());
        assert_eq!(arg_opt_str(&json!({ "cwd": "  " }), "cwd"), None);
        assert_eq!(arg_opt_str(&json!({ "cwd": " app " }), "cwd"), Some("app"));
    }

    /* ------------------------- confinamento ------------------------- */

    fn temp_root(nome: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aibot-tools-{nome}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("criar raiz de teste");
        dir.canonicalize().expect("canonicalizar raiz de teste")
    }

    #[test]
    fn caminho_relativo_simples_e_aceito() {
        let root = temp_root("relativo");
        std::fs::write(root.join("nota.txt"), b"oi").expect("gravar");
        let resolvido = resolve_inside(&root, "nota.txt").expect("deveria aceitar");
        assert!(resolvido.starts_with(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caminho_absoluto_e_recusado() {
        let root = temp_root("absoluto");
        // A forma de "sair pela raiz" muda com a plataforma, e o teste precisa
        // usar a da plataforma em que roda: `C:\...` no Unix é um nome de
        // arquivo válido, e `/etc/passwd` no Windows não tem unidade.
        let alvo = if cfg!(windows) {
            "C:\\Windows\\System32\\drivers\\etc\\hosts"
        } else {
            "/etc/passwd"
        };
        let erro = resolve_inside(&root, alvo).expect_err("deveria recusar");
        assert!(erro.contains("relativo"), "veio: {erro}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn subida_com_ponto_ponto_e_recusada() {
        let root = temp_root("subida");
        let alvo = if cfg!(windows) {
            "..\\segredo.txt"
        } else {
            "../segredo.txt"
        };
        let erro = resolve_inside(&root, alvo).expect_err("deveria recusar");
        assert!(erro.contains(".."), "veio: {erro}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `arquivo..txt` tem dois pontos e NÃO é uma subida — recusá-lo seria
    /// falso positivo do filtro textual ingênuo.
    #[test]
    fn nome_com_dois_pontos_nao_e_confundido_com_subida() {
        let root = temp_root("dois-pontos");
        std::fs::write(root.join("versao..txt"), b"1").expect("gravar");
        assert!(resolve_inside(&root, "versao..txt").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn destino_inexistente_e_aceito_quando_a_pasta_esta_dentro() {
        let root = temp_root("novo");
        std::fs::create_dir_all(root.join("saida")).expect("criar pasta");
        let destino = resolve_inside(&root, "saida/relatorio.txt").expect("deveria aceitar");
        assert!(destino.starts_with(&root));
        assert!(destino.ends_with("relatorio.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pasta_de_destino_inexistente_e_recusada() {
        let root = temp_root("sem-pasta");
        let erro = resolve_inside(&root, "nao/existe/arquivo.txt").expect_err("deveria recusar");
        assert!(erro.contains("não existe"), "veio: {erro}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /* ---------------------------- saída ----------------------------- */

    /// O corte em bytes cai no meio do acento quase sempre; o pedaço partido
    /// não pode virar U+FFFD no fim do texto.
    #[test]
    fn corte_de_saida_nao_parte_caractere() {
        let texto = "aá".as_bytes(); // [0x61, 0xC3, 0xA1]
        assert_eq!(floor_utf8(&texto[..2]), &texto[..1]);
        assert_eq!(floor_utf8(texto), texto);
    }

    #[test]
    fn saida_cortada_avisa_o_tamanho() {
        let texto = decode_capped(b"abc", 4096);
        assert!(texto.contains("cortada"), "veio: {texto}");
        assert!(texto.contains("4096"), "veio: {texto}");
    }

    #[test]
    fn saida_vazia_vira_marcador_legivel() {
        assert_eq!(non_empty("   "), "(vazio)");
        assert_eq!(non_empty("ok"), "ok");
    }

    /* ---------------------------- office ---------------------------- */

    #[test]
    fn extrai_texto_e_decodifica_entidades() {
        let xml = r#"<w:p><w:r><w:t>Olá &amp; bem-vindo</w:t></w:r></w:p>"#;
        assert_eq!(xml_text(xml, &["w:p"]).trim(), "Olá & bem-vindo");
    }

    #[test]
    fn entidade_amp_nao_e_desfeita_em_cascata() {
        // `&amp;lt;` tem de virar `&lt;`, e não `<`: senão o texto perde dado.
        assert_eq!(xml_text("<w:t>a &amp;lt; b</w:t>", &["w:p"]).trim(), "a &lt; b");
    }

    #[test]
    fn cada_paragrafo_vira_uma_linha() {
        let xml = "<w:p><w:t>linha um</w:t></w:p><w:p><w:t>linha dois</w:t></w:p>";
        assert_eq!(tidy(&xml_text(xml, &["w:p", "w:br"])), "linha um\nlinha dois");
    }

    #[test]
    fn ordem_natural_slide2_antes_de_slide10() {
        assert_eq!(
            natural_cmp("slide2.xml", "slide10.xml"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn formato_reconhecido_por_extensao() {
        assert!(matches!(format_of("relatorio.DOCX"), Some(Format::Docx)));
        assert!(matches!(format_of("slides.pptx"), Some(Format::Pptx)));
        assert!(matches!(format_of("planilha.xlsx"), Some(Format::Xlsx)));
        assert!(matches!(format_of("contrato.pdf"), Some(Format::Pdf)));
        assert!(format_of("nota.txt").is_none());
    }

    /* -------------------------- office.edit ------------------------- */

    fn paragrafo(inner: &str) -> String {
        format!("<w:document><w:body><w:p>{inner}</w:p></w:body></w:document>")
    }

    #[test]
    fn troca_dentro_de_um_unico_no() {
        let xml = paragrafo("<w:r><w:t>Olá mundo</w:t></w:r>");
        let (out, trocas) = replace_in_xml(&xml, "mundo", "Multiplike", &DOCX_DIALECT);
        assert_eq!(trocas, 1);
        assert!(out.contains("<w:t>Olá Multiplike</w:t>"), "saiu: {out}");
    }

    /// O caso que o `replace` ingênuo perde: o Word parte o texto em vários
    /// `<w:t>` e a agulha atravessa a fronteira.
    #[test]
    fn troca_agulha_que_atravessa_dois_nos() {
        let xml = paragrafo("<w:r><w:t>Ola Mul</w:t></w:r><w:r><w:t>tiplike hoje</w:t></w:r>");
        let (out, trocas) = replace_in_xml(&xml, "Multiplike", "ACME", &DOCX_DIALECT);
        assert_eq!(trocas, 1, "deveria achar atravessando nós; saiu: {out}");
        assert!(xml_text(&out, &["w:p"]).contains("Ola ACME hoje"), "saiu: {out}");
    }

    #[test]
    fn agulha_em_tres_nos_esvazia_o_do_meio() {
        let xml = paragrafo(
            "<w:r><w:t>abc</w:t></w:r><w:r><w:t>DEF</w:t></w:r><w:r><w:t>ghi</w:t></w:r>",
        );
        let (out, trocas) = replace_in_xml(&xml, "cDEFg", "-", &DOCX_DIALECT);
        assert_eq!(trocas, 1);
        assert_eq!(xml_text(&out, &["w:p"]).trim(), "ab-hi");
    }

    /// Nenhuma tag pode nascer ou morrer — é o que preserva estilo e numeração.
    #[test]
    fn contagem_de_tags_nao_muda() {
        let xml = paragrafo(
            "<w:r><w:rPr><w:b/></w:rPr><w:t>Ola Mul</w:t></w:r><w:r><w:t>tiplike</w:t></w:r>",
        );
        let (out, _) = replace_in_xml(&xml, "Multiplike", "ACME", &DOCX_DIALECT);
        assert_eq!(xml.matches("<w:t>").count(), out.matches("<w:t>").count());
        assert_eq!(xml.matches("<w:r>").count(), out.matches("<w:r>").count());
        assert!(out.contains("<w:b/>"), "a formatação foi perdida: {out}");
    }

    /// A única forma de corromper o arquivo — e é 100% evitável.
    #[test]
    fn valor_com_caractere_especial_e_escapado() {
        let xml = paragrafo("<w:r><w:t>empresa</w:t></w:r>");
        let (out, trocas) = replace_in_xml(&xml, "empresa", "A & B <ltda>", &DOCX_DIALECT);
        assert_eq!(trocas, 1);
        assert!(out.contains("A &amp; B &lt;ltda&gt;"), "saiu: {out}");
        assert!(!out.contains("B <ltda>"), "XML cru vazou: {out}");
    }

    /// `<w:tab>` e `<w:tbl>` começam com `<w:t` — casar por prefixo escreveria
    /// dentro de uma tabela.
    #[test]
    fn tag_parecida_nao_e_confundida_com_texto() {
        let xml = paragrafo("<w:r><w:tab/><w:t>alvo</w:t></w:r>");
        let spans = text_spans(&xml, &DOCX_DIALECT);
        assert_eq!(spans.len(), 1, "só o <w:t> é nó de texto");
    }

    /// Texto sob controle de alterações é do revisor humano — não se mexe.
    #[test]
    fn paragrafo_com_revisao_e_pulado() {
        let xml = paragrafo("<w:ins w:author=\"Ana\"><w:r><w:t>empresa</w:t></w:r></w:ins>");
        let (_, trocas) = replace_in_xml(&xml, "empresa", "ACME", &DOCX_DIALECT);
        assert_eq!(trocas, 0);
    }

    #[test]
    fn espaco_na_borda_ganha_preserve() {
        let xml = paragrafo("<w:r><w:t>a-b</w:t></w:r>");
        let (out, trocas) = replace_in_xml(&xml, "a-b", " a b ", &DOCX_DIALECT);
        assert_eq!(trocas, 1);
        assert!(out.contains("xml:space=\"preserve\""), "saiu: {out}");
    }

    #[test]
    fn pptx_usa_o_dialeto_proprio() {
        let xml = "<a:p><a:r><a:t>Abertura</a:t></a:r></a:p>";
        let (out, trocas) = replace_in_xml(xml, "Abertura", "Encerramento", &PPTX_DIALECT);
        assert_eq!(trocas, 1);
        assert!(out.contains("<a:t>Encerramento</a:t>"), "saiu: {out}");
    }

    /* ---------------------- medição (ver src/bench.rs) --------------------- */

    /// Um `word/document.xml` REALISTA — e "realista" aqui é o que o comentário
    /// do `replace_in_xml` mede em documento de verdade: 92% dos parágrafos com
    /// mais de um `<w:t>`, mediana de três caracteres por nó.
    ///
    /// Por isso os parágrafos abaixo vêm FRAGMENTADOS, com `w:rPr`, `w:proofErr`
    /// e `w:bookmarkStart` no meio, e a agulha atravessando fronteira de nó. Um
    /// corpus com um `<w:t>` por parágrafo mediria o caso fácil e esconderia
    /// justamente o custo que o algoritmo existe para pagar.
    fn corpus_document_xml(paragrafos: usize) -> String {
        let mut out = String::with_capacity(paragrafos * 420);
        out.push_str(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document><w:body>"#,
        );
        for indice in 0..paragrafos {
            out.push_str(r#"<w:p><w:pPr><w:pStyle w:val="Corpo"/></w:pPr>"#);
            // Parágrafo comum, partido como o Word parte.
            out.push_str(r#"<w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>Cláusula </w:t></w:r>"#);
            out.push_str(&format!(r#"<w:r><w:t>{}</w:t></w:r>"#, indice + 1));
            out.push_str(r#"<w:proofErr w:type="spellStart"/>"#);
            out.push_str(r#"<w:r><w:t> — a </w:t></w:r><w:r><w:t>parte</w:t></w:r>"#);
            out.push_str(r#"<w:r><w:t> contratante d</w:t></w:r>"#);
            if indice % 4 == 0 {
                // A agulha ATRAVESSANDO a fronteira de dois nós: o caso caro.
                out.push_str(r#"<w:r><w:t>a Multi</w:t></w:r><w:r><w:t>plike </w:t></w:r>"#);
            } else {
                out.push_str(r#"<w:r><w:t>a empresa </w:t></w:r>"#);
            }
            out.push_str(r#"<w:bookmarkStart w:id="1" w:name="_Ref1"/>"#);
            out.push_str(
                r#"<w:r><w:t>obriga-se a cumprir o disposto nesta seção do contrato.</w:t></w:r>"#,
            );
            out.push_str("</w:p>");
        }
        out.push_str("</w:body></w:document>");
        out
    }

    /// A substituição no texto concatenado, num contrato de ~3 mil parágrafos.
    #[test]
    #[ignore = "medição; rode com: cargo test --release -- --ignored --nocapture"]
    fn bench_replace_in_xml_documento_grande() {
        let xml = corpus_document_xml(3_000);
        let (tempo, (saida, trocas)) =
            crate::bench::median(|| replace_in_xml(&xml, "Multiplike", "ACME S.A.", &DOCX_DIALECT));
        assert_eq!(trocas, 750, "o corpus tem uma agulha a cada quatro parágrafos");
        assert!(saida.contains("ACME S.A."), "a troca não saiu no XML");
        crate::bench::report(
            "tools::replace_in_xml",
            &format!("{} KiB / {trocas} trocas", xml.len() / 1024),
            tempo,
            xml.len() as f64 / (1024.0 * 1024.0),
            "MiB",
        );
    }

    /// O caso em que a agulha NÃO existe: `office.edit` paga a varredura inteira
    /// antes de poder dizer "nenhuma ocorrência", e paga em toda parte do pacote
    /// (cabeçalho, rodapé, notas).
    #[test]
    #[ignore = "medição; rode com: cargo test --release -- --ignored --nocapture"]
    fn bench_replace_in_xml_sem_ocorrencia() {
        let xml = corpus_document_xml(3_000);
        let (tempo, (_, trocas)) = crate::bench::median(|| {
            replace_in_xml(&xml, "agulha que não existe", "x", &DOCX_DIALECT)
        });
        assert_eq!(trocas, 0);
        crate::bench::report(
            "tools::replace_in_xml (0 hits)",
            &format!("{} KiB", xml.len() / 1024),
            tempo,
            xml.len() as f64 / (1024.0 * 1024.0),
            "MiB",
        );
    }

    /// O caminho do `office.open`: XML inteiro para texto puro.
    #[test]
    #[ignore = "medição; rode com: cargo test --release -- --ignored --nocapture"]
    fn bench_xml_text_documento_grande() {
        let xml = corpus_document_xml(3_000);
        let (tempo, texto) = crate::bench::median(|| tidy(&xml_text(&xml, &["w:p", "w:br", "w:tab"])));
        assert!(texto.contains("Cláusula 1"), "a extração não leu o corpus");
        crate::bench::report(
            "tools::xml_text + tidy",
            &format!("{} KiB", xml.len() / 1024),
            tempo,
            xml.len() as f64 / (1024.0 * 1024.0),
            "MiB",
        );
    }
}
