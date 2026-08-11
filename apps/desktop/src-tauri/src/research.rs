use serde::Serialize;
use tokio::time::Duration;

const MAX_BODY_BYTES: usize = 1_500_000;
const MAX_LINKS: usize = 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    title: String,
    text: String,
    links: Vec<String>,
}

/// Remove blocos `<tag …>…</tag …>` (comparação ASCII case-insensitive).
/// `to_ascii_lowercase` preserva os índices de byte do original, então os
/// offsets encontrados na cópia minúscula são válidos para fatiar o original.
fn strip_blocks(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut result = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(found) = lower[cursor..].find(&open) {
        let start = cursor + found;
        result.push_str(&html[cursor..start]);
        let Some(offset) = lower[start..].find(&close) else {
            cursor = html.len();
            break;
        };
        let close_start = start + offset;
        match lower[close_start..].find('>') {
            Some(end) => cursor = close_start + end + 1,
            None => {
                cursor = html.len();
                break;
            }
        }
    }
    result.push_str(&html[cursor..]);
    result
}

fn strip_tags(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    text
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(open) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[open..].find('>') else {
        return String::new();
    };
    let content_start = open + gt + 1;
    let Some(close) = lower[content_start..].find("</title") else {
        return String::new();
    };
    collapse(&html[content_start..content_start + close])
}

fn extract_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut links: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = lower[cursor..].find("href=\"") {
        let start = cursor + found + 6;
        let Some(end) = html[start..].find('"') else {
            break;
        };
        let value = &html[start..start + end];
        if value.starts_with("http://") || value.starts_with("https://") {
            let owned = value.to_owned();
            if !links.contains(&owned) {
                links.push(owned);
            }
            if links.len() >= MAX_LINKS {
                break;
            }
        }
        cursor = start + end + 1;
    }
    links
}

#[tauri::command]
pub async fn research_fetch(url: String) -> Result<FetchedPage, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL inválida".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("apenas URLs http(s) são aceitas".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(parsed)
        .header("User-Agent", "AI Orchestrator Research/1.0")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let mut body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    body.truncate(MAX_BODY_BYTES);
    let html = String::from_utf8_lossy(&body).into_owned();
    let title = extract_title(&html);
    let links = extract_links(&html);
    let without_blocks = strip_blocks(&strip_blocks(&html, "script"), "style");
    let text = collapse(&strip_tags(&without_blocks));
    Ok(FetchedPage { title, text, links })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_and_style_blocks() {
        let html = "<p>oi</p><script>var x = 1;</script><style>.a{}</style><p>fim</p>";
        let cleaned = strip_blocks(&strip_blocks(html, "script"), "style");
        let text = collapse(&strip_tags(&cleaned));
        assert_eq!(text, "oi fim");
    }

    #[test]
    fn extracts_title_and_absolute_links() {
        let html = "<html><head><title> Página  Demo </title></head>\
                    <body><a href=\"https://a.dev/x\">a</a><a href=\"/relativo\">b</a></body></html>";
        assert_eq!(extract_title(html), "Página Demo");
        assert_eq!(extract_links(html), vec!["https://a.dev/x".to_string()]);
    }
}
