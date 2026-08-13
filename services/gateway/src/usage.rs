//! Contagem de tokens das respostas dos provedores — a base da relatoria.
//!
//! As colunas `input_tokens`/`output_tokens` existem em `usage_events` desde a
//! migration inicial e **nunca foram escritas**: o gateway registrava modo,
//! modelo e latência, e jogava fora o bloco `usage` que o provedor devolve.
//! Sem token não há custo, então não havia base para relatório de gasto
//! nenhum — nem por usuário, nem por grupo, nem por modelo.
//!
//! Este módulo é puro: recebe JSON (ou pedaços de um stream SSE) e devolve a
//! contagem. Quem grava é o `routes.rs`. Sem I/O aqui, para dar para testar
//! com as formas reais de cada provedor.
//!
//! Os três formatos são diferentes de propósito pelos fornecedores:
//! - OpenAI e compatíveis: `usage.prompt_tokens` / `usage.completion_tokens`
//! - Anthropic: `usage.input_tokens` / `usage.output_tokens`, mais os campos
//!   de cache, que mudam MUITO o custo real
//! - Gemini: `usageMetadata.promptTokenCount` / `candidatesTokenCount`

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: i32,
    pub output: i32,
    /// Leitura de cache — cobrada a uma fração do preço de entrada.
    pub cache_read: i32,
    /// Escrita/criação de cache — costuma custar MAIS que a entrada normal.
    pub cache_write: i32,
}

impl TokenUsage {
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_write == 0
    }
}

/// Lê um inteiro não negativo, tolerando número em ponto flutuante.
fn int_at(value: &Value, path: &[&str]) -> i32 {
    let mut cursor = value;
    for key in path {
        match cursor.get(key) {
            Some(next) => cursor = next,
            None => return 0,
        }
    }
    cursor
        .as_i64()
        .or_else(|| cursor.as_f64().map(|v| v as i64))
        .unwrap_or(0)
        .max(0) as i32
}

/// OpenAI e compatíveis (Moonshot, DeepSeek, Mistral, custom).
pub fn from_openai(value: &Value) -> TokenUsage {
    TokenUsage {
        input: int_at(value, &["usage", "prompt_tokens"]),
        output: int_at(value, &["usage", "completion_tokens"]),
        // Presente nos modelos com cache de prompt; ausente vira 0.
        cache_read: int_at(value, &["usage", "prompt_tokens_details", "cached_tokens"]),
        cache_write: 0,
    }
}

/// Anthropic — os campos de cache são separados e pesam no custo.
pub fn from_anthropic(value: &Value) -> TokenUsage {
    TokenUsage {
        input: int_at(value, &["usage", "input_tokens"]),
        output: int_at(value, &["usage", "output_tokens"]),
        cache_read: int_at(value, &["usage", "cache_read_input_tokens"]),
        cache_write: int_at(value, &["usage", "cache_creation_input_tokens"]),
    }
}

/// Gemini — vem em `usageMetadata`, com nomes próprios.
pub fn from_gemini(value: &Value) -> TokenUsage {
    TokenUsage {
        input: int_at(value, &["usageMetadata", "promptTokenCount"]),
        output: int_at(value, &["usageMetadata", "candidatesTokenCount"]),
        cache_read: int_at(value, &["usageMetadata", "cachedContentTokenCount"]),
        cache_write: 0,
    }
}

/// Escolhe o parser pelo `kind` do provedor cadastrado.
pub fn from_provider(kind: &str, value: &Value) -> TokenUsage {
    match kind {
        "anthropic" => from_anthropic(value),
        "gemini" | "google" => from_gemini(value),
        _ => from_openai(value),
    }
}

/* --------------------------- Stream SSE ------------------------------ */

/// Extrai a contagem de um stream SSE SEM interromper o repasse ao cliente.
///
/// O caminho OpenAI faz passthrough dos bytes — o gateway nunca desserializa a
/// resposta. Como o chat real é streaming, capturar só o não-streaming daria
/// uma relatoria quase vazia, que é pior que nenhuma: pareceria que o consumo
/// é baixo. Então os pedaços são inspecionados de passagem.
///
/// Cuidado que motiva o buffer: um chunk de rede pode cortar uma linha `data:`
/// no meio. O resto fica guardado para juntar com o próximo pedaço.
/// Teto do buffer do corpo não-SSE. Resposta JSON de chat não passa disso, e
/// sem limite um corpo gigante viraria memória do gateway.
const MAX_PLAIN_BODY: usize = 256 * 1024;

#[derive(Default)]
pub struct SseUsageScanner {
    partial: String,
    /// Corpo acumulado quando a resposta NÃO é SSE (JSON de uma vez só).
    plain: String,
    plain_overflow: bool,
    saw_sse: bool,
    usage: TokenUsage,
}

