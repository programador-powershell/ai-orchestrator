//! Edição do BINÁRIO OOXML — DOCX e PPTX — sem motor externo.
//!
//! Até aqui a IA só LIA esses arquivos. Editar dependia do Collabora (ver
//! `docs/adr-office-motor-wopi.md`), que exige contêiner e homologação. Este
//! módulo entrega o caso que resolve a maior parte do trabalho real —
//! **substituir texto** — mexendo só no chardata, sem criar nem remover
//! nenhuma tag.
//!
//! ## O que um spike contra um .docx real do Word mediu, e que muda o desenho
//!
//! O Word **fragmenta o texto em vários `<w:t>`** por rsid, correção
//! ortográfica e `w:proofErr` — não só por formatação. No documento medido:
//! 92% dos parágrafos tinham mais de um `<w:t>`, mediana de 3 caracteres por
//! nó. Com uma agulha atravessando a fronteira de dois runs, um `.replace()`
//! ingênuo dentro de `w:t` substituiu **zero** ocorrências.
//!
//! Por isso o casamento é feito no texto CONCATENADO do parágrafo, com um mapa
//! de volta para os spans. O valor entra no primeiro span coberto, o sufixo no
//! último, os do meio esvaziam. Nenhuma tag nasce ou morre — é o que mantém
//! `w:rPr`, `w:pStyle`, `w:numPr`, bookmarks e relações intactos.
//!
//! ## Por que isto não corrompe relações nem content types
//!
//! `w:t` é folha. `[Content_Types].xml` só lista partes, e nenhuma parte nasce
//! ou morre. Estilos e numeração são referências por ID resolvidas em arquivos
//! irmãos, que nem são abertos. As partes não tocadas são copiadas **já
//! comprimidas** (`raw_copy_file`), preservando ordem, CRC e método.

/// Dialeto OOXML: onde mora o parágrafo e onde mora o texto.
#[derive(Clone, Copy)]
pub struct Dialect {
    /// Nome da tag de parágrafo, sem `<`. Ex.: `w:p`, `a:p`.
    pub paragraph: &'static str,
    /// Nome da tag de texto, sem `<`. Ex.: `w:t`, `a:t`.
    pub text: &'static str,
}

pub const DOCX: Dialect = Dialect { paragraph: "w:p", text: "w:t" };
pub const PPTX: Dialect = Dialect { paragraph: "a:p", text: "a:t" };

/// Escapa para chardata XML. **A única forma de este módulo corromper um
/// arquivo é esquecer isto**: um `&` ou `<` cru gera XML malformado e o Word
/// abre com "conteúdo ilegível".
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Um `<w:t>` encontrado: onde começa e termina o CONTEÚDO, e onde começa a
/// tag de abertura (para poder acrescentar `xml:space`).
#[derive(Debug, Clone)]
struct TextSpan {
    tag_start: usize,
    content: std::ops::Range<usize>,
}

/// A posição é o início de uma tag com este nome exato?
///
/// Sem esta checagem, procurar por `<w:t` casaria `<w:tab>`, `<w:tbl>`,
/// `<w:trPr>` e `<w:tcPr>` — e o texto seria escrito dentro de uma tabela,
/// destruindo o documento.
fn is_tag_boundary(xml: &str, after: usize) -> bool {
    matches!(xml.as_bytes().get(after), Some(b'>') | Some(b' ') | Some(b'/'))
}

/// Localiza os spans de texto dentro de um trecho, ignorando os autofechados.
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
        let Some(gt) = xml[tag_start..].find('>') else { break };
        let open_end = tag_start + gt + 1;
        // `<w:t/>` é vazio: não tem conteúdo para casar.
        if xml.as_bytes().get(open_end.saturating_sub(2)) == Some(&b'/') {
            cursor = open_end;
            continue;
        }
        let Some(rel_close) = xml[open_end..].find(&close) else { break };
        let content_end = open_end + rel_close;
        spans.push(TextSpan { tag_start, content: open_end..content_end });
        cursor = content_end + close.len();
    }
    spans
}

