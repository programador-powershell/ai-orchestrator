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

/// Recusa hosts que não são internet pública: loopback, rede privada,
/// link-local (inclui o 169.254.169.254 de metadados de nuvem) e nomes internos.
///
/// Não é `#[tauri::command]`: recebe `&reqwest::Url`, que não é serializável —
/// o atributo que existia aqui era inerte (nunca esteve em `generate_handler!`)
/// e só enganava quem lesse o arquivo. É um guard interno, usado por qualquer
/// comando que faça requisição com URL de fora.
pub(crate) fn guard_public_host(url: &reqwest::Url) -> Result<(), String> {
    use std::net::{IpAddr, ToSocketAddrs};
    let host = url.host_str().ok_or_else(|| "URL sem host".to_string())?;
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" || lowered.ends_with(".local") || lowered.ends_with(".internal") {
        return Err("host interno não é permitido".into());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    // Resolve o nome: só assim um domínio apontando para IP interno é barrado.
    let resolved: Vec<IpAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "não foi possível resolver o host".to_string())?
        .map(|addr| addr.ip())
        .collect();
    if resolved.is_empty() {
        return Err("host não resolvido".into());
    }
    for ip in resolved {
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    || v4.octets()[0] == 0
                    // 100.64.0.0/10 (CGNAT) e 169.254.0.0/16 (metadados)
                    || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
            }
            IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unspecified() || v6.segments()[0] & 0xfe00 == 0xfc00
            }
        };
        if blocked {
            return Err(format!("host {ip} pertence à rede interna — bloqueado"));
        }
    }
    Ok(())
}

/// Política de redirect que reaplica `guard_public_host` a CADA salto.
pub(crate) fn guarded_redirect() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("redirecionamentos demais");
        }
        if let Err(motivo) = crate::blocklist::guard_blocklist(attempt.url()) {
            return attempt.error(motivo);
        }
        match guard_public_host(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(motivo) => attempt.error(motivo),
        }
    })
}

#[tauri::command]
pub async fn research_fetch(url: String) -> Result<FetchedPage, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL inválida".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("apenas URLs http(s) são aceitas".into());
    }
    // SSRF: a URL vem do MODELO. Sem esta guarda, uma resposta poderia fazer o
    // app buscar serviços internos (metadados de nuvem, admin em localhost).
    guard_public_host(&parsed)?;
    // Blocklist do admin: vale para pesquisa também, não só para conexão.
    crate::blocklist::guard_blocklist(&parsed)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // A guarda acima vale só para a PRIMEIRA URL. Com a política padrão do
        // reqwest (até 10 saltos), um 302 para 169.254.169.254 furava tudo.
        // Aqui cada salto é reavaliado — redirect legítimo continua funcionando.
        .redirect(guarded_redirect())
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


/// Busca o HTML **bruto** de uma página, para o clone do Design reconstruir o
/// layout de verdade.
///
/// Por que não dá para reusar `research_fetch`: ele devolve o texto já sem
/// tags — serve para a IA ler, não para renderizar. E por que não dá para o
/// webview buscar sozinho: a resposta de outra origem é bloqueada pelo CORS na
/// leitura, então o HTML nunca chegaria ao JS.
///
/// Passa exatamente pelas mesmas guardas do research_fetch: rede pública
/// (anti-SSRF), blocklist do admin e reavaliação a cada redirect.
#[tauri::command]
pub async fn page_fetch(url: String) -> Result<FetchedPage, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL inválida".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("apenas URLs http(s) são aceitas".into());
    }
    guard_public_host(&parsed)?;
    crate::blocklist::guard_blocklist(&parsed)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(guarded_redirect())
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(parsed.clone())
        .header("User-Agent", "AI Orchestrator Design/1.0")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;

    // A URL FINAL importa: se houve redirect, os caminhos relativos do HTML
    // são relativos a ela, não à que o usuário digitou.
    let final_url = response.url().to_string();
    let mut body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    body.truncate(MAX_BODY_BYTES);
    let html = String::from_utf8_lossy(&body).into_owned();

    Ok(FetchedPage {
        title: extract_title(&html),
        // Aqui `text` carrega o HTML BRUTO — é o ponto do comando.
        text: html,
        links: vec![final_url],
    })
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

#[cfg(test)]
mod guard_tests {
    use super::*;

    fn guard(raw: &str) -> Result<(), String> {
        guard_public_host(&reqwest::Url::parse(raw).expect("url"))
    }

    #[test]
    fn bloqueia_loopback_e_nomes_internos() {
        for alvo in [
            "http://localhost/admin",
            "http://127.0.0.1:8080/",
            "https://algo.local/",
            "https://painel.internal/",
        ] {
            assert!(guard(alvo).is_err(), "deveria bloquear {alvo}");
        }
    }

    #[test]
    fn bloqueia_redes_privadas_e_metadados_de_nuvem() {
        for alvo in [
            "http://10.1.2.3/",
            "http://192.168.0.1/",
            "http://172.16.5.4/",
            // o clássico de SSRF em nuvem
            "http://169.254.169.254/latest/meta-data/",
            "http://0.0.0.0/",
            "http://100.64.0.1/",
        ] {
            assert!(guard(alvo).is_err(), "deveria bloquear {alvo}");
        }
    }

    #[test]
    fn bloqueia_ipv6_interno() {
        for alvo in ["http://[::1]/", "http://[fc00::1]/", "http://[::]/"] {
            assert!(guard(alvo).is_err(), "deveria bloquear {alvo}");
        }
    }

    #[test]
    fn url_sem_host_e_recusada() {
        assert!(guard("file:///c:/windows/system32/config/sam").is_err());
    }
}
