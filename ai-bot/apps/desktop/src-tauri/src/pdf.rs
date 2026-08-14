//! Extrator de texto de PDF — escrito aqui, sem biblioteca de terceiros.
//!
//! Não há crate de PDF homologada, e a política da casa manda submeter
//! dependência nova a TI/SI antes de usar. Então o extrator é nosso. O único
//! empréstimo é o `flate2`, que já está na árvore (o `zip` do OOXML depende
//! dele) — não acrescenta superfície de terceiros, só passa a ser dependência
//! explícita.
//!
//! ## Como um PDF guarda texto
//!
//! O arquivo é uma coleção de objetos; o conteúdo de cada página é um
//! **content stream** — normalmente comprimido com FlateDecode — contendo
//! operadores de desenho. Os que interessam mostram texto:
//!
//! - `(Olá) Tj`            — mostra a string
//! - `[(A) -250 (B)] TJ`   — mostra com ajuste de espaçamento entre pedaços
//! - `'` e `"`             — mostram na linha seguinte
//! - `Td`, `TD`, `T*`, `BT`/`ET` — abrem o bloco e movem o cursor
//!
//! Ou seja: extrair texto de PDF é descomprimir os streams e interpretar esses
//! operadores. Não existe "o texto" guardado em lugar nenhum do arquivo.
//!
//! ## ESTE EXTRATOR É PARCIAL — e dizer isso é o ponto
//!
//! - **Sem `/ToUnicode`**: fonte com codificação própria (subconjunto embutido)
//!   devolve os códigos internos, não as letras. Acontece com PDF de
//!   editoração; PDF de escritório, exportado de Word ou da web, costuma vir
//!   bem.
//! - **PDF cifrado não é lido** — e é RECUSADO com mensagem clara.
//! - **A ordem é a do stream**, não a visual: layout de duas colunas pode sair
//!   intercalado.
//! - Não extrai imagem e não faz OCR: PDF digitalizado não tem texto nenhum.
//!
//! Quando nada sai, a função devolve ERRO explicando o motivo. Devolver texto
//! vazio, ou pior, os códigos internos da fonte como se fossem palavras, faria
//! o modelo resumir lixo com convicção — e quem lê o resumo não tem como saber.

use flate2::read::ZlibDecoder;
use std::io::Read;
use std::path::Path;

/// Teto do arquivo aceito — PDF de centenas de MB é digitalização, não texto.
const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;

/// Teto do texto devolvido ao modelo.
const MAX_TEXT_BYTES: usize = 400 * 1024;

/// Abaixo deste ajuste no `TJ`, o espaçamento representa um espaço de palavra.
const SPACE_THRESHOLD: f32 = -100.0;

/* ------------------------------- público -------------------------------- */

/// Lê o arquivo e extrai o texto.
///
/// É este o ponto que as ferramentas de máquina chamam (`pdf.extract` e o
/// `office.open` de um `.pdf`). O caminho já vem confinado e conferido por
/// `tools::resolve_inside` — aqui não há checagem de escopo, de propósito: uma
/// segunda checagem em outro lugar viraria uma segunda regra para divergir.
pub fn extract_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("não foi possível ler {}: {error}", path.display()))?;
    extract_text_from_bytes(&bytes)
}

/// Extrai o texto de um PDF já em memória.
pub fn extract_text_from_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "o PDF tem {} MB e o limite é {} MB",
            bytes.len() / (1024 * 1024),
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("o arquivo não é um PDF (falta a assinatura %PDF-)".into());
    }
    if is_encrypted(bytes) {
        return Err("PDF protegido por senha — remova a proteção antes de abrir".into());
    }

    let mut text = String::new();
    for stream in find_streams(bytes) {
        // Só content stream interessa: imagem e fonte também são streams, e
        // passá-las pelo varredor produziria lixo com cara de texto.
        if contains(stream.dict, b"/Image") || contains(stream.dict, b"/FontFile") {
            continue;
        }
        let Some(data) = decode_stream(&stream) else {
            continue;
        };
        let content = String::from_utf8_lossy(&data);
        // Um content stream sempre tem operador de texto; sem isso é gráfico.
        if !content.contains("Tj") && !content.contains("TJ") && !content.contains("BT") {
            continue;
        }
        let partial = text_from_content(&content);
        if partial.trim().is_empty() {
            continue;
        }
        text.push_str(&partial);
        if text.len() > MAX_TEXT_BYTES {
            text.truncate(floor_char_boundary(&text, MAX_TEXT_BYTES));
            text.push_str("\n… (texto cortado no limite de leitura)");
            break;
        }
    }

    if text.trim().is_empty() {
        return Err("nenhum texto extraível — o PDF pode ser digitalizado (imagem) ou usar fonte sem mapa Unicode".into());
    }
    Ok(text)
}

