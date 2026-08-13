//! Extrator de texto de PDF — escrito aqui, sem biblioteca de terceiros.
//!
//! Não há crate de PDF homologada, e a instrução nº 4 manda submeter
//! dependência nova a TI/SI antes de usar. Então o extrator é nosso. O único
//! empréstimo é o `flate2`, que **já está na árvore** (o `zip` depende dele
//! para o DOCX/XLSX/PPTX) — não acrescenta superfície de terceiros, só passa a
//! ser dependência explícita.
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
//! - `Td`, `TD`, `T*`, `ET`— movem o cursor; viram quebra de linha
//!
//! Ou seja: extrair texto de PDF é descomprimir os streams e interpretar esses
//! operadores. Não existe "o texto" guardado em lugar nenhum.
//!
//! ## Limites, ditos antes de alguém descobrir
//!
//! - **Sem `/ToUnicode`**: fontes com codificação própria (subconjunto
//!   embutido) devolvem os códigos internos, não as letras. Acontece com PDF
//!   de editoração; PDF de escritório e exportado de Word/Web costuma vir bem.
//! - **PDF cifrado não é lido** — e é recusado com mensagem clara, não com
//!   texto embaralhado.
//! - **A ordem é a do stream**, não a visual: layout de duas colunas pode sair
//!   intercalado.
//! - Não extrai imagem nem faz OCR.

use flate2::read::ZlibDecoder;
use std::io::Read;

/// Teto do arquivo aceito — PDF de centenas de MB é digitalização, não texto.
const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
/// Teto do texto devolvido ao modelo.
const MAX_TEXT_BYTES: usize = 400 * 1024;
/// Abaixo deste ajuste no `TJ`, o espaçamento representa um espaço de palavra.
const SPACE_THRESHOLD: f32 = -100.0;

/* --------------------------- strings do PDF --------------------------- */

/// Decodifica uma string literal `(...)`, resolvendo os escapes do formato.
///
/// PDF usa escapes de barra invertida como C, mais o octal `\ddd` e a quebra
/// de linha escapada (que significa "continua na mesma linha", não um `\n`).
pub fn decode_literal(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        i += 1;
        if i >= bytes.len() {
            break;
        }
        match bytes[i] {
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
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
            }
            b'0'..=b'7' => {
                let mut valor = 0u16;
                let mut digitos = 0;
                while digitos < 3 {
                    match bytes.get(i) {
                        Some(d @ b'0'..=b'7') => {
                            valor = valor * 8 + u16::from(d - b'0');
                            i += 1;
                            digitos += 1;
                        }
                        _ => break,
                    }
                }
                i -= 1; // o laço externo avança
                out.push((valor & 0xff) as u8);
            }
            outro => out.push(outro),
        }
        i += 1;
    }
    from_pdf_bytes(&out)
}

/// Decodifica uma string hexadecimal `<48656C6C6F>`.
pub fn decode_hex(text: &str) -> String {
    let digitos: Vec<u8> = text
        .bytes()
        .filter(|b| b.is_ascii_hexdigit())
        .map(|b| match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => b - b'A' + 10,
        })
        .collect();
    let mut out = Vec::with_capacity(digitos.len() / 2 + 1);
    let mut i = 0;
    while i < digitos.len() {
        // Dígito ímpar no fim: o formato manda completar com zero.
        let alto = digitos[i];
        let baixo = digitos.get(i + 1).copied().unwrap_or(0);
        out.push((alto << 4) | baixo);
        i += 2;
    }
    from_pdf_bytes(&out)
}

/// Converte bytes de string PDF em texto.
///
/// PDF usa PDFDocEncoding (parecido com Latin-1) por padrão, mas uma string
/// que comece com BOM `FE FF` é UTF-16BE. Tratar tudo como Latin-1 produziria
/// caracteres duplicados em PDF de origem Unicode.
fn from_pdf_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let unidades: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|par| u16::from_be_bytes([par[0], par[1]]))
            .collect();
        return String::from_utf16_lossy(&unidades);
    }
    // Latin-1: cada byte é um code point. Nunca falha.
    bytes.iter().map(|&b| b as char).collect()
}

/* --------------------------- content stream --------------------------- */

