//! Vídeo de verdade — as cinco operações que o produto anterior tinha, agora
//! como ferramentas de MÁQUINA sobre o ffmpeg da estação.
//!
//! # Por que isto mora no host, e não no gateway Go
//!
//! O gateway não linka nada de mídia — decodificar vídeo em Go puro não existe,
//! e embutir um ffmpeg no produto seria distribuir um binário GPL que a TI não
//! homologou como NOSSO. O que a TI homologou foi o ffmpeg DA ESTAÇÃO (winget),
//! então o desenho é o mesmo do Office: o gateway despacha `tool.call` e quem
//! tem o binário executa. Sem ffmpeg instalado, a ferramenta recusa com a
//! instrução de instalação — nunca um sucesso de mentira.
//!
//! # As regras que valem para as cinco operações
//!
//! - todo caminho passa por `tools::resolve_inside` — vídeo fora da pasta do
//!   projeto não entra nem sai;
//! - argumentos SEMPRE em elementos separados de argv, sem shell no meio: o
//!   nome de um arquivo nunca vira injeção de comando;
//! - timeout de 10 minutos com a ÁRVORE morrendo junto (Job Object, como o
//!   `proc.run`) — transcodificação é o caso real de processo que trava;
//! - saída resumida: o stderr do ffmpeg tem megabytes de progresso; o modelo
//!   só precisa das ÚLTIMAS linhas, e só quando falha.
//!
//! # A armadilha do drawtext, já paga uma vez neste projeto
//!
//! O `drawtext` passa o valor de `text=` por DOIS parsers (o do filtergraph e o
//! do próprio drawtext), e o apóstrofo NÃO tem escape que atravesse os dois —
//! um "d'água" no texto quebra a linha de comando de um jeito diferente em cada
//! nível. A saída não é escapar melhor: é NÃO colocar o texto na linha de
//! comando. O texto vai num ARQUIVO temporário (`textfile=`), e o nome desse
//! arquivo é gerado por nós com [A-Za-z0-9.-] apenas. Para nem o CAMINHO do
//! temporário precisar de escape (ele teria `C:\`, e `:` é separador de opção
//! no filtergraph), o ffmpeg roda com o diretório temporário como CWD e o
//! filtro referencia o arquivo SÓ PELO NOME.

use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::jail::Jail;
use crate::tools::{arg_opt_str, arg_str, project_root, resolve_inside};

#[cfg(windows)]
use crate::jail::CREATION_FLAGS;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Timeout das operações de vídeo. Generoso de propósito: reencodar dez
/// minutos de 1080p em uma estação comum passa fácil de dois minutos. Fica
/// ABAIXO dos 15 min que o gateway espera pelo host — estourar o prazo de quem
/// chama seria devolver a resposta para ninguém.
const MEDIA_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Intervalo de espera pelo fim do processo (mesmo valor do `proc.run`).
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Carência para os canos fecharem depois do fim do processo — o caso do neto
/// que herdou a saída (ver `tools::run_shell`, que paga o mesmo pedágio).
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Teto da saída padrão guardada. Só o ffprobe escreve em stdout aqui, e o
/// JSON dele para um arquivo normal tem poucos KiB; 512 KiB cobre até um
/// contêiner com dezenas de faixas.
const STDOUT_CAP: usize = 512 * 1024;

/// Quanto do FIM do stderr é guardado. O ffmpeg escreve o diagnóstico útil nas
/// últimas linhas; o resto é progresso que ninguém precisa reler.
const STDERR_TAIL_CAP: usize = 16 * 1024;

/// Quantas linhas do fim do stderr entram na mensagem de erro.
const FAIL_TAIL_LINES: usize = 12;

/// Tolerância para considerar que o corte "cai" num keyframe. Meio décimo de
/// segundo é ~1 quadro em 24 fps: abaixo disso a cópia sem reencode começa no
/// quadro certo; acima, ela voltaria ao keyframe anterior e o corte viria com
/// sobra que ninguém pediu.
const KEYFRAME_TOLERANCE: f64 = 0.05;

/* ------------------------------ localização ------------------------------ */

/// `CREATE_NO_WINDOW` sozinho, para os utilitários rápidos (`where.exe`).
/// NÃO usar o `CREATION_FLAGS` do jail aqui: ele inclui `CREATE_SUSPENDED`, e
/// um `where.exe` suspenso com `.output()` esperaria para sempre.
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

/// Acha um executável no PATH (ffmpeg/ffprobe), ou recusa com a instrução.
///
/// A busca roda a cada chamada, sem cache: custa milissegundos perto de
/// qualquer operação de vídeo, e sem cache a pessoa que instalar o ffmpeg no
/// meio da sessão não precisa reabrir o app para a ferramenta passar a achar.
fn find_media_binary(name: &str) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let mut lookup = {
        let mut command = Command::new("where.exe");
        command.arg(name).creation_flags(NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut lookup = {
        let mut command = Command::new("which");
        command.arg(name);
        command
    };

    let output = lookup
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("não foi possível procurar o {name} no PATH: {error}"))?;
    if output.status.success() {
        if let Some(first) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
        {
            return Ok(PathBuf::from(first));
        }
    }
    Err(format!(
        "o {name} não foi encontrado no PATH desta máquina. O ffmpeg é aprovado pela TI e \
instala com: winget install --id Gyan.FFmpeg — depois feche e reabra o AI-BOT para o PATH novo valer. \
O ffprobe vem no mesmo pacote."
    ))
}

/* ------------------------------- execução -------------------------------- */

/// Saída de uma execução de ffmpeg/ffprobe já colhida.
struct MediaOutcome {
    exit_code: Option<i32>,
    stdout: String,
    stderr_tail: String,
    elapsed: Duration,
    timed_out: bool,
}