/// Maior fronteira de caractere até `limit` bytes.
///
/// `&texto[..n]` faz **pânico** quando `n` cai no meio de um caractere
/// multibyte — e documento em português é cheio de acento, então o corte quase
/// sempre cai num deles. Um pânico aqui derruba a ferramenta inteira e o modelo
/// recebe "erro desconhecido" ao abrir um arquivo grande.
///
/// Mora neste módulo porque ele é o de baixo: `tools.rs` já depende de `pdf`,
/// e o contrário criaria um ciclo só para não repetir oito linhas.
pub(crate) fn floor_char_boundary(text: &str, limit: usize) -> usize {
    if limit >= text.len() {
        return text.len();
    }
    let mut cut = limit;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/* --------------------------- strings do PDF ----------------------------- */

// # POR QUE ESTAS FUNÇÕES ANEXAM EM VEZ DE DEVOLVER `String`
//
// Um content stream de 2 MB tem dezenas de milhares de operadores de texto. Na
// primeira versão cada um deles alocava um `Vec` (para os bytes decodados), uma
// `String` (para a conversão) e ainda copiava o resultado uma terceira vez para
// a linha corrente — três alocações e três cópias por `Tj`. Medido, era a maior
// parte do custo da extração.
//
// Por isso o núcleo escreve DIRETO no destino e recebe o buffer de bytes
// (`scratch`) emprestado de quem chama, que o reaproveita do começo ao fim do
// stream. As versões que devolvem `String` continuam existindo logo abaixo,
// `#[cfg(test)]`, porque é por elas que os testes de formato entram — e testar
// o núcleo por um invólucro de três linhas é melhor do que ter duas
// implementações do mesmo escape para divergirem.

/// Decodifica uma string literal `(...)` no fim de `out`, resolvendo os escapes
/// do formato.
///
/// PDF usa escapes de barra invertida como C, mais o octal `\ddd` e a quebra de
/// linha escapada (que significa "continua na mesma linha", não um `\n`).
fn push_literal(out: &mut String, scratch: &mut Vec<u8>, bytes: &[u8]) {
    // Os escapes têm de ser resolvidos em BYTES antes da conversão para texto:
    // é o resultado deles que pode começar com o BOM `FE FF` do UTF-16.
    scratch.clear();
    scratch.reserve(bytes.len());
    push_literal_bytes(scratch, bytes);
    push_pdf_bytes(out, scratch);
}

/// Só os escapes, sobre o buffer de bytes. Separado de [`push_literal`] para o
/// laço abaixo continuar sendo o mesmo de antes, linha por linha.
fn push_literal_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        if index >= bytes.len() {
            break;
        }
        match bytes[index] {
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'b' => out.push(8),
            b'f' => out.push(12),
            b'(' => out.push(b'('),
            b')' => out.push(b')'),
            b'\\' => out.push(b'\\'),
            // Barra + quebra de linha = continuação; nada é emitido.
            b'\n' => {}
            b'\r' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    index += 1;
                }
            }
            b'0'..=b'7' => {
                let mut value = 0u16;
                let mut digits = 0;
                while digits < 3 {
                    match bytes.get(index) {
                        Some(digit @ b'0'..=b'7') => {
                            value = value * 8 + u16::from(digit - b'0');
                            index += 1;
                            digits += 1;
                        }
                        _ => break,
                    }
                }
                index -= 1; // o laço externo avança
                out.push((value & 0xff) as u8);
            }
            other => out.push(other),
        }
        index += 1;
    }
}