impl SseUsageScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Alimenta um pedaço bruto do corpo. Nunca falha: dado ilegível é
    /// ignorado, porque perder contagem não pode derrubar a resposta.
    pub fn push(&mut self, chunk: &[u8], kind: &str) {
        let text = String::from_utf8_lossy(chunk);
        // O caminho OpenAI faz passthrough tanto de SSE quanto de JSON puro,
        // e o gateway não sabe de antemão qual é. Acumula os dois e decide no
        // fim: sem isso, o não-streaming ficaria sem contagem.
        if !self.plain_overflow {
            if self.plain.len() + text.len() > MAX_PLAIN_BODY {
                self.plain_overflow = true;
                self.plain.clear();
            } else {
                self.plain.push_str(&text);
            }
        }

        self.partial.push_str(&text);
        // Processa apenas linhas COMPLETAS; a última fica para o próximo chunk.
        let Some(cut) = self.partial.rfind('\n') else {
            return;
        };
        let complete: String = self.partial.drain(..=cut).collect();
        for line in complete.lines() {
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            self.saw_sse = true;
            let payload = payload.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            let found = from_provider(kind, &value);
            if !found.is_empty() {
                // O último bloco com usage é o total acumulado da resposta.
                self.usage = found;
            }
        }
    }

    /// Contagem final. Se nada veio por SSE, tenta o corpo inteiro como JSON.
    pub fn finish(&self, kind: &str) -> TokenUsage {
        if !self.usage.is_empty() {
            return self.usage;
        }
        if self.saw_sse || self.plain_overflow {
            return self.usage;
        }
        serde_json::from_str::<Value>(self.plain.trim())
            .map(|value| from_provider(kind, &value))
            .unwrap_or_default()
    }
}

/* ------------------------------ Custo -------------------------------- */

/// Preço por MILHÃO de tokens, definido pelo ADMIN (nunca embutido no
/// binário): tabela de preço muda, e chutar valor viraria relatório errado
/// com cara de certo.
#[derive(Debug, Clone, Copy, Default)]
pub struct ModelPrice {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
}