/// Roda o binário de mídia dentro de um Job Object, com timeout.
///
/// É o mesmo esqueleto do `tools::run_shell`, com duas diferenças de
/// propósito: NÃO há shell no meio (programa e argumentos vão direto, então
/// nome de arquivo nunca é reinterpretado) e o stderr guarda o FIM, não o
/// começo — no ffmpeg o diagnóstico está nas últimas linhas.
fn run_media(program: &Path, args: &[String], directory: &Path) -> Result<MediaOutcome, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Nasce suspenso e sem janela, é preso ao job e só então corre — a mesma
    // corrida que o jail.rs documenta. Sem o job, um ffmpeg travado no timeout
    // deixaria threads de encode órfãs consumindo a máquina.
    #[cfg(windows)]
    command.creation_flags(CREATION_FLAGS);

    let jail = Jail::new()
        .map_err(|error| format!("não foi possível criar o isolamento do ffmpeg: {error}"))?;

    let start = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("não foi possível iniciar {}: {error}", program.display()))?;

    if let Err(error) = jail.capture_and_resume(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("não foi possível isolar o ffmpeg: {error}"));
    }
    let mut job = Some(jail);

    // Cada cano na sua thread: ler um depois do outro trava quando o processo
    // enche o cano que ninguém está lendo.
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_head(out_pipe, STDOUT_CAP));
    let err_reader = std::thread::spawn(move || read_tail(err_pipe, STDERR_TAIL_CAP));

    let deadline = start + MEDIA_TIMEOUT;
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
                return Err(format!("não foi possível acompanhar o ffmpeg: {error}"));
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    if timed_out {
        // Fechar o job dispara o KILL_ON_JOB_CLOSE e derruba a árvore inteira
        // — é o que solta os canos e deixa os `join` abaixo terminarem.
        drop(job.take());
        let _ = child.kill();
        let _ = child.wait();
    }

    // Mesmo já terminado, um neto vivo pode estar segurando os canos.
    let grace = Instant::now() + PIPE_GRACE;
    while !(out_reader.is_finished() && err_reader.is_finished()) && Instant::now() < grace {
        std::thread::sleep(POLL_INTERVAL);
    }
    if !(out_reader.is_finished() && err_reader.is_finished()) {
        drop(job.take());
    }

    let stdout_bytes = out_reader.join().unwrap_or_default();
    let stderr_bytes = err_reader.join().unwrap_or_default();

    Ok(MediaOutcome {
        exit_code: status.and_then(|status| status.code()),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr_tail: String::from_utf8_lossy(ceil_utf8(&stderr_bytes)).into_owned(),
        elapsed: start.elapsed(),
        timed_out,
    })
}

/// Lê o cano até o fim guardando só os PRIMEIROS `cap` bytes (o resto é lido e
/// descartado — parar de ler travaria quem escreve).
fn read_head<R: Read>(source: Option<R>, cap: usize) -> Vec<u8> {
    let Some(mut source) = source else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
            Err(_) => break,
        }
    }
    kept
}

/// Lê o cano até o fim guardando só os ÚLTIMOS `cap` bytes.
fn read_tail<R: Read>(source: Option<R>, cap: usize) -> Vec<u8> {
    let Some(mut source) = source else {
        return Vec::new();
    };
    let mut kept: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                kept.extend_from_slice(&chunk[..read]);
                if kept.len() > cap {
                    let excess = kept.len() - cap;
                    kept.drain(..excess);
                }
            }
            Err(_) => break,
        }
    }
    kept
}

/// Avança o INÍCIO da fatia até um caractere completo. O corte do `read_tail`
/// cai no meio de um acento com frequência, e um U+FFFD na primeira linha da
/// mensagem de erro parece defeito nosso, não do ffmpeg.
fn ceil_utf8(bytes: &[u8]) -> &[u8] {
    let mut start = 0usize;
    while start < bytes.len() && start < 4 && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }
    &bytes[start..]
}

/// As últimas `max` linhas não vazias de um texto.
fn tail_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n")
}

/// Transforma um desfecho ruim em erro legível; devolve o desfecho quando o
/// código de saída é zero.
///
/// Diferente do `proc.run`, aqui código != 0 É erro da ferramenta: o comando
/// não foi escrito pelo modelo — foi montado por nós —, então uma falha é
/// nossa ou do arquivo, nunca algo que o modelo conserta reescrevendo o argv.
fn ensure_success(action: &str, outcome: MediaOutcome) -> Result<MediaOutcome, String> {
    if outcome.timed_out {
        return Err(format!(
            "{action}: o ffmpeg passou de {} minutos e a árvore de processos foi encerrada. \
Vídeos muito longos valem cortar em partes menores antes.",
            MEDIA_TIMEOUT.as_secs() / 60
        ));
    }
    match outcome.exit_code {
        Some(0) => Ok(outcome),
        code => {
            let tail = tail_lines(&outcome.stderr_tail, FAIL_TAIL_LINES);
            let tail = if tail.is_empty() {
                "(sem saída de erro)".to_string()
            } else {
                tail
            };
            Err(format!(
                "{action}: o ffmpeg terminou com código {} em {}.\nÚltimas linhas da saída de erro:\n{tail}",
                code.map_or_else(|| "desconhecido (sinal)".to_string(), |c| c.to_string()),
                human_duration(outcome.elapsed),
            ))
        }
    }
}

fn human_duration(elapsed: Duration) -> String {
    let millis = elapsed.as_millis();
    if millis < 1_000 {
        return format!("{millis} ms");
    }
    format!("{},{} s", millis / 1_000, (millis % 1_000) / 100)
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{},{} KiB", bytes / 1024, (bytes % 1024) * 10 / 1024);
    }
    let mib10 = bytes * 10 / (1024 * 1024);
    format!("{},{} MiB", mib10 / 10, mib10 % 10)
}

/* --------------------------- arquivos de apoio ---------------------------- */

/// Contador para nomes únicos de arquivos temporários deste processo.
static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// Arquivo temporário com nome SEGURO PARA FILTERGRAPH: só [A-Za-z0-9.-].
///
/// O Drop apaga o arquivo — inclusive quando a operação falha no meio. É o que
/// o teste `textfile_e_criado_e_limpo` fixa: um temporário por chamada que
/// nunca é limpo viraria lixo acumulando a cada `video.text`.
struct ScratchFile {
    path: PathBuf,
}

impl ScratchFile {
    fn create(prefix: &str, extension: &str, content: &[u8]) -> Result<Self, String> {
        let name = format!(
            "{prefix}-{}-{}.{extension}",
            std::process::id(),
            SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, content)
            .map_err(|error| format!("não foi possível gravar o arquivo temporário: {error}"))?;
        Ok(Self { path })
    }

    /// Só o nome, sem diretório — é como o filtro referencia o arquivo, porque
    /// o ffmpeg roda com `dir()` como CWD e aí o caminho não precisa de escape
    /// nenhum (ver o cabeçalho do módulo).
    fn file_name(&self) -> String {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn dir(&self) -> PathBuf {
        self.path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir)
    }
}

impl Drop for ScratchFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/* ------------------------------- validação -------------------------------- */

/// Resolve e valida um vídeo de ENTRADA: dentro do projeto e existente.
fn resolve_input(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = resolve_inside(root, relative)?;
    if !path.is_file() {
        return Err(format!(
            "o vídeo {relative:?} não existe dentro da pasta do projeto"
        ));
    }
    Ok(path)
}

/// Resolve e valida um arquivo de SAÍDA: dentro do projeto, com extensão e
/// ainda inexistente.
///
/// Recusar sobrescrita não é frescura: o ffmpeg pergunta "overwrite?" num
/// stdin que está fechado e morre com erro confuso — e a alternativa (-y)
/// apagaria em silêncio um arquivo que a pessoa pode não ter pedido para
/// perder. Erro com instrução é melhor que os dois.
fn resolve_output(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).extension().is_none() {
        return Err(format!(
            "o arquivo de saída {relative:?} precisa de extensão — é ela que define o contêiner (ex.: saida.mp4)"
        ));
    }
    let path = resolve_inside(root, relative)?;
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(format!(
            "o arquivo de saída {relative:?} já existe — escolha outro nome ou apague-o antes"
        ));
    }
    Ok(path)
}