/// Decodifica uma string hexadecimal `<48656C6C6F>` no fim de `out`.
///
/// Emparelha os dígitos numa passada só. A versão anterior montava um `Vec` com
/// um dígito por posição e depois um segundo `Vec` com os bytes — dois vetores
/// por string hexadecimal, e há uma por `Tj` em PDF de fonte com subconjunto.
fn push_hex(out: &mut String, scratch: &mut Vec<u8>, bytes: &[u8]) {
    scratch.clear();
    scratch.reserve(bytes.len() / 2 + 1);
    let mut high: Option<u8> = None;
    for &symbol in bytes {
        if !symbol.is_ascii_hexdigit() {
            continue;
        }
        let value = match symbol {
            b'0'..=b'9' => symbol - b'0',
            b'a'..=b'f' => symbol - b'a' + 10,
            _ => symbol - b'A' + 10,
        };
        match high.take() {
            None => high = Some(value),
            Some(previous) => scratch.push((previous << 4) | value),
        }
    }
    // Dígito ímpar no fim: o formato manda completar com zero.
    if let Some(previous) = high {
        scratch.push(previous << 4);
    }
    push_pdf_bytes(out, scratch);
}

/// Converte bytes de string PDF em texto, ANEXANDO ao destino.
///
/// PDF usa PDFDocEncoding (parecido com Latin-1) por padrão, mas uma string que
/// comece com o BOM `FE FF` é UTF-16BE. Tratar tudo como Latin-1 produziria
/// caractere duplicado em PDF de origem Unicode.
fn push_pdf_bytes(out: &mut String, bytes: &[u8]) {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]));
        // `unwrap_or(REPLACEMENT_CHARACTER)` é exatamente o que
        // `from_utf16_lossy` faz — só que sem o `Vec<u16>` e sem a `String`
        // intermediários.
        out.extend(
            char::decode_utf16(units).map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER)),
        );
        return;
    }
    // Latin-1: cada byte é um code point. Nunca falha.
    //
    // O atalho do ASCII não é micro-otimização gratuita: texto de PDF é ASCII
    // quase inteiro (o acento é a exceção), e byte ASCII JÁ É UTF-8 válido —
    // dá para copiar o trecho em bloco. `is_ascii` é vetorizado; o laço de
    // `push(char)` codifica um caractere por vez, com conferência de
    // capacidade a cada byte.
    if bytes.is_ascii() {
        // O `unwrap_or_default` nunca dispara: ASCII é sempre UTF-8 válido.
        out.push_str(std::str::from_utf8(bytes).unwrap_or_default());
        return;
    }
    out.reserve(bytes.len());
    out.extend(bytes.iter().map(|&byte| byte as char));
}

/* --------------------------- content stream ----------------------------- */

/// Interpreta um content stream e devolve o texto que ele desenha.
///
/// É um varredor de tokens, não um parser completo de PDF: só precisa
/// reconhecer strings, arrays e os operadores de texto. Operador desconhecido é
/// ignorado — um PDF real tem centenas deles (gráfico, cor, matriz) e nenhum
/// interessa aqui.
fn text_from_content(content: &str) -> String {
    let bytes = content.as_bytes();
    // Um content stream é sobretudo operador; o texto que sai dele fica numa
    // fração do tamanho. Reservar um quarto evita a dúzia de realocações que a
    // `String` vazia faria enquanto dobra de tamanho até os 400 KB do teto.
    let mut out = String::with_capacity(content.len() / 4);
    // Pedaços da linha corrente; só viram linha quando o cursor move.
    let mut line = String::new();
    // Buffers emprestados aos decodificadores. Vivem a varredura inteira: é o
    // que troca "uma alocação por operador de texto" por "uma por stream".
    let mut scratch: Vec<u8> = Vec::new();
    let mut number = String::new();
    let mut index = 0;

    let flush = |line: &mut String, out: &mut String| {
        let text = line.trim_end();
        if !text.is_empty() {
            out.push_str(text);
            out.push('\n');
        }
        line.clear();
    };

    while index < bytes.len() {
        match bytes[index] {
            b'(' => {
                index = read_literal_into(&mut line, &mut scratch, bytes, index);
            }
            // `<<` abre dicionário, não string hexadecimal.
            b'<' if bytes.get(index + 1) != Some(&b'<') => {
                match bytes[index..].iter().position(|&b| b == b'>') {
                    Some(offset) => {
                        let end = index + offset;
                        // Direto dos bytes: a versão anterior fazia um
                        // `from_utf8_lossy(...).into_owned()` só para entregar
                        // um `&str` a quem ia filtrar dígito hexadecimal byte a
                        // byte. Byte não-hexadecimal é descartado dos dois
                        // jeitos, então o resultado é o mesmo.
                        push_hex(&mut line, &mut scratch, &bytes[index + 1..end]);
                        index = end + 1;
                    }
                    None => break,
                }
            }
            b'[' => {
                // Array do TJ: strings intercaladas com ajustes numéricos.
                index = read_tj_array_into(&mut line, &mut scratch, &mut number, bytes, index);
            }
            b'%' => {
                // Comentário vai até o fim da linha.
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            symbol if symbol.is_ascii_alphabetic() || symbol == b'\'' || symbol == b'"' => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'*')
                {
                    index += 1;
                }
                // `'` e `"` são operadores de um caractere só.
                let operator = if index == start {
                    &content[start..start + 1]
                } else {
                    &content[start..index]
                };
                if index == start {
                    index += 1;
                }
                match operator {
                    // Movimento de cursor e fim de bloco de texto quebram linha.
                    "Td" | "TD" | "T*" | "ET" | "'" | "\"" => flush(&mut line, &mut out),
                    _ => {}
                }
            }
            _ => index += 1,
        }
    }
    flush(&mut line, &mut out);
    out
}

