//! Leitura de DOCX/XLSX/PPTX — extrai o TEXTO real desses binários.
//!
//! OOXML é um ZIP de XML. Antes o app lia o arquivo como UTF-8 bruto e mostrava
//! lixo binário rotulado como "texto extraído". Aqui a extração é de verdade: a
//! IA passa a LER e comentar DOCX/XLSX/PPTX. Editar ao vivo continua dependendo
//! do motor externo (ver docs/adr-office-motor-wopi.md) — isto é só leitura.
//!
//! A extração de texto do XML é pura e testada; o comando só faz o IO (abrir o
//! zip e ler as entradas certas).

use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// Teto do texto extraído — evita que uma planilha gigante estoure a memória
/// e a conversa. O suficiente para a IA ter contexto.
const MAX_TEXT: usize = 400_000;

/// Maior fronteira de caractere até `limite` bytes.
///
/// `&s[..n]` em `String` faz **panic** quando `n` cai no meio de um caractere
/// multibyte — e um DOCX em português enche de acento, então o corte quase
/// sempre cai num deles. Um panic aqui derruba o comando inteiro e o usuário
/// vê "erro desconhecido" ao abrir um arquivo grande.
pub(crate) fn floor_char_boundary(texto: &str, limite: usize) -> usize {
    if limite >= texto.len() {
        return texto.len();
    }
    let mut corte = limite;
    while corte > 0 && !texto.is_char_boundary(corte) {
        corte -= 1;
    }
    corte
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeExtract {
    pub format: String,
    pub text: String,
    /// Quando o texto foi cortado no teto.
    pub truncated: bool,
}

/// Decodifica as cinco entidades XML e devolve o texto puro de um trecho de
/// XML, tratando cada tag de bloco como quebra de linha. Puro e testável.
pub fn xml_text(xml: &str, block_tags: &[&str]) -> String {
    let mut out = String::new();
    let mut inside_tag = false;
    let mut tag = String::new();
    for ch in xml.chars() {
        match ch {
            '<' => {
                inside_tag = true;
                tag.clear();
            }
            '>' => {
                inside_tag = false;
                // Tag de bloco (parágrafo, célula, linha, quebra) vira '\n'.
                let name = tag
                    .trim_start_matches('/')
                    .split([' ', '/'])
                    .next()
                    .unwrap_or("");
                if block_tags.contains(&name) && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            _ if inside_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // &amp; por último para não desfazer as trocas acima.
        .replace("&amp;", "&")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Colapsa 3+ quebras de linha em no máximo 2 — parágrafos vazios do OOXML.
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

type Archive = zip::ZipArchive<std::io::Cursor<Vec<u8>>>;

fn entry(archive: &mut Archive, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Entradas cujo nome casa um prefixo, em ordem — slides e planilhas são
/// numerados (slide1.xml, slide2.xml…).
fn sorted_entries(archive: &mut Archive, prefix: &str, suffix: &str) -> Vec<String> {
    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with(prefix) && n.ends_with(suffix))
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names.iter().filter_map(|n| entry(archive, n)).collect()
}

/// Ordena slide2 antes de slide10 (numérico, não lexical).
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn num(s: &str) -> u32 {
        s.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    }
    num(a).cmp(&num(b)).then_with(|| a.cmp(b))
}

fn extract_docx(archive: &mut Archive) -> String {
    let xml = entry(archive, "word/document.xml").unwrap_or_default();
    // w:p = parágrafo, w:br/w:tab = quebras.
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

fn extract_xlsx(archive: &mut Archive) -> String {
    // XLSX guarda strings numa tabela compartilhada; as células referenciam por
    // índice. Sem resolver a referência, extraímos a tabela + os valores
    // inline — suficiente para a IA ler o conteúdo textual da planilha.
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
        // t="inlineStr" e números aparecem em <v>; row/c dão a estrutura.
        let text = tidy(&xml_text(sheet, &["row"]));
        if !text.trim().is_empty() {
            out.push_str(&format!("Planilha {}:\n{}\n\n", index + 1, text));
        }
    }
    out.trim().to_string()
}

fn format_of(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".docx") {
        Some("docx")
    } else if lower.ends_with(".xlsx") {
        Some("xlsx")
    } else if lower.ends_with(".pptx") {
        Some("pptx")
    } else if lower.ends_with(".pdf") {
        // PDF não é OOXML: não é zip, e o texto sai do extrator próprio
        // (src/pdf.rs). Entra aqui porque, para quem usa, "abrir documento"
        // é a mesma ação.
        Some("pdf")
    } else {
        None
    }
}

/// Lê e extrai o texto de um DOCX/XLSX/PPTX.
///
/// Quando vem um `target`, o arquivo é lido NO SERVIDOR — é o que faz a aba
/// Office seguir o ambiente selecionado junto com as outras. Sem ele, lê da
/// raiz local, como antes.
#[tauri::command]
pub async fn office_extract(
    root: String,
    path: String,
    target: Option<crate::ssh::SshTarget>,
) -> Result<OfficeExtract, String> {
    let format = format_of(&path).ok_or("formato não suportado (só docx, xlsx, pptx, pdf)")?;

    let bytes = match target {
        Some(alvo) => crate::ssh::read_remote_bytes(&alvo, &path).await?,
        None => {
            // Mesma checagem de escopo do fsx: o caminho não pode escapar da raiz.
            let canonical_root = Path::new(&root)
                .canonicalize()
                .map_err(|_| "raiz do projeto inválida".to_string())?;
            let resolved = Path::new(&root)
                .join(&path)
                .canonicalize()
                .map_err(|_| "caminho não encontrado".to_string())?;
            if !resolved.starts_with(&canonical_root) {
                return Err("fora da raiz do projeto".into());
            }
            std::fs::read(&resolved).map_err(|error| error.to_string())?
        }
    };

    // PDF sai antes: não é zip, e abrir como zip daria "arquivo corrompido"
    // — um erro que mandaria o usuário procurar problema no arquivo dele.
    if format == "pdf" {
        let text = crate::pdf::extract_pdf_text(&bytes)?;
        let truncated = text.len() > MAX_TEXT;
        return Ok(OfficeExtract {
            format: "pdf".into(),
            text: if truncated {
                format!("{}\n\n[… texto truncado …]", &text[..floor_char_boundary(&text, MAX_TEXT)])
            } else {
                text
            },
            truncated,
        });
    }

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "arquivo não é um Office válido (zip corrompido)".to_string())?;

    let text = match format {
        "docx" => extract_docx(&mut archive),
        "xlsx" => extract_xlsx(&mut archive),
        _ => extract_pptx(&mut archive),
    };

    let truncated = text.len() > MAX_TEXT;
    let text = if truncated {
        format!("{}\n\n[… texto truncado …]", &text[..floor_char_boundary(&text, MAX_TEXT)])
    } else {
        text
    };

    Ok(OfficeExtract {
        format: format.to_string(),
        text,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrai_texto_e_decodifica_entidades() {
        let xml = r#"<w:p><w:r><w:t>Olá &amp; bem-vindo</w:t></w:r></w:p>"#;
        assert_eq!(xml_text(xml, &["w:p"]).trim(), "Olá & bem-vindo");
    }

    #[test]
    fn cada_paragrafo_vira_uma_linha() {
        let xml = "<w:p><w:t>linha um</w:t></w:p><w:p><w:t>linha dois</w:t></w:p>";
        let text = tidy(&xml_text(xml, &["w:p", "w:br"]));
        assert_eq!(text, "linha um\nlinha dois");
    }

    #[test]
    fn entidade_amp_nao_e_desfeita_em_cascata() {
        // &amp;lt; deve virar &lt; (e não <), senão perde dado.
        let xml = "<w:t>a &amp;lt; b</w:t>";
        assert_eq!(xml_text(xml, &["w:p"]).trim(), "a &lt; b");
    }

    #[test]
    fn ordem_natural_slide2_antes_de_slide10() {
        assert_eq!(
            natural_cmp("slide2.xml", "slide10.xml"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn tidy_colapsa_linhas_vazias() {
        assert_eq!(tidy("a\n\n\n\nb"), "a\n\nb");
    }

    #[test]
    fn formato_reconhecido_por_extensao() {
        assert_eq!(format_of("relatorio.DOCX"), Some("docx"));
        assert_eq!(format_of("planilha.xlsx"), Some("xlsx"));
        assert_eq!(format_of("slides.pptx"), Some("pptx"));
        assert_eq!(format_of("nota.txt"), None);
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Monta um OOXML de verdade em memória (o crate zip escreve e lê) e
    /// confirma o caminho completo: descompactar → extrair texto.
    fn zip_with(entries: &[(&str, &str)]) -> Archive {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, body) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        zip::ZipArchive::new(cursor).unwrap()
    }

    #[test]
    fn docx_real_vira_texto_por_paragrafo() {
        let mut zip = zip_with(&[(
            "word/document.xml",
            "<w:document><w:body><w:p><w:r><w:t>Relatório trimestral</w:t></w:r></w:p><w:p><w:r><w:t>Receita cresceu 12% &amp; superou a meta.</w:t></w:r></w:p></w:body></w:document>",
        )]);
        let text = extract_docx(&mut zip);
        assert_eq!(
            text,
            "Relatório trimestral\nReceita cresceu 12% & superou a meta."
        );
    }

    #[test]
    fn pptx_real_numera_os_slides_em_ordem() {
        let mut zip = zip_with(&[
            (
                "ppt/slides/slide1.xml",
                "<p:sld><a:p><a:t>Abertura</a:t></a:p></p:sld>",
            ),
            (
                "ppt/slides/slide2.xml",
                "<p:sld><a:p><a:t>Resultados</a:t></a:p></p:sld>",
            ),
        ]);
        let text = extract_pptx(&mut zip);
        assert!(text.contains("--- Slide 1 ---"));
        assert!(text.contains("Abertura"));
        assert!(text.contains("--- Slide 2 ---"));
        assert!(text.contains("Resultados"));
        assert!(text.find("Abertura").unwrap() < text.find("Resultados").unwrap());
    }

    #[test]
    fn xlsx_real_traz_os_textos_da_planilha() {
        let mut zip = zip_with(&[
            (
                "xl/sharedStrings.xml",
                "<sst><si><t>Produto</t></si><si><t>Preço</t></si></sst>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row><c><v>0</v></c></row></sheetData></worksheet>",
            ),
        ]);
        let text = extract_xlsx(&mut zip);
        assert!(text.contains("Produto"));
        assert!(text.contains("Preço"));
    }
}