/// Intervalos de um parágrafo (conteúdo entre `<w:p…>` e `</w:p>`).
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
        let Some(gt) = xml[start..].find('>') else { break };
        let body_start = start + gt + 1;
        match xml[body_start..].find(&close) {
            Some(rel) => {
                out.push(body_start..body_start + rel);
                cursor = body_start + rel + close.len();
            }
            None => break,
        }
    }
    out
}

/// O trecho está dentro de uma marca de controle de alterações ou de código de
/// campo?
///
/// - `<w:ins>`/`<w:del>`: escrever ali atribui o texto da IA ao revisor humano
///   original no painel de revisão do Word.
/// - `<w:instrText>`: é o CÓDIGO do campo (TOC, MERGEFIELD). Escrever ali muda
///   a semântica do campo, não o texto que se vê.
fn is_protected(paragraph: &str) -> bool {
    paragraph.contains("<w:ins ")
        || paragraph.contains("<w:ins>")
        || paragraph.contains("<w:del ")
        || paragraph.contains("<w:del>")
        || paragraph.contains("<w:instrText")
}

/// Precisa de `xml:space="preserve"`? Sem o atributo o Word **come** os
/// espaços das bordas e a palavra cola na vizinha.
fn needs_preserve(value: &str) -> bool {
    value.starts_with(' ') || value.ends_with(' ')
}

/// Substitui `needle` por `value` no XML, casando no texto concatenado de cada
/// parágrafo. Devolve o XML novo e quantas ocorrências trocou.
///
/// Puro: não toca em disco. É aqui que mora toda a lógica arriscada, e é por
/// isso que está separado do IO.
pub fn replace_in_xml(xml: &str, needle: &str, value: &str, dialect: &Dialect) -> (String, usize) {
    if needle.is_empty() {
        return (xml.to_string(), 0);
    }
    // A agulha vem do usuário como texto puro; o XML guarda `A &amp; B`.
    let needle_xml = escape_xml(needle);
    let value_xml = escape_xml(value);

    // Edições acumuladas como (intervalo absoluto, texto novo). Aplicadas do
    // fim para o começo, para os offsets anteriores continuarem válidos.
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    let mut replaced = 0usize;

    for para in paragraph_ranges(xml, dialect) {
        let body = &xml[para.clone()];
        if is_protected(body) {
            continue;
        }
        let spans = text_spans(body, dialect);
        if spans.is_empty() {
            continue;
        }
        // Texto concatenado do parágrafo + mapa offset→span.
        let mut flat = String::new();
        let mut map: Vec<(usize, usize)> = Vec::new(); // (offset no flat, índice do span)
        for (index, span) in spans.iter().enumerate() {
            map.push((flat.len(), index));
            flat.push_str(&body[span.content.clone()]);
        }

        // Coleta as ocorrências sem sobreposição.
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

        // Aplica de trás para frente dentro do parágrafo.
        for hit in hits.iter().rev() {
            let start = *hit;
            let end = start + needle_xml.len();
            let first = span_at(&map, &spans, &flat, start);
            let last = span_at(&map, &spans, &flat, end.saturating_sub(1));
            let (Some(first), Some(last)) = (first, last) else { continue };

            let (fi, f_off) = first;
            let (li, l_off) = last;
            let f_span = &spans[fi];
            let l_span = &spans[li];

            if fi == li {
                // Cabe num span só: troca o pedaço.
                let abs = para.start + f_span.content.start + f_off;
                edits.push((abs..abs + needle_xml.len(), value_xml.clone()));
            } else {
                // Atravessa runs: valor no primeiro, sufixo no último, meio vazio.
                let abs_first = para.start + f_span.content.start + f_off;
                let first_end = para.start + f_span.content.end;
                edits.push((abs_first..first_end, value_xml.clone()));
                for middle in (fi + 1)..li {
                    let span = &spans[middle];
                    edits.push((
                        para.start + span.content.start..para.start + span.content.end,
                        String::new(),
                    ));
                }
                let abs_last_start = para.start + l_span.content.start;
                edits.push((abs_last_start..abs_last_start + l_off + 1, String::new()));
            }

            // `xml:space="preserve"` no span que recebe o valor.
            if needs_preserve(value) {
                if let Some(insert) = preserve_insert(xml, para.start + f_span.tag_start, dialect) {
                    edits.push((insert..insert, " xml:space=\"preserve\"".to_string()));
                }
            }
            replaced += 1;
        }
    }

    if edits.is_empty() {
        return (xml.to_string(), 0);
    }
    // Ordena por início decrescente e aplica — offsets anteriores intactos.
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut out = xml.to_string();
    for (range, text) in edits {
        out.replace_range(range, &text);
    }
    (out, replaced)
}