/// Custo em dólares. Modelo sem preço cadastrado devolve `None` — a UI mostra
/// "sem preço" em vez de zero, que seria lido como "não custou nada".
pub fn cost_usd(usage: &TokenUsage, price: Option<&ModelPrice>) -> Option<f64> {
    let price = price?;
    let million = 1_000_000.0;
    Some(
        (usage.input as f64 * price.input_per_mtok
            + usage.output as f64 * price.output_per_mtok
            + usage.cache_read as f64 * price.cache_read_per_mtok
            + usage.cache_write as f64 * price.cache_write_per_mtok)
            / million,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_le_prompt_e_completion() {
        let value = json!({"usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165}});
        assert_eq!(
            from_openai(&value),
            TokenUsage { input: 120, output: 45, cache_read: 0, cache_write: 0 }
        );
    }

    #[test]
    fn openai_le_cache_quando_existe() {
        let value = json!({"usage":{"prompt_tokens":120,"completion_tokens":45,
            "prompt_tokens_details":{"cached_tokens":100}}});
        assert_eq!(from_openai(&value).cache_read, 100);
    }

    #[test]
    fn anthropic_le_os_quatro_campos() {
        let value = json!({"usage":{"input_tokens":10,"output_tokens":20,
            "cache_read_input_tokens":900,"cache_creation_input_tokens":300}});
        assert_eq!(
            from_anthropic(&value),
            TokenUsage { input: 10, output: 20, cache_read: 900, cache_write: 300 }
        );
    }

    #[test]
    fn gemini_le_usage_metadata() {
        let value = json!({"usageMetadata":{"promptTokenCount":77,"candidatesTokenCount":13}});
        assert_eq!(from_gemini(&value).input, 77);
        assert_eq!(from_gemini(&value).output, 13);
    }

    #[test]
    fn resposta_sem_usage_nao_inventa_numero() {
        let value = json!({"choices":[{"message":{"content":"oi"}}]});
        assert!(from_openai(&value).is_empty());
        assert!(from_anthropic(&value).is_empty());
        assert!(from_gemini(&value).is_empty());
    }

    #[test]
    fn valor_negativo_ou_estranho_nao_vira_token_negativo() {
        let value = json!({"usage":{"prompt_tokens":-5,"completion_tokens":"muitos"}});
        let usage = from_openai(&value);
        assert_eq!(usage.input, 0);
        assert_eq!(usage.output, 0);
    }

    #[test]
    fn from_provider_escolhe_pelo_kind() {
        let anthropic = json!({"usage":{"input_tokens":5,"output_tokens":6}});
        assert_eq!(from_provider("anthropic", &anthropic).input, 5);
        // o mesmo JSON lido como OpenAI não acha nada — prova que não é acaso
        assert!(from_provider("openai", &anthropic).is_empty());
    }

    /* ----------------------------- SSE ------------------------------- */

    #[test]
    fn sse_captura_o_usage_do_ultimo_chunk() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"oi\"}}]}\n\n", "openai");
        scanner.push(
            b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":300,\"completion_tokens\":50}}\n\n",
            "openai",
        );
        scanner.push(b"data: [DONE]\n\n", "openai");
        let usage = scanner.finish("openai");
        assert_eq!(usage.input, 300);
        assert_eq!(usage.output, 50);
    }

    /// O caso que motiva o buffer: a rede corta a linha no meio.
    #[test]
    fn sse_junta_linha_partida_entre_dois_chunks() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(b"data: {\"usage\":{\"prompt_to", "openai");
        scanner.push(b"kens\":42,\"completion_tokens\":7}}\n\n", "openai");
        assert_eq!(scanner.finish("openai").input, 42);
    }

    #[test]
    fn sse_ignora_lixo_sem_derrubar_a_contagem() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(b": comentario de keep-alive\n", "openai");
        scanner.push(b"data: nao-e-json\n", "openai");
        scanner.push(b"event: ping\n", "openai");
        scanner.push(b"data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1}}\n", "openai");
        assert_eq!(scanner.finish("openai").input, 9);
    }

    #[test]
    fn sse_sem_usage_devolve_vazio_em_vez_de_zero_falso() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"oi\"}}]}\n\n", "openai");
        assert!(scanner.finish("openai").is_empty());
    }

    #[test]
    fn sse_anthropic_message_delta_traz_output() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(
            b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":128}}\n\n",
            "anthropic",
        );
        assert_eq!(scanner.finish("anthropic").output, 128);
    }

    /* ----------------------------- Custo ----------------------------- */

    #[test]
    fn custo_usa_preco_por_milhao() {
        let usage = TokenUsage { input: 1_000_000, output: 500_000, cache_read: 0, cache_write: 0 };
        let price = ModelPrice { input_per_mtok: 3.0, output_per_mtok: 15.0, ..Default::default() };
        let custo = cost_usd(&usage, Some(&price)).expect("preço existe");
        assert!((custo - 10.5).abs() < 1e-9, "custo calculado: {custo}");
    }

    #[test]
    fn custo_considera_cache_separadamente() {
        let usage = TokenUsage { input: 0, output: 0, cache_read: 1_000_000, cache_write: 1_000_000 };
        let price = ModelPrice {
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            cache_read_per_mtok: 0.3,
            cache_write_per_mtok: 3.75,
        };
        let custo = cost_usd(&usage, Some(&price)).unwrap();
        assert!((custo - 4.05).abs() < 1e-9, "custo calculado: {custo}");
    }

    /// Modelo sem preço NÃO pode virar 0.00 no relatório.
    #[test]
    fn sem_preco_cadastrado_devolve_none_e_nao_zero() {
        let usage = TokenUsage { input: 500, output: 500, cache_read: 0, cache_write: 0 };
        assert!(cost_usd(&usage, None).is_none());
    }
}

#[cfg(test)]
mod tests_plain {
    use super::*;

    /// O caminho OpenAI faz passthrough também do NÃO-streaming: o corpo é um
    /// JSON único, sem `data:`. Sem este caso a contagem só existiria em
    /// streaming.
    #[test]
    fn corpo_json_unico_tambem_conta() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(
            br#"{"choices":[{"message":{"content":"oi"}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}"#,
            "openai",
        );
        let usage = scanner.finish("openai");
        assert_eq!(usage.input, 11);
        assert_eq!(usage.output, 3);
    }

    #[test]
    fn json_partido_em_varios_chunks_ainda_conta() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(br#"{"usage":{"prompt_to"#, "openai");
        scanner.push(br#"kens":8,"completion_tokens":2}}"#, "openai");
        assert_eq!(scanner.finish("openai").input, 8);
    }

    /// SSE tem prioridade: corpo com `data:` não é reinterpretado como JSON.
    #[test]
    fn sse_sem_usage_nao_cai_no_parser_de_json() {
        let mut scanner = SseUsageScanner::new();
        scanner.push(b"data: {\"choices\":[]}\n\n", "openai");
        assert!(scanner.finish("openai").is_empty());
    }

    #[test]
    fn corpo_gigante_nao_e_bufferizado() {
        let mut scanner = SseUsageScanner::new();
        let gordo = vec![b'x'; MAX_PLAIN_BODY + 10];
        scanner.push(&gordo, "openai");
        // não estoura memória nem inventa contagem
        assert!(scanner.finish("openai").is_empty());
    }
}