/// Lê uma string literal a partir de `(`, respeitando parênteses aninhados, e
/// anexa o texto a `out`. Devolve onde a leitura parou.
fn read_literal_into(
    out: &mut String,
    scratch: &mut Vec<u8>,
    bytes: &[u8],
    start: usize,
) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    let content_start = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1, // pula o escapado, inclusive `\)`
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    push_literal(out, scratch, &bytes[content_start..index]);
                    return index + 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    // String não fechada: usa o que deu, sem estourar.
    push_literal(out, scratch, &bytes[content_start.min(bytes.len())..]);
    bytes.len()
}

/// Lê o array do `TJ`, transformando ajuste muito negativo em espaço, e anexa o
/// texto a `out`. Devolve onde a leitura parou.
///
/// `[(Ola) -250 (mundo)] TJ` não tem espaço nenhum na string: o espaço entre as
/// palavras É o ajuste numérico. Sem esta conversão, o texto sai grudado.
fn read_tj_array_into(
    out: &mut String,
    scratch: &mut Vec<u8>,
    number: &mut String,
    bytes: &[u8],
    start: usize,
) -> usize {
    // Onde este array começou dentro de `out`.
    //
    // Não é firula: `apply_adjustment` só emite o espaço quando o texto do
    // ARRAY ainda não termina em espaço. Escrevendo direto na linha corrente,
    // um `out.ends_with(' ')` cru passaria a enxergar o que veio do operador
    // ANTERIOR e engoliria um espaço que a versão que montava a string do array
    // à parte emitia. Guardar o início preserva o comportamento exato.
    let inicio = out.len();
    let mut index = start + 1;
    number.clear();
    while index < bytes.len() {
        match bytes[index] {
            b']' => {
                index += 1;
                break;
            }
            b'(' => {
                apply_adjustment(number, out, inicio);
                index = read_literal_into(out, scratch, bytes, index);
            }
            b'<' => {
                apply_adjustment(number, out, inicio);
                match bytes[index..].iter().position(|&b| b == b'>') {
                    Some(offset) => {
                        let end = index + offset;
                        push_hex(out, scratch, &bytes[index + 1..end]);
                        index = end + 1;
                    }
                    None => break,
                }
            }
            b'-' | b'.' | b'0'..=b'9' => {
                number.push(bytes[index] as char);
                index += 1;
            }
            _ => {
                apply_adjustment(number, out, inicio);
                index += 1;
            }
        }
    }
    apply_adjustment(number, out, inicio);
    index
}

/// `inicio` é onde o array corrente começa dentro de `out` — ver a explicação
/// em [`read_tj_array_into`].
fn apply_adjustment(number: &mut String, out: &mut String, inicio: usize) {
    if number.is_empty() {
        return;
    }
    if let Ok(value) = number.parse::<f32>() {
        let termina_em_espaco = out.len() > inicio && out.ends_with(' ');
        if value < SPACE_THRESHOLD && !termina_em_espaco {
            out.push(' ');
        }
    }
    number.clear();
}

