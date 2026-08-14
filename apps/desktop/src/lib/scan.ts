/**
 * Núcleo puro da aba Security — heurísticas locais de segredos, parse/aplicação
 * de diff unificado e o contrato da revisão multi-modelo (prompt → ```json com
 * SecurityFinding[]). Sem DOM e sem Tauri: 100% testável em vitest.
 *
 * Política: valores de segredos NUNCA aparecem em findings — são mascarados.
 */
import type { SecurityFinding } from "@multiplike/contracts";
import type { ChatMessage } from "./gateway";

type Severity = SecurityFinding["severity"];

interface SecretRule {
  id: string;
  severity: Severity;
  title: string;
  pattern: RegExp;
  suggestion: string;
  /** Quando true, gera patch trocando o literal por um placeholder de cofre. */
  fixable?: boolean;
}

const VAULT_HINT =
  "mova para o cofre — Vaultwarden (https://vault.multiplikelabs.com/) ou AWS Secrets Manager (DEV)";

const SECRET_RULES: SecretRule[] = [
  {
    id: "aws-akia",
    severity: "critical",
    title: "Chave de acesso AWS exposta",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    suggestion: `Revogue a chave imediatamente e ${VAULT_HINT}.`
  },
  {
    id: "pem-key",
    severity: "critical",
    title: "Chave privada PEM no código",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    suggestion: `Remova o arquivo do repositório, rotacione a chave e ${VAULT_HINT}.`
  },
  {
    id: "github-token",
    severity: "critical",
    title: "Token do GitHub exposto",
    pattern: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    suggestion: `Revogue o token em github.com/settings/tokens e ${VAULT_HINT}.`
  },
  {
    id: "conn-string",
    severity: "high",
    title: "Connection string com senha embutida",
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s/:@]+:[^\s@/]+@/i,
    suggestion: `Troque a senha do banco e ${VAULT_HINT}.`
  },
  {
    id: "bearer",
    severity: "high",
    title: "Credencial Bearer embutida",
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/=]{20,}/,
    suggestion: `Injete a credencial em runtime e ${VAULT_HINT}.`
  },
  {
    id: "literal-secret",
    severity: "high",
    title: "Segredo atribuído em literal",
    pattern: /\b(?:password|passwd|pwd|senha|api[_-]?key|apikey|secret|token)\s*[:=]\s*(["'])([^"']{4,})\1/i,
    suggestion: `Troque o literal por leitura de ambiente/cofre — ${VAULT_HINT}.`,
    fixable: true
  },
  {
    id: "jwt",
    severity: "medium",
    title: "Token JWT embutido",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
    suggestion: `Gere tokens em runtime, nunca os versione — ${VAULT_HINT}.`
  }
];

/** Mascara um valor sensível: só os 4 primeiros caracteres + tamanho. */
function mask(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} caracteres)`;
}

/** Valores que são placeholders (não segredos): "${…}", "{{…}}", "%…%", "<…>". */
const PLACEHOLDER_VALUE = /^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]+%|<[^>]+>)$/;

/**
 * Patch em diff unificado que troca o literal por um placeholder de cofre.
 * Substitui o literal DENTRO do trecho casado pela regra (a partir de
 * matchStart) — nunca a primeira string da linha, que pode ser outro valor.
 */
function buildVaultPatch(line: number, lineText: string, matchStart: number): string {
  const head = lineText.slice(0, matchStart);
  const tail = lineText.slice(matchStart).replace(/(["'])[^"']*\1/, '"${SECRET_FROM_VAULT}"');
  return `@@ -${line},1 +${line},1 @@\n-${lineText}\n+${head}${tail}`;
}

/** Heurísticas puras de segredos. Uma passada por linha, valores mascarados. */
export function scanTextForSecrets(path: string, text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    const line = index + 1;
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(lineText);
      if (!match) continue;
      // Placeholder de cofre/template não é segredo (ex.: linha já corrigida).
      if (rule.fixable && PLACEHOLDER_VALUE.test(match[2] ?? "")) continue;
      findings.push({
        id: `${rule.id}:${path}:${line}`,
        severity: rule.severity,
        title: rule.title,
        file: path,
        line,
        detail: `Padrão suspeito na linha ${line} (valor mascarado: ${mask(match[0])}). Segredos nunca devem ser versionados nem logados.`,
        suggestion: rule.suggestion,
        patch: rule.fixable ? buildVaultPatch(line, lineText, match.index) : undefined
      });
    }
  });
  return findings;
}

export interface DiffLine {
  type: "context" | "add" | "remove" | "hunk";
  text: string;
}

/**
 * Converte um diff unificado em linhas tipadas para renderização.
 *
 * O que aparece aqui é EXATAMENTE o que `applyUnifiedDiff` vai gravar — as
 * duas funções leem o corpo do hunk pela mesma regra. Antes esta descartava
 * `+++`/`---` em qualquer posição, inclusive DENTRO do hunk, enquanto a
 * aplicação tratava `+++i;` como adição de `++i;` e `--- senha` como remoção
 * de `-- senha` (comentário SQL). A linha ficava invisível na revisão humana
 * e ia para o disco assim mesmo: um furo no único gate da aba de segurança.
 */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let dentroDoHunk = false;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      out.push({ type: "hunk", text: raw });
      dentroDoHunk = true;
      continue;
    }
    // Cabeçalho de arquivo e metadado só existem FORA do corpo do hunk.
    if (
      !dentroDoHunk &&
      (raw.startsWith("+++") ||
        raw.startsWith("---") ||
        raw.startsWith("diff ") ||
        raw.startsWith("index "))
    ) {
      continue;
    }
    // "\ No newline at end of file" — a aplicação também ignora.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      out.push({ type: "add", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ type: "remove", text: raw.slice(1) });
      continue;
    }
    if (raw === "") continue;
    out.push({ type: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return out;
}

/**
 * Aplica um diff unificado ao conteúdo original.
 * Retorna null quando o patch não bate com o conteúdo (nada é escrito).
 */
export function applyUnifiedDiff(source: string, patch: string): string | null {
  /**
   * O arquivo do Windows chega com CRLF — `fs_read` devolve os bytes crus — e
   * o patch nasce de um `split(/\r?\n/)`, sem o `\r`. Cortando o fonte só em
   * "\n", cada linha ficava com um `\r` no fim e NENHUMA comparação batia: o
   * auto-fix de segredo não aplicava nada na plataforma-alvo do app, com a
   * mensagem falsa "o arquivo mudou desde o scan". A quebra original é
   * preservada na volta para não reescrever o arquivo inteiro.
   */
  const crlf = source.includes("\r\n");
  const src = source.split(/\r?\n/);
  const out: string[] = [];
  const lines = patch.split(/\r?\n/);
  let cursor = 0;
  let touched = false;
  let i = 0;
  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!header) {
      i += 1;
      continue;
    }
    const oldStart = Math.max(parseInt(header[1], 10) - 1, 0);
    if (oldStart < cursor || oldStart > src.length) return null;
    out.push(...src.slice(cursor, oldStart));
    cursor = oldStart;
    i += 1;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const body = lines[i];
      if (body.startsWith("+")) {
        out.push(body.slice(1));
        touched = true;
      } else if (body.startsWith("-")) {
        if (src[cursor] !== body.slice(1)) return null;
        cursor += 1;
        touched = true;
      } else if (body.startsWith(" ")) {
        if (src[cursor] !== body.slice(1)) return null;
        out.push(src[cursor]);
        cursor += 1;
      } else if (body === "" || body.startsWith("\\")) {
        // linha vazia ao final do patch / "\ No newline" — ignora
      } else {
        return null;
      }
      i += 1;
    }
  }
  if (!touched) return null;
  out.push(...src.slice(cursor));
  return out.join(crlf ? "\r\n" : "\n");
}

const MAX_FILE_CHARS = 6000;

/** Prompt da revisão profunda: pede achados em bloco ```json de SecurityFinding. */
export function buildReviewPrompt(files: Array<{ path: string; content: string }>): ChatMessage[] {
  const corpus = files
    .map((file) => {
      const clipped =
        file.content.length > MAX_FILE_CHARS
          ? `${file.content.slice(0, MAX_FILE_CHARS)}\n… (arquivo truncado)`
          : file.content;
      return `### ${file.path}\n\`\`\`\n${clipped}\n\`\`\``;
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "Você é um revisor de segurança sênior (revisão multi-modelo). Analise os arquivos e devolva um resumo curto seguido, obrigatoriamente, de um bloco ```json com um array de achados no formato " +
        '[{"id"?: string, "severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "file": string, "line"?: number, "detail": string, "suggestion"?: string, "patch"?: string}]. ' +
        'Quando propuser correção, inclua "patch" como diff unificado (cabeçalho @@ -n,c +n,c @@ e linhas - e +) aplicável ao arquivo indicado. ' +
        "Nunca reproduza o valor de um segredo: mascare credenciais. Cubra segredos, injeção, autenticação/autorização, dependências e supply chain."
    },
    {
      role: "user",
      content: `Revise os ${files.length} arquivos do escopo abaixo e liste os achados de segurança.\n\n${corpus}`
    }
  ];
}

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);

/** Extrai e valida o ```json de achados; gera ids quando faltarem. */
export function parseFindings(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  let seq = 0;
  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      const file = typeof rec.file === "string" ? rec.file.trim() : "";
      if (!title || !file) continue;
      seq += 1;
      findings.push({
        id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `ai-${seq}`,
        severity:
          typeof rec.severity === "string" && SEVERITIES.has(rec.severity)
            ? (rec.severity as Severity)
            : "info",
        title,
        file,
        line:
          typeof rec.line === "number" && Number.isFinite(rec.line)
            ? Math.max(1, Math.floor(rec.line))
            : undefined,
        detail:
          typeof rec.detail === "string" && rec.detail.trim()
            ? rec.detail
            : "Sem detalhes fornecidos pelo revisor.",
        suggestion: typeof rec.suggestion === "string" && rec.suggestion.trim() ? rec.suggestion : undefined,
        patch: typeof rec.patch === "string" && rec.patch.includes("@@") ? rec.patch : undefined
      });
    }
  }
  return findings;
}