/// Índice do span e offset dentro dele, para uma posição no texto concatenado.
fn span_at(
    map: &[(usize, usize)],
    spans: &[TextSpan],
    _flat: &str,
    position: usize,
) -> Option<(usize, usize)> {
    let mut chosen: Option<(usize, usize)> = None;
    for (offset, index) in map {
        let len = spans[*index].content.len();
        if position >= *offset && position < offset + len {
            chosen = Some((*index, position - offset));
            break;
        }
    }
    chosen
}

/// Onde inserir `xml:space="preserve"` na tag de abertura — logo após o nome,
/// e só se ainda não existir.
fn preserve_insert(xml: &str, tag_start: usize, dialect: &Dialect) -> Option<usize> {
    let gt = xml[tag_start..].find('>')? + tag_start;
    if xml[tag_start..gt].contains("xml:space") {
        return None;
    }
    Some(tag_start + 1 + dialect.text.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(inner: &str) -> String {
        format!("<w:document><w:body><w:p>{inner}</w:p></w:body></w:document>")
    }

    #[test]
    fn troca_dentro_de_um_unico_run() {
        let xml = para("<w:r><w:t>Olá mundo</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "mundo", "Orchestrator", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("<w:t>Olá Orchestrator</w:t>"), "saiu: {out}");
    }

    /// O caso que o spike mediu falhando: 92% dos parágrafos reais têm o texto
    /// partido, e `.replace()` dentro de um `w:t` não acha nada.
    #[test]
    fn troca_agulha_que_atravessa_dois_runs() {
        let xml = para("<w:r><w:t>Ola Mul</w:t></w:r><w:r><w:t>tiplike hoje</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "Orchestrator", "ACME", &DOCX);
        assert_eq!(n, 1, "deveria achar atravessando runs; saiu: {out}");
        let texto = crate::office::xml_text(&out, &["w:p"]);
        assert!(texto.contains("Ola ACME hoje"), "texto final: {texto}");
    }

    #[test]
    fn agulha_atravessando_tres_runs_esvazia_o_do_meio() {
        let xml = para("<w:r><w:t>abc</w:t></w:r><w:r><w:t>DEF</w:t></w:r><w:r><w:t>ghi</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "cDEFg", "-", &DOCX);
        assert_eq!(n, 1);
        let texto = crate::office::xml_text(&out, &["w:p"]);
        assert_eq!(texto.trim(), "ab-hi");
    }

    /// Nenhuma tag pode nascer ou morrer — é o que preserva estilo e numeração.
    #[test]
    fn contagem_de_tags_nao_muda() {
        let xml = para("<w:r><w:rPr><w:b/></w:rPr><w:t>Ola Mul</w:t></w:r><w:r><w:t>tiplike</w:t></w:r>");
        let (out, _) = replace_in_xml(&xml, "Orchestrator", "ACME", &DOCX);
        assert_eq!(xml.matches("<w:t>").count(), out.matches("<w:t>").count());
        assert_eq!(xml.matches("<w:r>").count(), out.matches("<w:r>").count());
        assert!(out.contains("<w:b/>"), "formatação foi perdida: {out}");
    }

    /// A ÚNICA forma de corromper o arquivo — e é 100% evitável.
    #[test]
    fn valor_com_caracteres_especiais_e_escapado() {
        let xml = para("<w:r><w:t>empresa</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "empresa", "P&D <ativo>", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("P&amp;D &lt;ativo&gt;"), "não escapou: {out}");
        assert!(!out.contains("<ativo>"), "XML malformado: {out}");
    }

    /// A agulha vem do usuário como texto puro; o XML guarda a entidade.
    #[test]
    fn agulha_com_e_comercial_casa_a_entidade_no_xml() {
        let xml = para("<w:r><w:t>Pesquisa &amp; Desenvolvimento</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "Pesquisa & Desenvolvimento", "P&D", &DOCX);
        assert_eq!(n, 1, "deveria casar a entidade; saiu: {out}");
        assert!(out.contains("P&amp;D"));
    }

    /// `<w:t` é prefixo de `<w:tab>`, `<w:tbl>`, `<w:trPr>` — escrever ali
    /// destruiria a tabela.
    #[test]
    fn nao_confunde_w_t_com_tab_tbl_ou_trPr() {
        let xml = para("<w:r><w:tab/><w:t>alvo</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "alvo", "novo", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("<w:tab/>"), "tab foi corrompida: {out}");
        assert!(out.contains("<w:t>novo</w:t>"));
    }

    #[test]
    fn w_t_autofechado_e_ignorado() {
        let xml = para("<w:r><w:t/></w:r><w:r><w:t>alvo</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "alvo", "novo", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("<w:t/>"), "autofechado sumiu: {out}");
    }

    /// Sem o atributo o Word come o espaço e as palavras colam.
    #[test]
    fn valor_com_espaco_na_borda_ganha_xml_space_preserve() {
        let xml = para("<w:r><w:t>X</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "X", " espaçado ", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("xml:space=\"preserve\""), "saiu: {out}");
    }

    #[test]
    fn nao_duplica_xml_space_quando_ja_existe() {
        let xml = para("<w:r><w:t xml:space=\"preserve\">X</w:t></w:r>");
        let (out, _) = replace_in_xml(&xml, "X", " y ", &DOCX);
        assert_eq!(out.matches("xml:space").count(), 1, "duplicou: {out}");
    }

    /// Escrever num `w:ins` atribui o texto da IA ao revisor humano original.
    #[test]
    fn recusa_dentro_de_controle_de_alteracoes() {
        let xml = para("<w:ins w:author=\"Ana\"><w:r><w:t>alvo</w:t></w:r></w:ins>");
        let (out, n) = replace_in_xml(&xml, "alvo", "novo", &DOCX);
        assert_eq!(n, 0, "não podia mexer em w:ins");
        assert_eq!(out, xml);
    }

    /// `instrText` é o CÓDIGO do campo — trocar ali muda a semântica.
    #[test]
    fn recusa_dentro_de_codigo_de_campo() {
        let xml = para("<w:r><w:instrText>MERGEFIELD alvo</w:instrText></w:r><w:r><w:t>alvo</w:t></w:r>");
        let (_, n) = replace_in_xml(&xml, "alvo", "novo", &DOCX);
        assert_eq!(n, 0, "parágrafo com campo deve ser pulado inteiro");
    }

    /// A agulha não pode atravessar a fronteira do parágrafo — isso apagaria
    /// estrutura.
    #[test]
    fn nao_casa_atravessando_paragrafos() {
        let xml = format!(
            "<w:body><w:p><w:r><w:t>fim</w:t></w:r></w:p><w:p><w:r><w:t>inicio</w:t></w:r></w:p></w:body>"
        );
        let (_, n) = replace_in_xml(&xml, "fiminicio", "x", &DOCX);
        assert_eq!(n, 0);
    }

    #[test]
    fn troca_todas_as_ocorrencias_do_documento() {
        let xml = format!(
            "<w:body><w:p><w:r><w:t>a alvo b</w:t></w:r></w:p><w:p><w:r><w:t>c alvo d</w:t></w:r></w:p></w:body>"
        );
        let (out, n) = replace_in_xml(&xml, "alvo", "X", &DOCX);
        assert_eq!(n, 2);
        assert_eq!(out.matches("alvo").count(), 0);
    }

    #[test]
    fn duas_ocorrencias_no_mesmo_paragrafo() {
        let xml = para("<w:r><w:t>alvo e alvo</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "alvo", "X", &DOCX);
        assert_eq!(n, 2);
        assert!(out.contains("X e X"), "saiu: {out}");
    }

    #[test]
    fn agulha_ausente_devolve_o_xml_intacto() {
        let xml = para("<w:r><w:t>nada aqui</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "inexistente", "X", &DOCX);
        assert_eq!(n, 0);
        assert_eq!(out, xml);
    }

    #[test]
    fn agulha_vazia_nao_faz_nada() {
        let xml = para("<w:r><w:t>texto</w:t></w:r>");
        assert_eq!(replace_in_xml(&xml, "", "X", &DOCX).1, 0);
    }

    /// Apagar em nível de caractere = replace com vazio. Delete estrutural
    /// (parágrafo inteiro) NÃO é suportado de propósito.
    #[test]
    fn valor_vazio_apaga_o_texto_sem_remover_tags() {
        let xml = para("<w:r><w:t>remover isto</w:t></w:r>");
        let (out, n) = replace_in_xml(&xml, "remover ", "", &DOCX);
        assert_eq!(n, 1);
        assert!(out.contains("<w:t>isto</w:t>"), "saiu: {out}");
    }

    #[test]
    fn pptx_usa_a_t_dentro_de_a_p() {
        let xml = "<p:sld><a:p><a:r><a:t>Titulo an</a:t></a:r><a:r><a:t>tigo</a:t></a:r></a:p></p:sld>";
        let (out, n) = replace_in_xml(xml, "Titulo antigo", "Titulo novo", &PPTX);
        assert_eq!(n, 1, "saiu: {out}");
        assert!(out.contains("Titulo novo"));
    }

    #[test]
    fn escape_xml_cobre_as_tres_entidades() {
        assert_eq!(escape_xml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
        assert_eq!(escape_xml("limpo"), "limpo");
    }
}

/* ------------------------------ comando ------------------------------ */

use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    /// Quantas ocorrências foram trocadas, somando todas as partes.
    pub replaced: usize,
    /// Partes do zip efetivamente reescritas (ex.: document.xml, header1.xml).
    pub parts: Vec<String>,
}

/// Partes do DOCX que carregam texto visível.
///
/// Substituir só em `document.xml` faria um "substituir tudo" **parcial e
/// silencioso**: cabeçalho, rodapé e notas de um contrato ficariam com o texto
/// antigo, e o número reportado ao usuário estaria errado.
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

/// Resolve o caminho dentro da raiz do projeto — mesma checagem do `fsx`.
fn resolve_in_root(root: &str, path: &str) -> Result<PathBuf, String> {
    let canonical_root = Path::new(root)
        .canonicalize()
        .map_err(|_| "raiz do projeto inválida".to_string())?;
    let resolved = Path::new(root)
        .join(path)
        .canonicalize()
        .map_err(|_| "caminho não encontrado".to_string())?;
    if !resolved.starts_with(&canonical_root) {
        return Err("fora da raiz do projeto".into());
    }
    Ok(resolved)
}

/// Substitui texto num DOCX ou PPTX, reescrevendo o binário.
///
/// A escrita é ATÔMICA: o zip novo é montado em memória, gravado num arquivo
/// temporário e só então renomeado por cima do original. Um crash no meio da
/// serialização deixaria um `.docx` truncado e **irrecuperável** — ao
/// contrário de um `.md`, onde ao menos sobra o texto.
#[tauri::command]
pub fn office_replace_text(
    root: String,
    path: String,
    needle: String,
    value: String,
) -> Result<EditOutcome, String> {
    let lower = path.to_ascii_lowercase();
    let dialect = if lower.ends_with(".docx") {
        DOCX
    } else if lower.ends_with(".pptx") {
        PPTX
    } else if lower.ends_with(".xlsx") {
        // XLSX guarda o texto numa tabela compartilhada com índices por célula,
        // e a aba é resolvida pelo nome em workbook.xml. É outro projeto —
        // recusar é melhor que editar a célula errada.
        return Err("edição de XLSX ainda não é suportada (só docx e pptx)".into());
    } else {
        return Err("formato não suportado (só docx e pptx)".into());
    };
    if needle.trim().is_empty() {
        return Err("o texto a substituir não pode ser vazio".into());
    }

    let resolved = resolve_in_root(&root, &path)?;
    let bytes = std::fs::read(&resolved).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "arquivo não é um Office válido (zip corrompido)".to_string())?;

    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let alvos = if dialect.text == "w:t" {
        docx_text_parts(&names)
    } else {
        pptx_text_parts(&names)
    };

    // 1ª passada: calcula o XML novo de cada parte que tem ocorrência.
    let mut novos: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut replaced = 0usize;
    for nome in &alvos {
        let mut buffer = String::new();
        let leu = match archive.by_name(nome) {
            Ok(mut arquivo) => arquivo.read_to_string(&mut buffer).is_ok(),
            Err(_) => false,
        };
        if !leu {
            continue;
        }
        let (novo, n) = replace_in_xml(&buffer, &needle, &value, &dialect);
        if n > 0 {
            replaced += n;
            novos.insert(nome.clone(), novo);
        }
    }
    if replaced == 0 {
        return Ok(EditOutcome { replaced: 0, parts: Vec::new() });
    }

    // 2ª passada: reescreve o zip. As partes não tocadas são copiadas JÁ
    // COMPRIMIDAS, preservando ordem, CRC e método de compressão.
    let mut saida = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = zip::ZipWriter::new(&mut saida);
        for index in 0..archive.len() {
            let arquivo = archive
                .by_index_raw(index)
                .map_err(|error| format!("falha ao ler o pacote: {error}"))?;
            let nome = arquivo.name().to_string();
            match novos.get(&nome) {
                Some(conteudo) => {
                    drop(arquivo);
                    writer
                        .start_file(&nome, zip::write::SimpleFileOptions::default())
                        .map_err(|error| error.to_string())?;
                    writer
                        .write_all(conteudo.as_bytes())
                        .map_err(|error| error.to_string())?;
                }
                None => writer
                    .raw_copy_file(arquivo)
                    .map_err(|error| format!("falha ao copiar parte do pacote: {error}"))?,
            }
        }
        writer.finish().map_err(|error| error.to_string())?;
    }

    // Grava no temporário ao lado do destino (mesmo volume, para o rename ser
    // atômico) e só então substitui.
    let temporario = resolved.with_extension("aio-tmp");
    std::fs::write(&temporario, saida.into_inner()).map_err(|error| error.to_string())?;
    std::fs::rename(&temporario, &resolved).map_err(|error| {
        let _ = std::fs::remove_file(&temporario);
        format!("não foi possível substituir o arquivo: {error}")
    })?;

    let mut parts: Vec<String> = novos.into_keys().collect();
    parts.sort();
    Ok(EditOutcome { replaced, parts })
}

#[cfg(test)]
mod parts_tests {
    use super::*;

    /// Texto vive em mais partes que `document.xml` — cabeçalho, rodapé e
    /// notas. Ignorá-las faria um "substituir tudo" parcial e silencioso.
    #[test]
    fn docx_cobre_cabecalho_rodape_e_notas() {
        let nomes: Vec<String> = [
            "[Content_Types].xml",
            "word/document.xml",
            "word/header1.xml",
            "word/footer2.xml",
            "word/footnotes.xml",
            "word/endnotes.xml",
            "word/styles.xml",
            "word/_rels/document.xml.rels",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let alvos = docx_text_parts(&nomes);
        assert!(alvos.contains(&"word/document.xml".to_string()));
        assert!(alvos.contains(&"word/header1.xml".to_string()));
        assert!(alvos.contains(&"word/footer2.xml".to_string()));
        assert!(alvos.contains(&"word/footnotes.xml".to_string()));
        // styles e rels NÃO podem ser tocados
        assert!(!alvos.contains(&"word/styles.xml".to_string()));
        assert!(!alvos.iter().any(|n| n.contains("_rels")));
    }

    #[test]
    fn pptx_pega_so_os_slides() {
        let nomes: Vec<String> = [
            "ppt/presentation.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slides/_rels/slide1.xml.rels",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let alvos = pptx_text_parts(&nomes);
        assert_eq!(alvos.len(), 2);
        // layout e rels ficam de fora
        assert!(!alvos.iter().any(|n| n.contains("Layout") || n.contains("_rels")));
    }
}

/// Round-trip contra um DOCX real montado em memória.
///
/// Os testes puros provam o algoritmo de texto; estes provam o **container**:
/// que o zip reescrito preserva as partes não tocadas byte-a-byte, mantém a
/// ordem (`[Content_Types].xml` primeiro) e continua abrindo. Sem isto, um
/// erro na reescrita só apareceria no Word do usuário.
#[cfg(test)]
mod roundtrip {
    use super::*;
    use std::io::Write as _;

    /// Monta um .docx mínimo mas legítimo: content types, rels e o documento
    /// com o texto PARTIDO EM RUNS, como o Word realmente grava.
    fn docx_de_teste() -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default();
            let partes: [(&str, &str); 4] = [
                (
                    "[Content_Types].xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
                ),
                (
                    "_rels/.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
                ),
                (
                    "word/document.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Contrato com a Mul</w:t></w:r><w:r><w:t>tiplike Ltda</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>"#,
                ),
                (
                    "word/styles.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#,
                ),
            ];
            for (nome, conteudo) in partes {
                zip.start_file(nome, opts).expect("start_file");
                zip.write_all(conteudo.as_bytes()).expect("write");
            }
            zip.finish().expect("finish");
        }
        cursor.into_inner()
    }

    fn escrever_temporario(nome: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aio-office-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("criar dir");
        let caminho = dir.join(nome);
        std::fs::write(&caminho, bytes).expect("gravar");
        caminho
    }

    fn parte(bytes: &[u8], nome: &str) -> String {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("abrir zip");
        let mut texto = String::new();
        zip.by_name(nome)
            .expect("parte existe")
            .read_to_string(&mut texto)
            .expect("ler parte");
        texto
    }

    fn nomes(bytes: &[u8]) -> Vec<String> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("abrir zip");
        (0..zip.len())
            .map(|i| zip.by_index(i).expect("entrada").name().to_string())
            .collect()
    }

    #[test]
    fn edita_docx_real_preservando_o_pacote() {
        let caminho = escrever_temporario("contrato.docx", &docx_de_teste());
        let raiz = caminho.parent().unwrap().to_string_lossy().into_owned();
        let antes = std::fs::read(&caminho).expect("ler antes");

        let saida = office_replace_text(
            raiz,
            "contrato.docx".into(),
            "Orchestrator Ltda".into(),
            "ACME S.A.".into(),
        )
        .expect("edição deveria funcionar");

        // A agulha atravessava dois runs — é o caso que o replace ingênuo perde.
        assert_eq!(saida.replaced, 1);
        assert_eq!(saida.parts, vec!["word/document.xml".to_string()]);

        let depois = std::fs::read(&caminho).expect("ler depois");

        // O pacote continua sendo um zip válido, com as MESMAS partes e ordem.
        assert_eq!(nomes(&antes), nomes(&depois), "ordem/nomes das partes mudaram");
        assert_eq!(
            nomes(&depois).first().map(String::as_str),
            Some("[Content_Types].xml"),
            "content types precisa continuar sendo a primeira entrada"
        );

        // Partes não tocadas saem IDÊNTICAS.
        for intocada in ["[Content_Types].xml", "_rels/.rels", "word/styles.xml"] {
            assert_eq!(
                parte(&antes, intocada),
                parte(&depois, intocada),
                "parte {intocada} foi alterada sem necessidade"
            );
        }

        // O texto mudou e a formatação sobreviveu.
        let doc = parte(&depois, "word/document.xml");
        assert!(!doc.contains("Orchestrator"), "texto antigo ficou: {doc}");
        assert!(doc.contains("<w:b/>"), "negrito perdido: {doc}");
        assert!(doc.contains("<w:sectPr>"), "sectPr perdido: {doc}");
        assert_eq!(
            doc.matches("<w:t>").count(),
            2,
            "número de nós de texto mudou: {doc}"
        );
        let texto = crate::office::xml_text(&doc, &["w:p"]);
        assert!(texto.contains("Contrato com a ACME S.A."), "texto final: {texto}");

        let _ = std::fs::remove_dir_all(caminho.parent().unwrap());
    }

    /// Agulha ausente não pode reescrever o arquivo — byte a byte igual.
    #[test]
    fn sem_ocorrencia_o_arquivo_nao_e_tocado() {
        let caminho = escrever_temporario("intacto.docx", &docx_de_teste());
        let raiz = caminho.parent().unwrap().to_string_lossy().into_owned();
        let antes = std::fs::read(&caminho).expect("ler");

        let saida =
            office_replace_text(raiz, "intacto.docx".into(), "inexistente".into(), "x".into())
                .expect("não deveria falhar");
        assert_eq!(saida.replaced, 0);
        assert!(saida.parts.is_empty());
        assert_eq!(antes, std::fs::read(&caminho).expect("ler depois"), "arquivo foi reescrito à toa");

        let _ = std::fs::remove_dir_all(caminho.parent().unwrap());
    }

    #[test]
    fn nao_deixa_arquivo_temporario_para_tras() {
        let caminho = escrever_temporario("limpo.docx", &docx_de_teste());
        let dir = caminho.parent().unwrap().to_path_buf();
        let raiz = dir.to_string_lossy().into_owned();
        office_replace_text(raiz, "limpo.docx".into(), "Orchestrator".into(), "ACME".into())
            .expect("edição");
        let restos: Vec<_> = std::fs::read_dir(&dir)
            .expect("listar")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("aio-tmp"))
            .collect();
        assert!(restos.is_empty(), "sobrou temporário: {restos:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn xlsx_e_recusado_com_motivo_claro() {
        let caminho = escrever_temporario("planilha.xlsx", &docx_de_teste());
        let raiz = caminho.parent().unwrap().to_string_lossy().into_owned();
        let erro = office_replace_text(raiz, "planilha.xlsx".into(), "a".into(), "b".into())
            .unwrap_err();
        assert!(erro.contains("XLSX"), "erro inesperado: {erro}");
        let _ = std::fs::remove_dir_all(caminho.parent().unwrap());
    }

    /// Mesma checagem de escopo do fsx: não dá para editar fora da raiz.
    #[test]
    fn caminho_fora_da_raiz_e_recusado() {
        let caminho = escrever_temporario("dentro.docx", &docx_de_teste());
        let raiz = caminho.parent().unwrap().to_string_lossy().into_owned();
        let erro = office_replace_text(raiz, "../fora.docx".into(), "a".into(), "b".into())
            .unwrap_err();
        assert!(
            erro.contains("não encontrado") || erro.contains("fora da raiz"),
            "erro inesperado: {erro}"
        );
        let _ = std::fs::remove_dir_all(caminho.parent().unwrap());
    }

    #[test]
    fn agulha_vazia_e_recusada_antes_de_abrir_o_arquivo() {
        let caminho = escrever_temporario("x.docx", &docx_de_teste());
        let raiz = caminho.parent().unwrap().to_string_lossy().into_owned();
        assert!(office_replace_text(raiz, "x.docx".into(), "   ".into(), "b".into()).is_err());
        let _ = std::fs::remove_dir_all(caminho.parent().unwrap());
    }
}