/// Caminho como o ffmpeg gosta de ver em LISTAS e mensagens: barras normais.
/// O ffmpeg no Windows aceita `/` em todo lugar, e sem `\` no texto não há
/// nenhum nível de escape para acertar.
fn ffmpeg_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Interpreta um instante em segundos: número JSON, "12.5", "1:23" ou
/// "01:02:03.5". Aceitar timecode custa pouco e é como as pessoas descrevem
/// corte de vídeo.
fn parse_time(args: &Value, key: &str) -> Result<f64, String> {
    let value = args
        .get(key)
        .ok_or_else(|| format!("falta o argumento \"{key}\" (segundos ou hh:mm:ss)"))?;
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => parse_timecode(text.trim()),
        _ => None,
    };
    let seconds = parsed.ok_or_else(|| {
        format!("o argumento \"{key}\" precisa ser segundos (12.5) ou timecode (mm:ss / hh:mm:ss)")
    })?;
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(format!("o argumento \"{key}\" não pode ser negativo"));
    }
    Ok(seconds)
}

fn parse_timecode(text: &str) -> Option<f64> {
    if text.is_empty() {
        return None;
    }
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut seconds = 0.0f64;
    for part in &parts {
        let value: f64 = part.parse().ok()?;
        if value < 0.0 {
            return None;
        }
        seconds = seconds * 60.0 + value;
    }
    Some(seconds)
}

/// Segundos formatados para argv. Três casas: precisão de milissegundo, sem a
/// cauda de dígitos que o f64 inventa.
fn seconds_arg(seconds: f64) -> String {
    format!("{seconds:.3}")
}

/* ----------------------------- montagem de argv ---------------------------- */
// Todas as funções abaixo são PURAS: entram textos, sai o argv. É a parte que
// erra — flag na ordem errada, escape esquecido — e por isso é a parte com
// teste. O IO fica de fora delas.

/// Prefixo comum do ffmpeg: sem banner, só erros no stderr, sem esperar tecla.
fn ffmpeg_base() -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
    ]
}

fn probe_args(input: &str) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        input.into(),
    ]
}

/// Pergunta ao ffprobe o instante do keyframe em que um seek para `start`
/// realmente cai. `-read_intervals N%+#1` lê UM pacote a partir do ponto de
/// seek — e o primeiro pacote depois de um seek de vídeo é sempre keyframe.
fn keyframe_args(input: &str, start: f64) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-skip_frame".into(),
        "nokey".into(),
        "-show_entries".into(),
        "frame=pts_time".into(),
        "-of".into(),
        "csv=p=0".into(),
        "-read_intervals".into(),
        format!("{}%+#1", seconds_arg(start)),
        input.into(),
    ]
}

/// Como cortar: cópia de pacotes ou reencode.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CutMode {
    Copy,
    Reencode,
}

/// Decide o modo do corte a partir do keyframe mais próximo do início.
///
/// Cópia (`-c copy`) só quando o início do corte COINCIDE com um keyframe:
/// stream copy não pode partir um GOP no meio, então um `-ss` que não cai em
/// keyframe volta ao anterior e o corte sai maior do que o pedido. Quando o
/// ffprobe não responde (arquivo sem faixa de vídeo legível), reencodar é o
/// único caminho que garante o corte exato — a decisão conservadora.
fn cut_mode(start: f64, keyframe: Option<f64>) -> CutMode {
    if start <= KEYFRAME_TOLERANCE {
        // Todo stream começa em keyframe; corte no zero é sempre limpo.
        return CutMode::Copy;
    }
    match keyframe {
        Some(instant) if (start - instant).abs() <= KEYFRAME_TOLERANCE => CutMode::Copy,
        _ => CutMode::Reencode,
    }
}

/// O contêiner é mp4/mov? `-movflags` é opção PRIVADA desse muxer; mandar para
/// um .mkv sobra no dicionário de opções e o ffmpeg reclama.
fn is_mp4_like(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.ends_with(".mp4") || lower.ends_with(".m4v") || lower.ends_with(".mov")
}

/// Os parâmetros de reencode compartilhados por trim/text: H.264 rápido e
/// compatível (yuv420p é o que players de estação leem sem drama).
fn h264_args(output: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    if is_mp4_like(output) {
        // faststart move o índice para o começo: o arquivo dá play antes de
        // terminar de copiar/enviar.
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args
}

fn trim_args(input: &str, output: &str, start: f64, duration: f64, mode: CutMode) -> Vec<String> {
    // `-ss` ANTES de `-i`: com cópia ele salta direto ao keyframe (rápido) e
    // com reencode o ffmpeg moderno decode-e-descarta até o instante exato.
    // `-t` em vez de `-to` porque o seek de entrada zera os timestamps, e um
    // `-to` absoluto passaria a significar outra coisa.
    let mut args = ffmpeg_base();
    args.extend([
        "-ss".into(),
        seconds_arg(start),
        "-i".into(),
        input.into(),
        "-t".into(),
        seconds_arg(duration),
    ]);
    match mode {
        CutMode::Copy => {
            args.extend([
                "-c".into(),
                "copy".into(),
                // Timestamps negativos sobram do corte por cópia e fazem
                // player pular o começo; make_zero normaliza.
                "-avoid_negative_ts".into(),
                "make_zero".into(),
            ]);
        }
        CutMode::Reencode => {
            args.extend(h264_args(output));
            args.extend(["-c:a".into(), "aac".into()]);
        }
    }
    args.push(output.into());
    args
}

/// Uma linha do arquivo de lista do demuxer concat.
///
/// O caminho vai entre aspas simples (tudo literal lá dentro, inclusive `\`),
/// e o próprio apóstrofo — o único caractere que a aspa não cobre — é emendado
/// no estilo `'antes'\''depois'`. As barras já chegam normalizadas para `/`.
fn concat_list_line(path: &str) -> String {
    format!("file '{}'", path.replace('\'', "'\\''"))
}

fn concat_args(list_name: &str, output: &str) -> Vec<String> {
    let mut args = ffmpeg_base();
    args.extend([
        "-f".into(),
        "concat".into(),
        // A lista referencia caminhos absolutos, e o demuxer considera isso
        // "inseguro" por padrão. Aqui é seguro POR CONSTRUÇÃO: cada caminho da
        // lista já passou pelo resolve_inside antes de entrar nela.
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_name.into(),
        "-c".into(),
        "copy".into(),
        output.into(),
    ]);
    args
}

/// Posição do texto na tela.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TextPosition {
    TopLeft,
    Top,
    TopRight,
    Center,
    BottomLeft,
    Bottom,
    BottomRight,
}