/* -------------------------------- streams -------------------------------- */

/// Um stream do arquivo: o dicionário que o precede e os bytes crus.
struct RawStream<'a> {
    dict: &'a [u8],
    data: &'a [u8],
}

/// Localiza os pares `stream`…`endstream` e o dicionário de cada um.
fn find_streams(bytes: &[u8]) -> Vec<RawStream<'_>> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(at) = find(bytes, b"stream", cursor) {
        let mut start = at + b"stream".len();
        // Depois da palavra vem CRLF ou LF — e só isso.
        if bytes.get(start) == Some(&b'\r') {
            start += 1;
        }
        if bytes.get(start) == Some(&b'\n') {
            start += 1;
        }
        let Some(end) = find(bytes, b"endstream", start) else {
            break;
        };
        // O dicionário é o trecho anterior; 512 bytes cobrem com folga.
        let dict_start = at.saturating_sub(512);
        out.push(RawStream {
            dict: &bytes[dict_start..at],
            data: &bytes[start..end],
        });
        cursor = end + b"endstream".len();
    }
    out
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() || needle.len() > haystack.len() - from {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

/// Descomprime, quando o dicionário disser FlateDecode.
fn decode_stream(stream: &RawStream<'_>) -> Option<Vec<u8>> {
    if contains(stream.dict, b"/FlateDecode") {
        let mut decoder = ZlibDecoder::new(stream.data);
        let mut out = Vec::new();
        // Stream corrompido ou com filtro encadeado que não tratamos: aproveita
        // o que já saiu. Muitos PDFs têm lixo no fim do stream, e desistir do
        // arquivo inteiro por causa do último quilobyte seria pior.
        return match decoder.read_to_end(&mut out) {
            Ok(_) => Some(out),
            Err(_) if !out.is_empty() => Some(out),
            Err(_) => None,
        };
    }
    // Filtro que não sabemos abrir: melhor pular que devolver binário.
    if contains(stream.dict, b"/Filter") {
        return None;
    }
    Some(stream.data.to_vec())
}

/// PDF cifrado tem `/Encrypt` no trailer. Ler mesmo assim devolveria lixo.
fn is_encrypted(bytes: &[u8]) -> bool {
    contains(bytes, b"/Encrypt")
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ------------------------ invólucros dos testes ----------------------- */
    //
    // O produto não devolve mais `String` por string decodificada — ele anexa
    // ao destino (ver o bloco "POR QUE ESTAS FUNÇÕES ANEXAM"). Os testes de
    // formato, porém, são sobre O QUE SAI de cada escape, e ficam bem mais
    // legíveis comparando duas strings. Estes três invólucros existem só para
    // isso: chamam o MESMO núcleo, então não há segunda implementação para
    // divergir do produto.

    fn decode_literal(bytes: &[u8]) -> String {
        let mut out = String::new();
        push_literal(&mut out, &mut Vec::new(), bytes);
        out
    }

    fn decode_hex(text: &str) -> String {
        let mut out = String::new();
        push_hex(&mut out, &mut Vec::new(), text.as_bytes());
        out
    }

    fn from_pdf_bytes(bytes: &[u8]) -> String {
        let mut out = String::new();
        push_pdf_bytes(&mut out, bytes);
        out
    }

    #[test]
    fn literal_resolve_os_escapes_do_formato() {
        assert_eq!(decode_literal(br"Ola\nmundo"), "Ola\nmundo");
        assert_eq!(decode_literal(br"par\(entese\)"), "par(entese)");
        assert_eq!(decode_literal(br"barra\\"), "barra\\");
    }

    #[test]
    fn literal_le_octal() {
        // \101 = 'A'
        assert_eq!(decode_literal(br"\101\102\103"), "ABC");
        // octal curto no fim
        assert_eq!(decode_literal(br"\52"), "*");
    }

    /// Barra + quebra de linha é CONTINUAÇÃO, não um \n no texto.
    #[test]
    fn literal_trata_continuacao_de_linha() {
        assert_eq!(decode_literal(b"linha\\\ncontinua"), "linhacontinua");
    }

    #[test]
    fn hex_decodifica_e_completa_digito_impar() {
        assert_eq!(decode_hex("48656C6C6F"), "Hello");
        // dígito ímpar: o formato manda completar com zero → 0x40 = '@'
        assert_eq!(decode_hex("4"), "@");
        assert_eq!(decode_hex("48 65 6C"), "Hel");
    }

    /// Sem isto, PDF de origem Unicode sai com caractere duplicado.
    #[test]
    fn bom_utf16_e_reconhecido() {
        let bytes = [0xFE, 0xFF, 0x00, 0x4F, 0x00, 0x6C, 0x00, 0xE1];
        assert_eq!(from_pdf_bytes(&bytes), "Olá");
    }

    #[test]
    fn conteudo_simples_com_tj() {
        let text = text_from_content("BT /F1 12 Tf 72 720 Td (Bom dia) Tj ET");
        assert_eq!(text.trim(), "Bom dia");
    }

    /// O espaço entre palavras num TJ É o ajuste numérico, não um caractere.
    #[test]
    fn ajuste_grande_do_tj_vira_espaco() {
        let text = text_from_content("BT [(Ola) -250 (mundo)] TJ ET");
        assert_eq!(text.trim(), "Ola mundo");
    }

    #[test]
    fn ajuste_pequeno_nao_vira_espaco() {
        // -20 é kerning entre letras, não separação de palavra
        let text = text_from_content("BT [(Va) -20 (i)] TJ ET");
        assert_eq!(text.trim(), "Vai");
    }

    #[test]
    fn movimento_de_cursor_quebra_linha() {
        let text = text_from_content("BT (primeira) Tj 0 -14 Td (segunda) Tj ET");
        assert_eq!(text.trim(), "primeira\nsegunda");
    }

    #[test]
    fn string_com_parentese_aninhado_nao_termina_cedo() {
        let text = text_from_content("BT (a (b) c) Tj ET");
        assert_eq!(text.trim(), "a (b) c");
    }

    #[test]
    fn parentese_escapado_nao_fecha_a_string() {
        let text = text_from_content(r"BT (50\% \(cinquenta\)) Tj ET");
        assert!(text.contains("(cinquenta)"), "veio: {text}");
    }

    #[test]
    fn hex_string_no_conteudo() {
        assert_eq!(text_from_content("BT <426F6D> Tj ET").trim(), "Bom");
    }

    #[test]
    fn comentario_e_ignorado() {
        assert_eq!(
            text_from_content("% um comentario\nBT (ok) Tj ET").trim(),
            "ok"
        );
    }

    #[test]
    fn operador_desconhecido_nao_atrapalha() {
        let text = text_from_content("0 0 1 RG 1 w BT (texto) Tj ET S Q");
        assert_eq!(text.trim(), "texto");
    }

    #[test]
    fn conteudo_vazio_devolve_vazio() {
        assert_eq!(text_from_content(""), "");
        assert_eq!(text_from_content("Q q 1 0 0 1 0 0 cm"), "");
    }

    #[test]
    fn corte_respeita_fronteira_de_caractere() {
        let texto = "áéí"; // 6 bytes, 3 caracteres
        assert_eq!(floor_char_boundary(texto, 3), 2);
        assert_eq!(floor_char_boundary(texto, 99), 6);
    }

    /* ---------------------- arquivo PDF de verdade --------------------- */

    /// Monta um PDF mínimo mas VÁLIDO, com o content stream comprimido — é o
    /// caminho que um PDF real exercita.
    fn pdf_minimo(conteudo: &str, comprimir: bool) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let dados: Vec<u8> = if comprimir {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(conteudo.as_bytes()).expect("comprimir");
            encoder.finish().expect("fechar o compressor")
        } else {
            conteudo.as_bytes().to_vec()
        };
        let mut out = Vec::new();
        out.extend_from_slice(b"%PDF-1.7\n");
        out.extend_from_slice(b"1 0 obj\n<< /Type /Page >>\nendobj\n");
        out.extend_from_slice(b"2 0 obj\n<< /Length ");
        out.extend_from_slice(dados.len().to_string().as_bytes());
        if comprimir {
            out.extend_from_slice(b" /Filter /FlateDecode");
        }
        out.extend_from_slice(b" >>\nstream\n");
        out.extend_from_slice(&dados);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out.extend_from_slice(b"trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        out
    }

    #[test]
    fn extrai_de_pdf_comprimido_de_verdade() {
        let pdf = pdf_minimo("BT /F1 12 Tf 72 720 Td (Relatorio trimestral) Tj ET", true);
        let texto = extract_text_from_bytes(&pdf).expect("deveria extrair");
        assert!(texto.contains("Relatorio trimestral"), "veio: {texto}");
    }

    #[test]
    fn extrai_de_pdf_sem_compressao() {
        let pdf = pdf_minimo("BT (Sem filtro) Tj ET", false);
        let texto = extract_text_from_bytes(&pdf).expect("deveria extrair");
        assert!(texto.contains("Sem filtro"));
    }

    #[test]
    fn varias_linhas_saem_na_ordem_do_stream() {
        let pdf = pdf_minimo("BT (linha um) Tj 0 -14 Td (linha dois) Tj ET", true);
        let texto = extract_text_from_bytes(&pdf).expect("deveria extrair");
        let linhas: Vec<&str> = texto.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(linhas, vec!["linha um", "linha dois"]);
    }

    #[test]
    fn arquivo_que_nao_e_pdf_e_recusado() {
        let erro = extract_text_from_bytes(b"PK\x03\x04 isto e um zip").expect_err("deveria recusar");
        assert!(erro.contains("não é um PDF"), "veio: {erro}");
    }

    /// Ler PDF cifrado devolveria lixo — a recusa precisa ser explícita.
    #[test]
    fn pdf_cifrado_e_recusado_com_motivo() {
        let mut pdf = pdf_minimo("BT (x) Tj ET", true);
        pdf.extend_from_slice(b"\ntrailer << /Encrypt 5 0 R >>\n");
        let erro = extract_text_from_bytes(&pdf).expect_err("deveria recusar");
        assert!(erro.contains("senha"), "veio: {erro}");
    }

    /// PDF digitalizado não tem texto — dizer isso é melhor que devolver "".
    #[test]
    fn pdf_sem_texto_explica_o_motivo() {
        let pdf = pdf_minimo("q 1 0 0 1 0 0 cm /Im0 Do Q", true);
        let erro = extract_text_from_bytes(&pdf).expect_err("deveria recusar");
        assert!(erro.contains("digitalizado"), "veio: {erro}");
    }

    /* ---------------------- medição (ver src/bench.rs) --------------------- */

    /// Content stream REALISTA, do tamanho de um relatório de ~60 páginas.
    ///
    /// É a mistura que um PDF exportado do Word produz: `TJ` com ajuste de
    /// kerning entre quase toda letra, literais com escape octal (é assim que o
    /// acento aparece num PDF de origem Latin-1), uma string hexadecimal aqui e
    /// ali, e MUITO operador gráfico no meio — que o varredor tem de atravessar
    /// sem produzir texto. Um corpus só de `(x) Tj` mediria o caso que não
    /// existe em arquivo nenhum.
    fn corpus_content_stream(alvo_bytes: usize) -> String {
        const BLOCO: &str = concat!(
            "BT\n/F1 11 Tf\n1 0 0 1 72 720 Tm\n",
            "[(Rela) -3 (t) 8 (\\363rio ) -2 (trimestral de opera) 4 (\\347\\365es)] TJ\n",
            "0 -14.4 Td\n",
            "(Se\\347\\343o 1 \\226 Introdu\\347\\343o e contexto do per\\355odo) Tj\n",
            "0 -14.4 Td\n",
            "[(A carteira ) -250 (encerrou ) -250 (o ) -250 (trimestre ) -250 (com ) -250 (crescimento)] TJ\n",
            "0 -14.4 Td\n",
            "<4465207175652069737365207472617461206f2072656c6174f372696f> Tj\n",
            "ET\n",
            "q 1 0 0 1 0 0 cm 0.8 0.8 0.8 RG 0.5 w 72 690 m 540 690 l S Q\n",
            "q /GS0 gs 0 0 0 rg BT /F2 9 Tf 1 0 0 1 72 60 Tm (P\\341gina) Tj ET Q\n",
        );
        let mut out = String::with_capacity(alvo_bytes + BLOCO.len());
        while out.len() < alvo_bytes {
            out.push_str(BLOCO);
        }
        out
    }

    /// O varredor de operadores em ~2 MB de content stream.
    #[test]
    #[ignore = "medição; rode com: cargo test --release -- --ignored --nocapture"]
    fn bench_text_from_content_2mb() {
        let corpus = corpus_content_stream(2 * 1024 * 1024);
        let (tempo, texto) = crate::bench::median(|| text_from_content(&corpus));
        assert!(texto.contains("Relatório"), "o varredor não leu o corpus");
        crate::bench::report(
            "pdf::text_from_content",
            &format!("{} MiB de stream", corpus.len() / (1024 * 1024)),
            tempo,
            corpus.len() as f64 / (1024.0 * 1024.0),
            "MiB",
        );
    }

    /// O caminho INTEIRO, do arquivo ao texto: assinatura, `/Encrypt`, varredura
    /// de `stream`…`endstream`, inflate e varredor.
    ///
    /// Vale medir separado porque a varredura de bytes percorre o arquivo
    /// COMPRIMIDO (megabytes) enquanto o varredor de operadores percorre o
    /// descomprimido — os dois custos crescem por motivos diferentes.
    #[test]
    #[ignore = "medição; rode com: cargo test --release -- --ignored --nocapture"]
    fn bench_extract_text_de_pdf_inteiro() {
        // Vinte páginas de texto MAIS o peso morto de um PDF real: num arquivo
        // de verdade a maior parte dos bytes é fonte embutida e imagem, e a
        // varredura de `stream`…`endstream` (e a de `/Encrypt`) atravessa tudo
        // isso. Sem esse peso o corpus comprimia para 17 KiB e o benchmark
        // media só o inflate — escondendo justamente a varredura de bytes.
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.7\n");
        let pagina = pdf_minimo(&corpus_content_stream(100 * 1024), true);
        // Reaproveita só o miolo (o `pdf_minimo` já traz cabeçalho e trailer
        // próprios; concatenar tudo daria um arquivo esquisito).
        let cabecalho = b"%PDF-1.7\n".len();
        let rodape = b"trailer\n<< /Root 1 0 R >>\n%%EOF\n".len();
        let miolo = &pagina[cabecalho..pagina.len() - rodape];
        // Pseudo-aleatório determinístico: imita fonte/imagem, que não comprime
        // e não é texto. Gerador na mão para não trazer crate de RNG.
        let mut semente = 0x2545_F491_4F6C_DD1Du64;
        let mut binario = Vec::with_capacity(150 * 1024);
        for _ in 0..(150 * 1024) {
            semente ^= semente << 13;
            semente ^= semente >> 7;
            semente ^= semente << 17;
            binario.push((semente >> 33) as u8);
        }
        for indice in 0..20 {
            pdf.extend_from_slice(miolo);
            pdf.extend_from_slice(
                format!("{} 0 obj\n<< /Subtype /Image /Length {} >>\nstream\n", indice + 10, binario.len())
                    .as_bytes(),
            );
            pdf.extend_from_slice(&binario);
            pdf.extend_from_slice(b"\nendstream\nendobj\n");
        }
        pdf.extend_from_slice(b"trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        let tamanho = pdf.len();
        let (tempo, texto) = crate::bench::median(|| {
            extract_text_from_bytes(&pdf).expect("o corpus tem texto extraível")
        });
        assert!(
            texto.contains("Relatório"),
            "veio: {}",
            texto.chars().take(80).collect::<String>()
        );
        crate::bench::report(
            "pdf::extract_text_from_bytes",
            &format!("{} KiB de arquivo", tamanho / 1024),
            tempo,
            tamanho as f64 / (1024.0 * 1024.0),
            "MiB",
        );
    }

    #[test]
    fn stream_de_imagem_e_pulado() {
        let mut pdf = pdf_minimo("BT (texto bom) Tj ET", true);
        // stream de imagem, que não deve virar texto
        pdf.extend_from_slice(b"3 0 obj\n<< /Subtype /Image /Length 4 >>\nstream\n");
        pdf.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0]);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        let texto = extract_text_from_bytes(&pdf).expect("deveria extrair");
        assert!(texto.contains("texto bom"));
        assert!(!texto.contains('\u{FFFD}'), "lixo binário vazou: {texto}");
    }
}
