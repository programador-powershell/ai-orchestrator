//! Domínios bloqueados pelo admin — pesquisa e conexões de saída.
//!
//! Fecha a lacuna que o modelo de risco do computer use deixou explícita: a
//! rede estava aberta. Aqui o admin define, na política do grupo, os domínios
//! que o app não pode alcançar — nem para pesquisar, nem para chamar webhook,
//! nem para falar com servidor MCP.
//!
//! ## Por que a lista vem da política ASSINADA, e não das configurações locais
//!
//! Uma lista guardada no `localStorage` seria editável por quem usa o app —
//! bloqueio cosmético, o mesmo furo do gating antigo. A lista chega no
//! bootstrap, é verificada em Ed25519 e fica no cache em disco que o Rust lê.
//! O webview nunca é a autoridade.
//!
//! ## A armadilha que este módulo existe para evitar
//!
//! `host.ends_with("exemplo.com")` casa `malexemplo.com` — um domínio que não
//! tem nada a ver e que um atacante registra de graça. O casamento tem de
//! respeitar a fronteira do rótulo: ou é o domínio exato, ou termina em
//! `.exemplo.com`.

use serde_json::Value;

/// Normaliza um host para comparação: minúsculas, sem ponto final, sem porta.
fn normalize(host: &str) -> String {
    let clean = host.trim().trim_end_matches('.').to_ascii_lowercase();
    // Um host com porta ("exemplo.com:8080") só aparece se vier de entrada
    // solta do admin; a URL parseada já separa.
    match clean.split_once(':') {
        Some((antes, _)) if !clean.starts_with('[') => antes.to_string(),
        _ => clean,
    }
}

/// A regra bate no host?
///
/// - `exemplo.com` bloqueia `exemplo.com` e qualquer subdomínio;
/// - `*.exemplo.com` bloqueia SÓ os subdomínios (o apex fica liberado);
/// - `malexemplo.com` NÃO é bloqueado por `exemplo.com` — fronteira de rótulo.
pub fn matches(rule: &str, host: &str) -> bool {
    let host = normalize(host);
    let rule = normalize(rule);
    if rule.is_empty() || host.is_empty() {
        return false;
    }
    if let Some(base) = rule.strip_prefix("*.") {
        return host.ends_with(&format!(".{base}"));
    }
    host == rule || host.ends_with(&format!(".{rule}"))
}

/// Primeiro domínio da lista que bloqueia o host, se algum.
pub fn blocked_by(rules: &[String], host: &str) -> Option<String> {
    rules
        .iter()
        .find(|rule| matches(rule, host))
        .map(|rule| rule.trim().to_ascii_lowercase())
}

/// Lê a lista da política em cache (assinada). Erro de leitura devolve lista
/// vazia: bloquear tudo por falha de cache travaria o app inteiro, e a
/// ausência de política já é tratada pelo gating de módulos.
pub fn blocked_domains() -> Vec<String> {
    let Ok(Some(body)) = crate::policy::bootstrap_cached() else {
        return Vec::new();
    };
    from_policy(&body)
}

/// Extrai `policy.blockedDomains` do corpo do bootstrap. Separado para teste.
pub fn from_policy(body: &Value) -> Vec<String> {
    body.get("policy")
        .and_then(|policy| policy.get("blockedDomains"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|entry| entry.trim().to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Recusa a URL se o host estiver bloqueado. Mensagem nomeia a regra — quem
/// apanhar precisa saber o que pedir ao admin.
pub fn guard_blocklist(url: &reqwest::Url) -> Result<(), String> {
    let Some(host) = url.host_str() else {
        return Ok(()); // sem host, o guard de rede pública já recusa
    };
    match blocked_by(&blocked_domains(), host) {
        Some(rule) => Err(format!(
            "domínio bloqueado pela política da empresa (regra: {rule})"
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bloqueia_o_dominio_exato_e_os_subdominios() {
        assert!(matches("exemplo.com", "exemplo.com"));
        assert!(matches("exemplo.com", "www.exemplo.com"));
        assert!(matches("exemplo.com", "a.b.exemplo.com"));
    }

    /// A armadilha: `ends_with` casaria, e um atacante registra o domínio.
    #[test]
    fn nao_bloqueia_dominio_que_apenas_TERMINA_igual() {
        assert!(!matches("exemplo.com", "malexemplo.com"));
        assert!(!matches("exemplo.com", "naoexemplo.com"));
        assert!(!matches("openai.com", "notopenai.com"));
    }

    #[test]
    fn curinga_pega_so_os_subdominios() {
        assert!(matches("*.exemplo.com", "api.exemplo.com"));
        assert!(!matches("*.exemplo.com", "exemplo.com"));
        assert!(!matches("*.exemplo.com", "malexemplo.com"));
    }

    #[test]
    fn comparacao_ignora_caixa_ponto_final_e_porta() {
        assert!(matches("Exemplo.COM", "WWW.exemplo.com."));
        assert!(matches("exemplo.com:8080", "api.exemplo.com"));
    }

    #[test]
    fn regra_ou_host_vazio_nao_bloqueia_nada() {
        assert!(!matches("", "exemplo.com"));
        assert!(!matches("exemplo.com", ""));
        assert!(!matches("   ", "exemplo.com"));
    }

    #[test]
    fn blocked_by_devolve_a_regra_que_pegou() {
        let regras = vec!["facebook.com".into(), "*.tiktok.com".into()];
        assert_eq!(blocked_by(&regras, "www.facebook.com").as_deref(), Some("facebook.com"));
        assert_eq!(blocked_by(&regras, "cdn.tiktok.com").as_deref(), Some("*.tiktok.com"));
        assert!(blocked_by(&regras, "empresa.com.br").is_none());
    }

    #[test]
    fn lista_vazia_nao_bloqueia() {
        assert!(blocked_by(&[], "qualquer.com").is_none());
    }

    #[test]
    fn le_a_lista_do_corpo_do_bootstrap() {
        let body = json!({"policy": {"blockedDomains": ["Facebook.com", "  ", "*.tiktok.com"]}});
        assert_eq!(from_policy(&body), vec!["facebook.com", "*.tiktok.com"]);
    }

    #[test]
    fn politica_sem_a_lista_devolve_vazio_em_vez_de_estourar() {
        assert!(from_policy(&json!({})).is_empty());
        assert!(from_policy(&json!({"policy": {}})).is_empty());
        assert!(from_policy(&json!({"policy": {"blockedDomains": "não é lista"}})).is_empty());
    }

    /// IPv6 tem `:` no host e não pode ser cortado como porta.
    #[test]
    fn ipv6_nao_e_confundido_com_porta() {
        assert_eq!(normalize("[::1]"), "[::1]");
    }
}
