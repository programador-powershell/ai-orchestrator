/**
 * Superfície de documentos.
 *
 * Mostra o texto extraído pelo especialista (resultado de `office.open`), um
 * formulário de "substituir X por Y" que monta o pedido e o manda pelo
 * composer, e a lista do que já foi pedido.
 *
 * Uma decisão honesta que aparece na tela: NÃO existe histórico transacional.
 * Quem edita o arquivo é o especialista, do outro lado. "Desfazer" é portanto
 * uma instrução nova — a troca inversa — e a interface diz isso com todas as
 * letras, em vez de desenhar um botão que finge um rollback que ninguém tem.
 */

import { useMemo, useState, type ReactNode } from "react";
import { FileText, Replace, Undo2 } from "lucide-react";
import type { ConversationLine, ToolResult } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";
import { ConversationSurface } from "./ConversationSurface";

/* --------------------------- o documento no store ------------------------- */

interface OpenDocument {
  name: string;
  path: string;
  text: string;
}

/** Acima disto a exibição trunca: o documento inteiro num nó de texto trava a tela. */
const DISPLAY_LIMIT = 120000;

function pathFromArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "filename", "document"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** O último documento que o especialista abriu com sucesso. */
function collectDocument(lines: ConversationLine[]): OpenDocument | null {
  let found: OpenDocument | null = null;

  for (const line of lines) {
    const results = new Map<string, ToolResult>();
    for (const result of line.toolResults ?? []) results.set(result.callId, result);

    for (const call of line.toolCalls ?? []) {
      if (!call.tool.startsWith("office.")) continue;
      const result = results.get(call.callId);
      if (!result || !result.ok || !result.output) continue;
      const path = pathFromArgs(call.args);
      found = { name: path === "" ? "documento" : baseName(path), path, text: result.output };
    }
  }

  return found;
}

/* -------------------------------- os pedidos ------------------------------ */

const REVERT_MARK = "(desfazendo a troca anterior)";

function buildReplacePrompt(docName: string, from: string, to: string): string {
  return `No documento ${docName}, substitua todas as ocorrências de "${from}" por "${to}".`;
}

function buildRevertPrompt(docName: string, from: string, to: string): string {
  return `No documento ${docName}, substitua todas as ocorrências de "${to}" por "${from}". ${REVERT_MARK}`;
}

/**
 * A regex reconhece o pedido que nós mesmos montamos.
 *
 * O preço de derivar a lista da conversa, em vez de guardar um array local: o
 * formato do texto vira contrato. O ganho é a lista sobreviver ao reload e
 * mostrar o que de fato foi enviado, e não o que a tela achava ter enviado. Por
 * isso o formulário recusa aspas duplas nos termos — elas quebram a leitura.
 */