const TEXT_POSITIONS: [(&str, TextPosition); 7] = [
    ("topleft", TextPosition::TopLeft),
    ("top", TextPosition::Top),
    ("topright", TextPosition::TopRight),
    ("center", TextPosition::Center),
    ("bottomleft", TextPosition::BottomLeft),
    ("bottom", TextPosition::Bottom),
    ("bottomright", TextPosition::BottomRight),
];

fn parse_position(value: Option<&str>) -> Result<TextPosition, String> {
    let Some(raw) = value else {
        return Ok(TextPosition::Bottom);
    };
    let normalized = raw.to_ascii_lowercase().replace(['-', '_', ' '], "");
    TEXT_POSITIONS
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(_, position)| *position)
        .ok_or_else(|| {
            let known = TEXT_POSITIONS
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            format!("posição {raw:?} desconhecida — use uma destas: {known}")
        })
}

/// Expressões de x/y do drawtext. `w/h/text_w/text_h` são variáveis do próprio
/// filtro; 24 px de margem para o texto não colar na borda.
fn position_expressions(position: TextPosition) -> (&'static str, &'static str) {
    const LEFT: &str = "24";
    const CENTER_X: &str = "(w-text_w)/2";
    const RIGHT: &str = "w-text_w-24";
    const TOP: &str = "24";
    const CENTER_Y: &str = "(h-text_h)/2";
    const BOTTOM: &str = "h-text_h-24";
    match position {
        TextPosition::TopLeft => (LEFT, TOP),
        TextPosition::Top => (CENTER_X, TOP),
        TextPosition::TopRight => (RIGHT, TOP),
        TextPosition::Center => (CENTER_X, CENTER_Y),
        TextPosition::BottomLeft => (LEFT, BOTTOM),
        TextPosition::Bottom => (CENTER_X, BOTTOM),
        TextPosition::BottomRight => (RIGHT, BOTTOM),
    }
}

/// Escapa um caminho para dentro de um valor de filtergraph, no formato
/// VERIFICADO contra o ffmpeg 9 renderizando um quadro: `'C\:/Windows/...'`.
///
/// Os DOIS parsers, na prática: o do grafo consome uma rodada de escape/aspas
/// ao extrair os argumentos do filtro, e o das opções consome OUTRA ao separar
/// os `chave=valor` por `:`. Um `\:` solto morre no primeiro parser e o
/// segundo corta o valor no `:` da unidade (`C:`) — foi exatamente o erro
/// observado. A forma que atravessa os dois é: aspas simples para o primeiro
/// (que entrega o miolo verbatim, barra invertida inclusa) e `\:` para o
/// segundo. As barras viram `/` porque o ffmpeg as aceita no Windows e `\`
/// solto é combustível de escape.
///
/// Apóstrofo é RECUSADO em vez de escapado — dentro das aspas do primeiro
/// nível ele não tem representação, e é o caractere que motivou o `textfile=`.
/// Só passa por aqui caminho de FONTE do Windows (`C:\Windows\Fonts\...`), que
/// nunca tem apóstrofo; se um dia tiver, recusar é melhor que corromper o
/// filtro.
fn escape_filter_path(path: &str) -> Result<String, String> {
    if path.contains('\'') {
        return Err(format!(
            "o caminho {path:?} tem apóstrofo, que não sobrevive aos dois parsers do filtergraph"
        ));
    }
    Ok(format!(
        "'{}'",
        path.replace('\\', "/").replace(':', "\\:")
    ))
}

/// A fonte do drawtext no Windows.
///
/// O build do ffmpeg da estação pode vir sem fontconfig, e aí `drawtext` sem
/// `fontfile=` morre com "Cannot find a valid font". Apontar para a Arial do
/// sistema tira essa variável da equação; se ela não existir (Windows N muito
/// podado), devolve None e o fontconfig que se vire.
fn windows_font_file() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
    let font = Path::new(&windir).join("Fonts").join("arial.ttf");
    if !font.is_file() {
        return None;
    }
    escape_filter_path(&font.to_string_lossy()).ok()
}

/// Monta o filtro drawtext. O texto NÃO aparece aqui — só o nome do arquivo
/// temporário, relativo ao CWD do processo (ver o cabeçalho do módulo).
fn drawtext_filter(
    textfile_name: &str,
    position: TextPosition,
    font_file: Option<&str>,
) -> String {
    let (x, y) = position_expressions(position);
    let mut filter = format!("drawtext=textfile={textfile_name}");
    // expansion=none: por padrão o drawtext expande %{...} até DENTRO do
    // textfile — o texto da pessoa é texto, não template.
    filter.push_str(":expansion=none");
    if let Some(font) = font_file {
        filter.push_str(&format!(":fontfile={font}"));
    }
    // Tamanho relativo à altura: 4K não sai com letra de miniatura. Borda
    // escura para o branco continuar legível sobre fundo claro.
    filter.push_str(&format!(
        ":fontsize=h/18:fontcolor=white:borderw=3:bordercolor=black@0.6:x={x}:y={y}"
    ));
    filter
}

fn text_args(input: &str, filter: &str, output: &str) -> Vec<String> {
    let mut args = ffmpeg_base();
    args.extend([
        "-i".into(),
        input.into(),
        "-vf".into(),
        filter.into(),
    ]);
    args.extend(h264_args(output));
    // O áudio não muda: copiar preserva qualidade e poupa tempo.
    args.extend(["-c:a".into(), "copy".into(), output.into()]);
    args
}

/// Formatos de exportação suportados.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ExportFormat {
    Mp4,
    Webm,
    Gif,
    Mp3,
}

const EXPORT_FORMATS: [(&str, ExportFormat); 4] = [
    ("mp4", ExportFormat::Mp4),
    ("webm", ExportFormat::Webm),
    ("gif", ExportFormat::Gif),
    ("mp3", ExportFormat::Mp3),
];

fn parse_export_format(raw: &str) -> Result<ExportFormat, String> {
    let normalized = raw.to_ascii_lowercase();
    EXPORT_FORMATS
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(_, format)| *format)
        .ok_or_else(|| {
            let known = EXPORT_FORMATS
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            format!("formato {raw:?} não suportado — os disponíveis são: {known}")
        })
}

fn export_extension(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Mp4 => "mp4",
        ExportFormat::Webm => "webm",
        ExportFormat::Gif => "gif",
        ExportFormat::Mp3 => "mp3",
    }
}