/// Interpreta um content stream e devolve o texto que ele desenha.
///
/// É um varredor de tokens, não um parser completo de PDF: só precisa
/// reconhecer strings, arrays e os operadores de texto. Operador desconhecido
/// é ignorado — um PDF real tem centenas deles (gráficos, cores, matrizes) e
/// nenhum interessa aqui.
pub fn text_from_content(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut out = String::new();
    /// Pedaços da linha corrente; só viram linha quando o cursor move.
    let mut linha = String::new();
    let mut i = 0;

    let flush = |linha: &mut String, out: &mut String| {
        let texto = linha.trim_end();
        if !texto.is_empty() {
            out.push_str(texto);
            out.push('\n');
        }
        linha.clear();
    };

    while i < bytes.len() {
        match bytes[i] {
            b'(' => {
                let (texto, fim) = read_literal(bytes, i);
                linha.push_str(&texto);
                i = fim;
            }
            b'<' if bytes.get(i + 1) != Some(&b'<') => {
                let fim = bytes[i..].iter().position(|&b| b == b'>').map(|p| i + p);
                match fim {
                    Some(fim) => {
                        linha.push_str(&decode_hex(&content[i + 1..fim]));
                        i = fim + 1;
                    }
                    None => break,
                }
            }
            b'[' => {
                // Array do TJ: strings intercaladas com ajustes numéricos.
                let (texto, fim) = read_tj_array(bytes, i);
                linha.push_str(&texto);
                i = fim;
            }
            b'%' => {
                // Comentário vai até o fim da linha.
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b if b.is_ascii_alphabetic() || b == b'\'' || b == b'"' => {
                let inicio = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'*') {
                    i += 1;
                }
                // `'` e `"` são operadores de um caractere só.
                let op = if i == inicio { &content[inicio..inicio + 1] } else { &content[inicio..i] };
                if i == inicio {
                    i += 1;
                }
                match op {
                    // Movimento de cursor e fim de bloco de texto quebram linha.
                    "Td" | "TD" | "T*" | "ET" | "'" | "\"" => flush(&mut linha, &mut out),
                    _ => {}
                }
            }
            _ => i += 1,
        }
    }
    flush(&mut linha, &mut out);
    out
}

/// Lê uma string literal a partir de `(`, respeitando parênteses aninhados.
fn read_literal(bytes: &[u8], start: usize) -> (String, usize) {
    let mut profundidade = 0i32;
    let mut i = start;
    let inicio_conteudo = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1, // pula o escapado, inclusive `\)`
            b'(' => profundidade += 1,
            b')' => {
                profundidade -= 1;
                if profundidade == 0 {
                    return (decode_literal(&bytes[inicio_conteudo..i]), i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    // String não fechada: usa o que deu, sem estourar.
    (decode_literal(&bytes[inicio_conteudo.min(bytes.len())..]), bytes.len())
}

/// Lê o array do `TJ`, transformando ajuste muito negativo em espaço.
///
/// `[(Ola) -250 (mundo)] TJ` não tem espaço nenhum na string: o espaço entre
/// as palavras É o ajuste numérico. Sem esta conversão, o texto sai grudado.
fn read_tj_array(bytes: &[u8], start: usize) -> (String, usize) {
    let mut out = String::new();
    let mut i = start + 1;
    let mut numero = String::new();
    while i < bytes.len() {
        match bytes[i] {
            b']' => {
                i += 1;
                break;
            }
            b'(' => {
                aplicar_ajuste(&mut numero, &mut out);
                let (texto, fim) = read_literal(bytes, i);
                out.push_str(&texto);
                i = fim;
            }
            b'<' => {
                aplicar_ajuste(&mut numero, &mut out);
                match bytes[i..].iter().position(|&b| b == b'>').map(|p| i + p) {
                    Some(fim) => {
                        let hex = String::from_utf8_lossy(&bytes[i + 1..fim]).into_owned();
                        out.push_str(&decode_hex(&hex));
                        i = fim + 1;
                    }
                    None => break,
                }
            }
            b'-' | b'.' | b'0'..=b'9' => {
                numero.push(bytes[i] as char);
                i += 1;
            }
            _ => {
                aplicar_ajuste(&mut numero, &mut out);
                i += 1;
            }
        }
    }
    aplicar_ajuste(&mut numero, &mut out);
    (out, i)
}

fn aplicar_ajuste(numero: &mut String, out: &mut String) {
    if numero.is_empty() {
        return;
    }
    if let Ok(valor) = numero.parse::<f32>() {
        if valor < SPACE_THRESHOLD && !out.ends_with(' ') {
            out.push(' ');
        }
    }
    numero.clear();
}

/* ------------------------------ streams ------------------------------- */

/// Um stream do arquivo: o dicionário que o precede e os bytes crus.
struct RawStream<'a> {
    dict: &'a [u8],
    data: &'a [u8],
}

/// Localiza os pares `stream`…`endstream` e o dicionário de cada um.
fn find_streams(bytes: &[u8]) -> Vec<RawStream<'_>> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = find(bytes, b"stream", cursor) {
        let mut inicio = rel + b"stream".len();
        // Após a palavra vem CRLF ou LF — e só isso.
        if bytes.get(inicio) == Some(&b'\r') {
            inicio += 1;
        }
        if bytes.get(inicio) == Some(&b'\n') {
            inicio += 1;
        }
        let Some(fim) = find(bytes, b"endstream", inicio) else {
            break;
        };
        // O dicionário é o trecho anterior; 512 bytes cobrem com folga.
        let dict_inicio = rel.saturating_sub(512);
        out.push(RawStream {
            dict: &bytes[dict_inicio..rel],
            data: &bytes[inicio..fim],
        });
        cursor = fim + b"endstream".len();
    }
    out
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|janela| janela == needle)
        .map(|p| p + from)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

