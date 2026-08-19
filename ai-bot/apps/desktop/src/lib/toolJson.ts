/**
 * Leitura do bloco JSON estruturado dos tool.results que alimentam tela.
 *
 * Duas formas convivem de propósito:
 *  - saída que É JSON puro (o padrão da Onda 1 — schema.export nasceu para a
 *    tela e não tinha texto a preservar);
 *  - texto legível com o bloco DEMARCADO numa cerca ```json no fim
 *    (flow.validate, secrets.scan, osv.query, finetune.status) — o relatório
 *    continua no transcript para o modelo e para a pessoa, e a tela lê só o
 *    bloco.
 *
 * A cerca procurada é a ÚLTIMA do resultado porque é o gateway quem a escreve,
 * sempre por último — um exemplo de fluxo com ```json no meio do texto legível
 * não engana a tela. Qualquer falha devolve null: resultado picotado pelo
 * teto de inlineLimitFor (tool_gateway.go) volta a tela ao estado vazio, que é
 * o comportamento conhecido do schema.export no mesmo caso.
 */
export function structuredJson(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Não era JSON puro; pode ainda haver um bloco demarcado adiante.
    }
  }

  const fence = trimmed.lastIndexOf("```json");
  if (fence < 0) return null;
  const start = trimmed.indexOf("\n", fence);
  if (start < 0) return null;
  const end = trimmed.indexOf("\n```", start);
  const body = trimmed.slice(start + 1, end < 0 ? undefined : end).trim();
  if (body === "") return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