fn export_args(input: &str, output: &str, format: ExportFormat) -> Vec<String> {
    let mut args = ffmpeg_base();
    args.extend(["-i".into(), input.into()]);
    match format {
        ExportFormat::Mp4 => {
            args.extend(h264_args(output));
            args.extend(["-c:a".into(), "aac".into()]);
        }
        ExportFormat::Webm => {
            args.extend([
                "-c:v".into(),
                "libvpx-vp9".into(),
                "-crf".into(),
                "32".into(),
                "-b:v".into(),
                "0".into(),
                "-row-mt".into(),
                "1".into(),
                "-c:a".into(),
                "libopus".into(),
            ]);
        }
        ExportFormat::Gif => {
            args.extend([
                "-vf".into(),
                // A vírgula do min() precisa de `\` porque vírgula separa
                // filtros na cadeia; a do fps/scale é separador DE VERDADE.
                // min(iw,480): encolhe vídeo grande, não infla vídeo pequeno.
                "fps=12,scale=min(iw\\,480):-2:flags=lanczos".into(),
                "-an".into(),
            ]);
        }
        ExportFormat::Mp3 => {
            args.extend([
                "-vn".into(),
                "-c:a".into(),
                "libmp3lame".into(),
                "-q:a".into(),
                "2".into(),
            ]);
        }
    }
    args.push(output.into());
    args
}

/* ------------------------------ video.probe ------------------------------- */

pub fn probe(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let root = project_root()?;
    let input = resolve_input(&root, relative)?;
    let ffprobe = find_media_binary("ffprobe")?;

    let outcome = run_media(&ffprobe, &probe_args(&ffmpeg_path(&input)), &root)?;
    let outcome = ensure_success(&format!("não foi possível ler {relative}"), outcome)?;
    let summary = summarize_probe(&outcome.stdout)?;
    Ok(format!("arquivo: {relative}\n{summary}"))
}

/// Resume o JSON do ffprobe no que interessa: duração, resolução e faixas.
///
/// Pura (JSON entra, texto sai) porque é onde mora a interpretação — e o JSON
/// do ffprobe tem surpresas conhecidas: duração como STRING, fps como fração
/// "30000/1001", campos ausentes em stream de legenda.
fn summarize_probe(json: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(json)
        .map_err(|error| format!("o ffprobe devolveu um JSON ilegível: {error}"))?;

    let mut out = String::new();

    let format = parsed.get("format").cloned().unwrap_or(Value::Null);
    if let Some(duration) = format
        .get("duration")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<f64>().ok())
    {
        out.push_str(&format!("duração: {}\n", human_seconds(duration)));
    }
    if let Some(size) = format
        .get("size")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<u64>().ok())
    {
        out.push_str(&format!("tamanho: {}\n", human_size(size)));
    }

    let empty = Vec::new();
    let streams = parsed
        .get("streams")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // A resolução "do arquivo" é a da primeira faixa de vídeo — é o que a
    // pessoa quer dizer com "resolução do vídeo".
    if let Some(video) = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
    {
        if let (Some(width), Some(height)) = (
            video.get("width").and_then(Value::as_u64),
            video.get("height").and_then(Value::as_u64),
        ) {
            out.push_str(&format!("resolução: {width}x{height}\n"));
        }
    }

    if streams.is_empty() {
        return Err("o arquivo não tem nenhuma faixa que o ffprobe reconheça — provavelmente não é um vídeo".into());
    }

    out.push_str("faixas:\n");
    for stream in streams {
        let index = stream.get("index").and_then(Value::as_u64).unwrap_or(0);
        let codec = stream
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("?");
        match stream.get("codec_type").and_then(Value::as_str) {
            Some("video") => {
                let width = stream.get("width").and_then(Value::as_u64).unwrap_or(0);
                let height = stream.get("height").and_then(Value::as_u64).unwrap_or(0);
                let fps = stream
                    .get("r_frame_rate")
                    .and_then(Value::as_str)
                    .and_then(parse_frame_rate)
                    .map(|value| format!(" {}fps", comma_decimal(value)))
                    .unwrap_or_default();
                out.push_str(&format!("  #{index} vídeo {codec} {width}x{height}{fps}\n"));
            }
            Some("audio") => {
                let rate = stream
                    .get("sample_rate")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let channels = stream.get("channels").and_then(Value::as_u64).unwrap_or(0);
                out.push_str(&format!(
                    "  #{index} áudio {codec} {rate} Hz {channels} canal(is)\n"
                ));
            }
            Some(other) => out.push_str(&format!("  #{index} {other} {codec}\n")),
            None => out.push_str(&format!("  #{index} {codec}\n")),
        }
    }
    Ok(out.trim_end().to_string())
}

/// "30000/1001" -> 29.97. O ffprobe entrega fps como fração exata.
fn parse_frame_rate(raw: &str) -> Option<f64> {
    let mut parts = raw.splitn(2, '/');
    let numerator: f64 = parts.next()?.trim().parse().ok()?;
    let denominator: f64 = match parts.next() {
        Some(text) => text.trim().parse().ok()?,
        None => 1.0,
    };
    if denominator == 0.0 {
        return None;
    }
    Some(numerator / denominator)
}

fn comma_decimal(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if (rounded - rounded.trunc()).abs() < f64::EPSILON {
        format!("{}", rounded.trunc() as i64)
    } else {
        format!("{rounded:.2}").replace('.', ",")
    }
}

fn human_seconds(seconds: f64) -> String {
    let total = seconds.round() as u64;
    let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}h{minutes:02}m{secs:02}s")
    } else if minutes > 0 {
        format!("{minutes}m{secs:02}s")
    } else {
        format!("{} s", comma_decimal(seconds))
    }
}

/* ------------------------------- video.trim ------------------------------- */

pub fn trim(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let output_relative = arg_str(args, "output")?;
    let start = parse_time(args, "start")?;
    let end = parse_time(args, "end")?;
    if end <= start {
        return Err(format!(
            "o fim do corte ({end}s) precisa vir depois do início ({start}s)"
        ));
    }

    let root = project_root()?;
    let input = resolve_input(&root, relative)?;
    let output = resolve_output(&root, output_relative)?;
    let ffmpeg = find_media_binary("ffmpeg")?;

    // A pergunta ao ffprobe é OPCIONAL: se ela falhar, o corte reencoda — o
    // resultado continua exato, só paga mais CPU.
    let keyframe = find_media_binary("ffprobe").ok().and_then(|ffprobe| {
        let outcome = run_media(&ffprobe, &keyframe_args(&ffmpeg_path(&input), start), &root).ok()?;
        if outcome.exit_code != Some(0) {
            return None;
        }
        outcome
            .stdout
            .lines()
            .next()
            .and_then(|line| line.trim().trim_end_matches(',').parse::<f64>().ok())
    });
    let mode = cut_mode(start, keyframe);

    let argv = trim_args(
        &ffmpeg_path(&input),
        &ffmpeg_path(&output),
        start,
        end - start,
        mode,
    );
    let outcome = run_media(&ffmpeg, &argv, &root)?;
    let outcome = ensure_success(&format!("não foi possível cortar {relative}"), outcome)?;

    let size = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    let how = match mode {
        CutMode::Copy => "sem reencodar (o corte cai em keyframe)".to_string(),
        CutMode::Reencode => match keyframe {
            Some(instant) => format!(
                "reencodado — o keyframe mais próximo fica em {}s e o corte pedido é {}s",
                comma_decimal(instant),
                comma_decimal(start)
            ),
            None => "reencodado — não foi possível confirmar o keyframe do início".to_string(),
        },
    };
    Ok(format!(
        "corte de {} a {} gravado em {output_relative} ({how}) — {} em {}",
        comma_decimal(start),
        comma_decimal(end),
        human_size(size),
        human_duration(outcome.elapsed)
    ))
}