const RE_REPLACE = /No documento (.+?), substitua todas as ocorrências de "([^"]*)" por "([^"]*)"\./;

interface Change {
  id: string;
  from: string;
  to: string;
  reverted: boolean;
  isRevert: boolean;
}

function collectChanges(lines: ConversationLine[]): Change[] {
  const changes: Change[] = [];

  for (const line of lines) {
    if (line.role !== "user") continue;
    const match = RE_REPLACE.exec(line.text);
    if (!match) continue;

    const from = match[2] ?? "";
    const to = match[3] ?? "";
    const isRevert = line.text.includes(REVERT_MARK);

    if (isRevert) {
      // A reversão troca `to` por `from`; marca o pedido original ainda de pé.
      for (let i = changes.length - 1; i >= 0; i -= 1) {
        const previous = changes[i];
        if (!previous || previous.reverted || previous.isRevert) continue;
        if (previous.from === to && previous.to === from) {
          previous.reverted = true;
          break;
        }
      }
    }

    changes.push({ id: line.id, from, to, reverted: false, isRevert });
  }

  return changes.filter((change) => !change.isRevert);
}

/* --------------------------------- destaque ------------------------------- */

function countOccurrences(text: string, term: string): number {
  if (term === "") return 0;
  let total = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    total += 1;
    index = text.indexOf(term, index + term.length);
  }
  return total;
}

/** Busca literal, sem regex: o termo é do usuário e não pode virar padrão. */
function highlight(text: string, term: string): ReactNode {
  if (term === "") return text;

  const out: ReactNode[] = [];
  let from = 0;
  let n = 0;
  let index = text.indexOf(term);

  // O teto existe para um termo de uma letra não gerar dezenas de milhares de
  // nós e travar a rolagem; a contagem completa continua no rodapé do campo.
  while (index !== -1 && n < 500) {
    if (index > from) out.push(text.slice(from, index));
    out.push(
      <mark className="doc-hit" key={`hit${n}`}>
        {term}
      </mark>
    );
    from = index + term.length;
    n += 1;
    index = text.indexOf(term, from);
  }

  out.push(text.slice(from));
  return out;
}

/* -------------------------------- superfície ------------------------------ */

export function DocumentSurface(): ReactNode {
  const lines = useApp((state) => state.lines);
  const busy = useApp((state) => state.busy);
  const send = useApp((state) => state.send);

  // `doc`, e não `document`: uma variável com esse nome sombrearia o `document`
  // global e faria qualquer uso de DOM aqui dentro apontar para o lugar errado.
  const doc = useMemo(() => collectDocument(lines), [lines]);
  const changes = useMemo(() => collectChanges(lines), [lines]);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const body = doc ? doc.text : "";
  const truncated = body.length > DISPLAY_LIMIT;
  const shown = truncated ? body.slice(0, DISPLAY_LIMIT) : body;
  const hits = countOccurrences(body, from);

  const hasQuote = from.includes('"') || to.includes('"');
  const canSend = doc !== null && from.trim() !== "" && !hasQuote && !busy;

  function submit(): void {
    if (!doc || !canSend) return;
    send(buildReplacePrompt(doc.name, from, to));
    setFrom("");
    setTo("");
  }

  function revert(change: Change): void {
    if (!doc || busy) return;
    send(buildRevertPrompt(doc.name, change.from, change.to));
  }

  return (
    <div className="surface">
      <TopbarActions>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (doc) send(`Releia o documento ${doc.name} e mostre o texto atualizado.`);
          }}
          disabled={!doc || busy}
          title="pede ao especialista o texto como está agora no arquivo"
        >
          <FileText aria-hidden="true" />
          Reler
        </button>
      </TopbarActions>

      <div className="surface-toolbar">
        <FileText aria-hidden="true" />
        <span className="surface-title">{doc ? doc.name : "nenhum documento aberto"}</span>
        {doc && doc.path !== "" ? <span className="card-eyebrow">{doc.path}</span> : null}
        <span className="surface-toolbar-spacer" />
      </div>

      <div className="split">
        <div className="split-main">
          <div className="doc-page" role="document">
            {doc ? (
              <>
                <div className="doc-extract">{highlight(shown, from)}</div>
                {truncated ? (
                  <p className="card-eyebrow">
                    exibição cortada em {DISPLAY_LIMIT.toLocaleString("pt-BR")} caracteres — a substituição vale para o
                    documento inteiro
                  </p>
                ) : null}
              </>
            ) : (
              <p className="card-body">
                Peça na conversa para abrir um arquivo — por exemplo, “abra o contrato.docx”. O texto extraído aparece
                aqui.
              </p>
            )}
          </div>

          <form
            className="card doc-replace"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="card-head">
              <Replace aria-hidden="true" />
              <span className="card-title">Substituir no documento</span>
            </div>
            <div className="doc-replace-fields">
              <label className="doc-field">
                <span className="card-eyebrow">substituir</span>
                <input
                  className="doc-input"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  placeholder="texto atual"
                  disabled={!doc}
                />
              </label>
              <label className="doc-field">
                <span className="card-eyebrow">por</span>
                <input
                  className="doc-input"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="texto novo"
                  disabled={!doc}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={!canSend}>
                <Replace aria-hidden="true" />
                Pedir a troca
              </button>
            </div>
            <p className="card-body">
              {hasQuote
                ? "sem aspas duplas nos termos — elas atrapalham a leitura do pedido"
                : from.trim() === ""
                  ? "o pedido vai pela conversa, como qualquer outra instrução"
                  : `${hits} ${hits === 1 ? "ocorrência encontrada" : "ocorrências encontradas"}`}
            </p>
          </form>

          <section className="card doc-changes" aria-label="trocas pedidas">
            <div className="card-head">
              <span className="card-title">trocas pedidas ({changes.length})</span>
            </div>
            <p className="card-eyebrow">
              desfazer envia a troca inversa — é uma instrução nova, não um histórico com rollback
            </p>
            {changes.length === 0 ? (
              <p className="card-body">nenhuma troca pedida nesta sessão</p>
            ) : (
              <ul className="doc-changes-list">
                {changes.map((change) => (
                  <li className="doc-change" data-reverted={change.reverted ? "true" : "false"} key={change.id}>
                    <span className="doc-change-terms">
                      <b>{change.from}</b>
                      <span aria-hidden="true"> → </span>
                      <b>{change.to}</b>
                    </span>
                    {change.reverted ? (
                      <span className="chip">reversão pedida</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => revert(change)}
                        disabled={busy}
                        title={`envia o pedido inverso: trocar "${change.to}" de volta por "${change.from}"`}
                      >
                        <Undo2 aria-hidden="true" />
                        Desfazer
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="split-aside" aria-label="conversa">
          <ConversationSurface compact />
        </aside>
      </div>

      <div className="surface-status">
        <span>
          <b>{doc ? doc.name : "—"}</b>
        </span>
        <span>{body.length.toLocaleString("pt-BR")} caracteres</span>
        <span>{changes.length} trocas pedidas</span>
        <span>quem edita o arquivo é o especialista</span>
      </div>
    </div>
  );
}

export default DocumentSurface;