/// Descomprime, quando o dicionário disser FlateDecode.
fn decode_stream(stream: &RawStream<'_>) -> Option<Vec<u8>> {
    if contains(stream.dict, b"/FlateDecode") {
        let mut decoder = ZlibDecoder::new(stream.data);
        let mut out = Vec::new();
        // Stream corrompido ou com filtro encadeado que não tratamos: pula.
        // Ler parcialmente ainda serve — muitos PDFs têm lixo no fim do stream.
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

/* ------------------------------ público ------------------------------- */

/// PDF cifrado tem `/Encrypt` no trailer. Ler mesmo assim devolveria lixo.
fn is_encrypted(bytes: &[u8]) -> bool {
    contains(bytes, b"/Encrypt")
}

/// Extrai o texto do PDF.
pub fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err("PDF maior que o limite aceito".into());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("o arquivo não é um PDF".into());
    }
    if is_encrypted(bytes) {
        return Err("PDF protegido por senha — remova a proteção antes de abrir".into());
    }

    let mut texto = String::new();
    for stream in find_streams(bytes) {
        let Some(dados) = decode_stream(&stream) else {
            continue;
        };
        // Só content stream interessa: imagem e fonte também são streams, e
        // passá-las pelo varredor produziria lixo.
        if contains(stream.dict, b"/Image") || contains(stream.dict, b"/FontFile") {
            continue;
        }
        let conteudo = String::from_utf8_lossy(&dados);
        // Um content stream sempre tem operador de texto; sem isso é gráfico.
        if !conteudo.contains("Tj") && !conteudo.contains("TJ") && !conteudo.contains("BT") {
            continue;
        }
        let parcial = text_from_content(&conteudo);
        if !parcial.trim().is_empty() {
            texto.push_str(&parcial);
            if texto.len() > MAX_TEXT_BYTES {
                texto.truncate(crate::office::floor_char_boundary(&texto, MAX_TEXT_BYTES));
                texto.push_str("\n… (texto truncado)");
                break;
            }
        }
    }

    if texto.trim().is_empty() {
        return Err(
            "nenhum texto extraível — o PDF pode ser digitalizado (imagem) ou usar fonte sem mapa Unicode".into(),
        );
    }
    Ok(texto)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let texto = text_from_content("BT /F1 12 Tf 72 720 Td (Bom dia) Tj ET");
        assert_eq!(texto.trim(), "Bom dia");
    }

    /// O espaço entre palavras num TJ É o ajuste numérico, não um caractere.
    #[test]
    fn ajuste_grande_do_tj_vira_espaco() {
        let texto = text_from_content("BT [(Ola) -250 (mundo)] TJ ET");
        assert_eq!(texto.trim(), "Ola mundo");
    }

    #[test]
    fn ajuste_pequeno_nao_vira_espaco() {
        // -20 é kerning entre letras, não separação de palavra
        let texto = text_from_content("BT [(Va) -20 (i)] TJ ET");
        assert_eq!(texto.trim(), "Vai");
    }

    #[test]
    fn movimento_de_cursor_quebra_linha() {
        let texto = text_from_content("BT (primeira) Tj 0 -14 Td (segunda) Tj ET");
        assert_eq!(texto.trim(), "primeira\nsegunda");
    }

    #[test]
    fn string_com_parentese_aninhado_nao_termina_cedo() {
        let texto = text_from_content("BT (a (b) c) Tj ET");
        assert_eq!(texto.trim(), "a (b) c");
    }

    #[test]
    fn parentese_escapado_nao_fecha_a_string() {
        let texto = text_from_content(r"BT (50\% \(cinquenta\)) Tj ET");
        assert!(texto.contains("(cinquenta)"), "veio: {texto}");
    }

    #[test]
    fn hex_string_no_conteudo() {
        assert_eq!(text_from_content("BT <426F6D> Tj ET").trim(), "Bom");
    }

    #[test]
    fn comentario_e_ignorado() {
        assert_eq!(text_from_content("% um comentario\nBT (ok) Tj ET").trim(), "ok");
    }

    #[test]
    fn operador_desconhecido_nao_atrapalha() {
        let texto = text_from_content("0 0 1 RG 1 w BT (texto) Tj ET S Q");
        assert_eq!(texto.trim(), "texto");
    }

    #[test]
    fn conteudo_vazio_devolve_vazio() {
        assert_eq!(text_from_content(""), "");
        assert_eq!(text_from_content("Q q 1 0 0 1 0 0 cm"), "");
    }

    /* ---------------------- arquivo PDF de verdade --------------------- */

    /// Monta um PDF mínimo mas VÁLIDO, com o content stream comprimido —
    /// é o caminho que um PDF real exercita.
    fn pdf_minimo(conteudo: &str, comprimir: bool) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let dados: Vec<u8> = if comprimir {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(conteudo.as_bytes()).unwrap();
            encoder.finish().unwrap()
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
        let texto = extract_pdf_text(&pdf).expect("deveria extrair");
        assert!(texto.contains("Relatorio trimestral"), "veio: {texto}");
    }

    #[test]
    fn extrai_de_pdf_sem_compressao() {
        let pdf = pdf_minimo("BT (Sem filtro) Tj ET", false);
        assert!(extract_pdf_text(&pdf).unwrap().contains("Sem filtro"));
    }

    #[test]
    fn varias_linhas_saem_na_ordem_do_stream() {
        let pdf = pdf_minimo("BT (linha um) Tj 0 -14 Td (linha dois) Tj ET", true);
        let texto = extract_pdf_text(&pdf).unwrap();
        let linhas: Vec<&str> = texto.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(linhas, vec!["linha um", "linha dois"]);
    }

    #[test]
    fn arquivo_que_nao_e_pdf_e_recusado() {
        let erro = extract_pdf_text(b"PK\x03\x04 isto e um zip").unwrap_err();
        assert!(erro.contains("não é um PDF"), "veio: {erro}");
    }

    /// Ler PDF cifrado devolveria lixo — a recusa precisa ser explícita.
    #[test]
    fn pdf_cifrado_e_recusado_com_motivo() {
        let mut pdf = pdf_minimo("BT (x) Tj ET", true);
        pdf.extend_from_slice(b"\ntrailer << /Encrypt 5 0 R >>\n");
        let erro = extract_pdf_text(&pdf).unwrap_err();
        assert!(erro.contains("senha"), "veio: {erro}");
    }

    /// PDF digitalizado não tem texto — dizer isso é melhor que devolver "".
    #[test]
    fn pdf_sem_texto_explica_o_motivo() {
        let pdf = pdf_minimo("q 1 0 0 1 0 0 cm /Im0 Do Q", true);
        let erro = extract_pdf_text(&pdf).unwrap_err();
        assert!(erro.contains("digitalizado"), "veio: {erro}");
    }

    #[test]
    fn stream_de_imagem_e_pulado() {
        let mut pdf = pdf_minimo("BT (texto bom) Tj ET", true);
        // stream de imagem, que não deve virar texto
        pdf.extend_from_slice(b"3 0 obj\n<< /Subtype /Image /Length 4 >>\nstream\n");
        pdf.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0]);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        let texto = extract_pdf_text(&pdf).unwrap();
        assert!(texto.contains("texto bom"));
        assert!(!texto.contains('\u{FFFD}'), "lixo binário vazou: {texto}");
    }
}