/* ------------------------------ video.concat ------------------------------ */

pub fn concat(args: &Value) -> Result<String, String> {
    let output_relative = arg_str(args, "output")?;
    let list = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "falta o argumento \"paths\" (lista de vídeos, na ordem)".to_string())?;
    if list.len() < 2 {
        return Err("emendar exige pelo menos dois vídeos em \"paths\"".into());
    }

    let root = project_root()?;
    let mut lines = Vec::with_capacity(list.len());
    for (position, item) in list.iter().enumerate() {
        let relative = item
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("o item {} de \"paths\" precisa ser um caminho", position + 1))?;
        let resolved = resolve_input(&root, relative)?;
        lines.push(concat_list_line(&ffmpeg_path(&resolved)));
    }
    let output = resolve_output(&root, output_relative)?;
    let ffmpeg = find_media_binary("ffmpeg")?;

    // A lista vai num arquivo temporário e o ffmpeg roda com o diretório dela
    // como CWD — o `-i` referencia só o nome, sem nenhum caminho para escapar.
    let listing = ScratchFile::create("aibot-concat", "txt", (lines.join("\n") + "\n").as_bytes())?;
    let argv = concat_args(&listing.file_name(), &ffmpeg_path(&output));
    let outcome = run_media(&ffmpeg, &argv, &listing.dir())?;
    let outcome = ensure_success(
        &format!(
            "não foi possível emendar os {} vídeos (o demuxer concat copia pacotes, então todos precisam \
ter o MESMO codec e resolução — quando divergem, converta antes com video.export)",
            lines.len()
        ),
        outcome,
    )?;

    let size = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    Ok(format!(
        "{} vídeos emendados em {output_relative} — {} em {}",
        lines.len(),
        human_size(size),
        human_duration(outcome.elapsed)
    ))
}

/* ------------------------------- video.text ------------------------------- */

pub fn text(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let output_relative = arg_str(args, "output")?;
    // O texto NÃO passa por arg_str: espaços nas bordas podem ser intencionais
    // num letreiro, e vazio é o único caso a recusar.
    let content = args
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "falta o argumento \"text\" (o texto a gravar sobre o vídeo)".to_string())?;
    let position = parse_position(arg_opt_str(args, "position"))?;

    let root = project_root()?;
    let input = resolve_input(&root, relative)?;
    let output = resolve_output(&root, output_relative)?;
    let ffmpeg = find_media_binary("ffmpeg")?;

    // O texto vai para um ARQUIVO — nunca para a linha de comando. É a única
    // saída sã para a armadilha dos dois parsers do drawtext (ver o cabeçalho
    // do módulo). O guard apaga o arquivo mesmo quando o ffmpeg falha.
    let textfile = ScratchFile::create("aibot-drawtext", "txt", content.as_bytes())?;
    let filter = drawtext_filter(
        &textfile.file_name(),
        position,
        windows_font_file().as_deref(),
    );
    let argv = text_args(&ffmpeg_path(&input), &filter, &ffmpeg_path(&output));
    let outcome = run_media(&ffmpeg, &argv, &textfile.dir())?;
    let outcome = ensure_success(
        &format!("não foi possível gravar o texto sobre {relative}"),
        outcome,
    )?;

    let size = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    Ok(format!(
        "texto gravado sobre o vídeo em {output_relative} (posição {position:?}) — {} em {}",
        human_size(size),
        human_duration(outcome.elapsed)
    ))
}

/* ------------------------------ video.export ------------------------------ */

pub fn export(args: &Value) -> Result<String, String> {
    let relative = arg_str(args, "path")?;
    let output_relative = arg_str(args, "output")?;
    let format = parse_export_format(arg_str(args, "format")?)?;

    // A extensão da saída TEM de bater com o formato: o muxer vem da extensão,
    // e um "webm" gravado em .mp4 seria um arquivo que mente sobre si mesmo.
    let expected = export_extension(format);
    if !output_relative
        .to_ascii_lowercase()
        .ends_with(&format!(".{expected}"))
    {
        return Err(format!(
            "para o formato {expected:?} a saída precisa terminar em .{expected} (veio {output_relative:?})"
        ));
    }

    let root = project_root()?;
    let input = resolve_input(&root, relative)?;
    let output = resolve_output(&root, output_relative)?;
    let ffmpeg = find_media_binary("ffmpeg")?;

    let argv = export_args(&ffmpeg_path(&input), &ffmpeg_path(&output), format);
    let outcome = run_media(&ffmpeg, &argv, &root)?;
    let outcome = ensure_success(
        &format!("não foi possível exportar {relative} para {expected}"),
        outcome,
    )?;

    let size = std::fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    Ok(format!(
        "exportado para {output_relative} ({expected}) — {} em {}",
        human_size(size),
        human_duration(outcome.elapsed)
    ))
}

/* --------------------------------- testes --------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /* --------------------- fiação com tools::execute --------------------- */

    /// As cinco operações precisam estar no braço do `tools::execute` — sem o
    /// braço, o erro seria "não é servida por esta máquina" em vez da falta do
    /// argumento. Este teste FALHA sem a fiação.
    #[test]
    fn as_cinco_operacoes_estao_ligadas_no_execute() {
        for tool in [
            "video.probe",
            "video.trim",
            "video.concat",
            "video.text",
            "video.export",
        ] {
            let erro = crate::tools::execute(tool, &json!({})).expect_err("sem args deve recusar");
            assert!(
                !erro.contains("não é servida"),
                "{tool} não está ligada no tools::execute: {erro}"
            );
        }
    }

    #[test]
    fn probe_sem_path_explica_o_argumento() {
        let erro = probe(&json!({})).expect_err("deveria recusar");
        assert!(erro.contains("path"), "veio: {erro}");
    }

    #[test]
    fn concat_exige_pelo_menos_dois_videos() {
        let erro = concat(&json!({ "paths": ["um.mp4"], "output": "s.mp4" }))
            .expect_err("um vídeo só não é emenda");
        assert!(erro.contains("dois"), "veio: {erro}");
    }

    #[test]
    fn trim_recusa_fim_antes_do_inicio() {
        let erro = trim(&json!({
            "path": "a.mp4", "output": "b.mp4", "start": 10, "end": 5
        }))
        .expect_err("deveria recusar");
        assert!(erro.contains("depois do início"), "veio: {erro}");
    }

    /* ----------------------------- tempos ------------------------------ */

    #[test]
    fn tempo_aceita_numero_texto_e_timecode() {
        assert_eq!(parse_time(&json!({"start": 12.5}), "start").unwrap(), 12.5);
        assert_eq!(parse_time(&json!({"start": "90"}), "start").unwrap(), 90.0);
        assert_eq!(parse_time(&json!({"start": "1:30"}), "start").unwrap(), 90.0);
        assert_eq!(
            parse_time(&json!({"start": "01:02:03.5"}), "start").unwrap(),
            3723.5
        );
    }

    #[test]
    fn tempo_invalido_e_recusado_com_motivo() {
        assert!(parse_time(&json!({"start": -1}), "start").is_err());
        assert!(parse_time(&json!({"start": "abc"}), "start").is_err());
        assert!(parse_time(&json!({"start": "1:2:3:4"}), "start").is_err());
        assert!(parse_time(&json!({}), "start").is_err());
    }

    /* ------------------------- decisão de corte ------------------------ */

    #[test]
    fn corte_no_zero_copia_sem_perguntar() {
        assert_eq!(cut_mode(0.0, None), CutMode::Copy);
    }

    #[test]
    fn corte_em_keyframe_copia_e_fora_dele_reencoda() {
        assert_eq!(cut_mode(10.0, Some(10.02)), CutMode::Copy);
        assert_eq!(cut_mode(10.0, Some(8.5)), CutMode::Reencode);
    }

    /// Sem resposta do ffprobe a única escolha que garante o corte EXATO é
    /// reencodar — copiar chutando keyframe devolveria um corte com sobra.
    #[test]
    fn sem_keyframe_confirmado_reencoda() {
        assert_eq!(cut_mode(10.0, None), CutMode::Reencode);
    }

    /* --------------------------- montagem de argv ---------------------- */

    #[test]
    fn trim_por_copia_usa_c_copy_com_ss_antes_do_i() {
        let args = trim_args("in.mp4", "out.mp4", 10.0, 5.0, CutMode::Copy);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss precisa vir antes de -i: {args:?}");
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-t", "5.000"]), "{args:?}");
        assert!(!args.iter().any(|a| a == "libx264"), "cópia não reencoda");
    }

    #[test]
    fn trim_reencodado_usa_libx264_e_nao_copy() {
        let args = trim_args("in.mp4", "out.mp4", 10.0, 5.0, CutMode::Reencode);
        assert!(args.iter().any(|a| a == "libx264"), "{args:?}");
        assert!(!args.windows(2).any(|w| w == ["-c", "copy"]), "{args:?}");
    }

    /// `-movflags` é opção privada do muxer mp4/mov: mandá-la para um .mkv
    /// sobra no dicionário e o ffmpeg reclama de opção não usada.
    #[test]
    fn movflags_so_para_contedores_mp4() {
        let mp4 = trim_args("in.mp4", "out.mp4", 1.0, 1.0, CutMode::Reencode);
        assert!(mp4.iter().any(|a| a == "-movflags"), "{mp4:?}");
        let mkv = trim_args("in.mp4", "out.mkv", 1.0, 1.0, CutMode::Reencode);
        assert!(!mkv.iter().any(|a| a == "-movflags"), "{mkv:?}");
    }

    #[test]
    fn probe_pede_json_com_formato_e_faixas() {
        let args = probe_args("filme.mp4");
        assert!(args.windows(2).any(|w| w == ["-print_format", "json"]));
        assert!(args.iter().any(|a| a == "-show_streams"));
        assert_eq!(args.last().unwrap(), "filme.mp4");
    }

    #[test]
    fn pergunta_de_keyframe_le_um_pacote_no_ponto_de_seek() {
        let args = keyframe_args("filme.mp4", 12.5);
        assert!(args.iter().any(|a| a == "12.500%+#1"), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-skip_frame", "nokey"]));
    }

    #[test]
    fn concat_usa_o_demuxer_com_safe_zero() {
        let args = concat_args("lista.txt", "out.mp4");
        assert!(args.windows(2).any(|w| w == ["-f", "concat"]), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-safe", "0"]), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]), "{args:?}");
    }

    /* ------------------------- lista do concat ------------------------- */

    #[test]
    fn linha_da_lista_poe_o_caminho_entre_aspas() {
        assert_eq!(
            concat_list_line("C:/videos/um dois.mp4"),
            "file 'C:/videos/um dois.mp4'"
        );
    }

    /// O apóstrofo é o único caractere que a aspa simples não cobre — ele é
    /// emendado no estilo `'antes'\''depois'`, que os dois lados entendem.
    #[test]
    fn apostrofo_na_lista_e_emendado() {
        assert_eq!(
            concat_list_line("C:/videos/d'agua.mp4"),
            "file 'C:/videos/d'\\''agua.mp4'"
        );
    }

    /* ---------------------------- drawtext ----------------------------- */

    #[test]
    fn drawtext_referencia_o_arquivo_e_nunca_o_texto() {
        let filter = drawtext_filter("aibot-drawtext-1-2.txt", TextPosition::Bottom, None);
        // A PRIMEIRA opção é o textfile — e não existe opção `text=` em lugar
        // nenhum (`:text=`), que seria o texto cru de volta à linha de comando.
        assert!(filter.starts_with("drawtext=textfile=aibot-drawtext-1-2.txt"), "{filter}");
        assert!(!filter.contains(":text="), "o texto cru não pode aparecer: {filter}");
        assert!(filter.contains("expansion=none"), "{filter}");
    }

    #[test]
    fn posicao_central_usa_as_variaveis_do_filtro() {
        let filter = drawtext_filter("t.txt", TextPosition::Center, None);
        assert!(filter.contains("x=(w-text_w)/2"), "{filter}");
        assert!(filter.contains("y=(h-text_h)/2"), "{filter}");
    }

    #[test]
    fn fonte_do_windows_entra_escapada_para_o_filtergraph() {
        let filter = drawtext_filter(
            "t.txt",
            TextPosition::Bottom,
            Some("'C\\:/Windows/Fonts/arial.ttf'"),
        );
        assert!(
            filter.contains("fontfile='C\\:/Windows/Fonts/arial.ttf'"),
            "{filter}"
        );
    }

    /// A forma verificada renderizando um quadro no ffmpeg 9: aspas para o
    /// parser do grafo, `\:` para o parser de opções. Um `\:` sem as aspas
    /// morre no primeiro parser e o valor é cortado no `:` da unidade.
    #[test]
    fn escape_de_caminho_produz_a_forma_com_aspas_e_dois_pontos_escapado() {
        assert_eq!(
            escape_filter_path("C:\\Windows\\Fonts\\arial.ttf").unwrap(),
            "'C\\:/Windows/Fonts/arial.ttf'"
        );
    }

    /// A lição que motivou o textfile: apóstrofo não atravessa os dois parsers
    /// do filtergraph. Caminho com apóstrofo é recusado, nunca "escapado".
    #[test]
    fn escape_de_caminho_recusa_apostrofo() {
        assert!(escape_filter_path("C:\\d'agua\\f.ttf").is_err());
    }

    #[test]
    fn posicao_padrao_e_bottom_e_desconhecida_lista_as_validas() {
        assert_eq!(parse_position(None).unwrap(), TextPosition::Bottom);
        assert_eq!(parse_position(Some("top-left")).unwrap(), TextPosition::TopLeft);
        let erro = parse_position(Some("nordeste")).expect_err("deveria recusar");
        assert!(erro.contains("topleft"), "veio: {erro}");
    }

    /// O contrato do temporário: nasce com o conteúdo e MORRE no drop — mesmo
    /// quando o ffmpeg falha, o guard limpa.
    #[test]
    fn textfile_e_criado_e_limpo() {
        let scratch = ScratchFile::create("aibot-teste", "txt", "d'água".as_bytes())
            .expect("criar temporário");
        let path = scratch.path.clone();
        assert!(path.is_file(), "o temporário deveria existir");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "d'água");
        assert!(scratch.file_name().starts_with("aibot-teste-"));
        drop(scratch);
        assert!(!path.exists(), "o drop tem de apagar o temporário");
    }

    /* ------------------------------ export ----------------------------- */

    #[test]
    fn export_mapeia_codecs_por_formato() {
        let mp4 = export_args("a.mov", "b.mp4", ExportFormat::Mp4);
        assert!(mp4.iter().any(|a| a == "libx264"), "{mp4:?}");
        let webm = export_args("a.mp4", "b.webm", ExportFormat::Webm);
        assert!(webm.iter().any(|a| a == "libvpx-vp9"), "{webm:?}");
        let mp3 = export_args("a.mp4", "b.mp3", ExportFormat::Mp3);
        assert!(mp3.iter().any(|a| a == "-vn"), "{mp3:?}");
        assert!(mp3.iter().any(|a| a == "libmp3lame"), "{mp3:?}");
    }

    /// A vírgula do min() precisa continuar escapada — é separador de filtro
    /// na cadeia, e sem o `\` o scale viraria dois filtros quebrados.
    #[test]
    fn gif_mantem_a_virgula_escapada_no_min() {
        let gif = export_args("a.mp4", "b.gif", ExportFormat::Gif);
        let filter = gif.iter().find(|a| a.contains("scale=")).expect("filtro do gif");
        assert!(filter.contains("min(iw\\,480)"), "{filter}");
    }

    #[test]
    fn formato_desconhecido_lista_os_suportados() {
        let erro = parse_export_format("avi").expect_err("deveria recusar");
        assert!(erro.contains("mp4"), "veio: {erro}");
        assert!(erro.contains("webm"), "veio: {erro}");
    }

    #[test]
    fn export_exige_extensao_casada_com_o_formato() {
        let erro = export(&json!({
            "path": "a.mp4", "output": "b.mp4", "format": "webm"
        }))
        .expect_err("mp4 com formato webm mente sobre o contêiner");
        assert!(erro.contains(".webm"), "veio: {erro}");
    }

    /* ------------------------- resumo do ffprobe ----------------------- */

    const SAMPLE_PROBE: &str = r#"{
        "streams": [
            {"index": 0, "codec_name": "h264", "codec_type": "video",
             "width": 1920, "height": 1080, "r_frame_rate": "30000/1001"},
            {"index": 1, "codec_name": "aac", "codec_type": "audio",
             "sample_rate": "48000", "channels": 2}
        ],
        "format": {"duration": "125.400000", "size": "31457280"}
    }"#;

    #[test]
    fn resumo_do_probe_tem_duracao_resolucao_e_faixas() {
        let resumo = summarize_probe(SAMPLE_PROBE).expect("resumir");
        assert!(resumo.contains("duração: 2m05s"), "{resumo}");
        assert!(resumo.contains("resolução: 1920x1080"), "{resumo}");
        assert!(resumo.contains("#0 vídeo h264 1920x1080 29,97fps"), "{resumo}");
        assert!(resumo.contains("#1 áudio aac 48000 Hz 2 canal(is)"), "{resumo}");
        assert!(resumo.contains("tamanho: 30,0 MiB"), "{resumo}");
    }

    #[test]
    fn probe_sem_faixas_e_erro_e_nao_resumo_vazio() {
        let erro = summarize_probe(r#"{"streams": [], "format": {}}"#)
            .expect_err("sem faixas não há o que resumir");
        assert!(erro.contains("faixa"), "veio: {erro}");
    }

    #[test]
    fn fps_fracionario_vira_decimal_com_virgula() {
        assert_eq!(parse_frame_rate("30000/1001").map(comma_decimal), Some("29,97".into()));
        assert_eq!(parse_frame_rate("25/1").map(comma_decimal), Some("25".into()));
        assert_eq!(parse_frame_rate("0/0"), None);
    }

    /* ------------------------------ apoio ------------------------------ */

    #[test]
    fn cauda_do_stderr_guarda_so_as_ultimas_linhas() {
        let texto = (1..=20).map(|n| format!("linha {n}")).collect::<Vec<_>>().join("\n");
        let cauda = tail_lines(&texto, 3);
        assert_eq!(cauda, "linha 18\nlinha 19\nlinha 20");
    }

    #[test]
    fn leitura_de_cauda_mantem_o_fim_do_fluxo() {
        let dados = vec![b'a'; 100_000];
        let lidos = read_tail(Some(&dados[..]), 16);
        assert_eq!(lidos.len(), 16);
        assert!(lidos.iter().all(|byte| *byte == b'a'));
    }

    #[test]
    fn inicio_de_cauda_nao_comeca_no_meio_de_um_caractere() {
        let bytes = "áb".as_bytes(); // [0xC3, 0xA1, 0x62]
        assert_eq!(ceil_utf8(&bytes[1..]), b"b");
        assert_eq!(ceil_utf8(bytes), bytes);
    }

    #[test]
    fn tamanhos_e_duracoes_saem_legiveis() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(31_457_280), "30,0 MiB");
        assert_eq!(human_duration(Duration::from_millis(2_340)), "2,3 s");
        assert_eq!(human_seconds(125.4), "2m05s");
        assert_eq!(human_seconds(3_725.0), "1h02m05s");
    }
}
