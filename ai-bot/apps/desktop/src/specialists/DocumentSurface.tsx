/**
 * Superfície de documentos.
 *
 * Mostra o texto extraído pelo especialista (resultado de `office.open`), um
 * formulário de "substituir X por Y" que monta o pedido e o manda pelo
 * composer, e a lista do que já foi trocado de verdade no arquivo.
 *
 * Uma decisão honesta que aparece na tela: NÃO existe histórico transacional.
 * Quem edita o arquivo é o especialista, do outro lado. "Desfazer" é portanto
 * uma instrução nova — a troca inversa — e a interface diz isso com todas as
 * letras, em vez de desenhar um botão que finge um rollback que ninguém tem.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Replace, Undo2 } from "lucide-react";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";
import { ConversationSurface } from "./ConversationSurface";

/* --------------------------- o documento no store ------------------------- */

interface OpenDocument {
  name: string;
  path: string;
  text: string;
  /** A extração passou do teto do gateway e veio projetada (início + fim). */
  truncated: boolean;
}

/** Acima disto a exibição trunca: o documento inteiro num nó de texto trava a tela. */
const DISPLAY_LIMIT = 120000;

/**
 * As ferramentas cuja SAÍDA é o texto do documento. A lista é fechada de
 * propósito: `office.edit` e `office.export` devolvem RELATÓRIO ("N
 * ocorrência(s) trocadas…", "texto exportado para…"), e aceitar qualquer
 * `office.*` fazia o recibo da edição SUBSTITUIR o contrato na tela — a pessoa
 * lia uma frase de log onde deveria estar o documento.
 */
const DOCUMENT_SOURCES = new Set(["office.open"]);

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

function argString(args: unknown, key: string): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/* ------------------------- formato e somente-leitura ---------------------- */

/**
 * O que a máquina sabe EDITAR é menor do que o que ela sabe LER: `office.edit`
 * só troca texto em .docx e .pptx (XLSX guarda o texto numa tabela
 * compartilhada — trocar lá mudaria células que ninguém pediu — e PDF não tem
 * editor nesta máquina). O chip no cabeçalho existe para a pessoa saber disso
 * ANTES de digitar a troca, não pelo erro depois.
 */
const EDITABLE_FORMATS = new Set(["docx", "pptx"]);

function formatOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** O último documento que o especialista abriu com sucesso. */
export function collectDocument(lines: ConversationLine[]): OpenDocument | null {
  let found: OpenDocument | null = null;

  for (const line of lines) {
    const results = new Map<string, ToolResult>();
    for (const result of line.toolResults ?? []) results.set(result.callId, result);

    for (const call of line.toolCalls ?? []) {
      if (!DOCUMENT_SOURCES.has(call.tool)) continue;
      const result = results.get(call.callId);
      if (!result || !result.ok || !result.output) continue;
      const path = pathFromArgs(call.args);
      found = {
        name: path === "" ? "documento" : baseName(path),
        path,
        text: result.output,
        truncated: result.truncated === true
      };
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

interface Change {
  /** O callId da chamada office.edit — é ele que identifica a troca. */
  id: string;
  path: string;
  from: string;
  to: string;
  reverted: boolean;
  isRevert: boolean;
}

/**
 * O histórico sai das chamadas `office.edit` que DERAM CERTO nas linhas — não
 * do texto do pedido. A versão anterior parseava o prompt que o formulário
 * montava, e por isso a troca que o modelo fazia por conta própria (a pessoa
 * pediu na conversa, sem o formulário) nunca aparecia; pior, o prompt enviado
 * não prova que o arquivo mudou. A chamada com `ok` prova.
 *
 * Reversão é derivada do mesmo lugar: a edição cujo par (find, replace) é o
 * INVERSO de uma troca anterior ainda de pé, no mesmo arquivo, marca aquela
 * como desfeita e não vira entrada própria.
 */
export function collectChanges(lines: ConversationLine[]): Change[] {
  const changes: Change[] = [];

  for (const line of lines) {
    const results = new Map<string, ToolResult>();
    for (const result of line.toolResults ?? []) results.set(result.callId, result);

    for (const call of line.toolCalls ?? []) {
      if (call.tool !== "office.edit") continue;
      const result = results.get(call.callId);
      // Sem `ok` não houve troca — "nenhuma ocorrência" é recusa, não edição.
      if (!result || !result.ok) continue;

      const path = pathFromArgs(call.args);
      const from = argString(call.args, "find");
      // Vazio é legítimo: apagar um trecho é edição.
      const to = argString(call.args, "replace");

      let isRevert = false;
      for (let i = changes.length - 1; i >= 0; i -= 1) {
        const previous = changes[i];
        if (!previous || previous.reverted || previous.isRevert) continue;
        if (previous.path === path && previous.from === to && previous.to === from) {
          previous.reverted = true;
          isRevert = true;
          break;
        }
      }

      changes.push({ id: call.callId, path, from, to, reverted: false, isRevert });
    }
  }

  return changes.filter((change) => !change.isRevert);
}

/* ---------------------------- releitura automática ------------------------ */

interface RereadTarget {
  callId: string;
  path: string;
  name: string;
}

/**
 * A edição que ainda não foi RELIDA: a última `office.edit` com sucesso sem um
 * `office.open` do MESMO arquivo depois dela. Enquanto ela existir, o corpo na
 * tela é o texto de ANTES da troca — e uma tela de documento que mostra o
 * passado sem avisar é o defeito que a releitura automática fecha.
 */
export function pendingReread(lines: ConversationLine[]): RereadTarget | null {
  let pending: RereadTarget | null = null;

  for (const line of lines) {
    const results = new Map<string, ToolResult>();
    for (const result of line.toolResults ?? []) results.set(result.callId, result);

    for (const call of line.toolCalls ?? []) {
      const result = results.get(call.callId);
      if (!result || !result.ok) continue;
      const path = pathFromArgs(call.args);
      if (call.tool === "office.edit") {
        pending = { callId: call.callId, path, name: path === "" ? "documento" : baseName(path) };
      } else if (DOCUMENT_SOURCES.has(call.tool) && pending !== null && pending.path === path) {
        pending = null;
      }
    }
  }

  return pending;
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
  const reread = useMemo(() => pendingReread(lines), [lines]);

  /**
   * Releitura automática depois de uma troca aplicada.
   *
   * `office.open` NÃO está na whitelist de ferramentas que a UI pode chamar
   * fora do turno (ui_tools.go — a lista é fechada de propósito), então a
   * releitura vai pelo MESMO caminho do botão Reler: uma mensagem na conversa,
   * que passa pelo funil de sempre. Dois guardas seguram o gatilho:
   *
   * - as edições presentes na PRIMEIRA renderização não disparam nada — são
   *   histórico recarregado, e reencenar o pedido ao abrir a conversa seria o
   *   mesmo defeito do portão sem eco;
   * - só dispara depois de um turno VIVO nesta montagem (`busy` já foi true).
   *   O replay preenche as linhas com `busy` sempre falso, então a conversa de
   *   ontem nunca ganha uma mensagem nova só porque a tela foi aberta.
   */
  const rereadDone = useRef<Set<string> | null>(null);
  const sawLiveTurn = useRef(false);
  useEffect(() => {
    if (rereadDone.current === null) {
      const seed = new Set<string>();
      for (const line of lines) {
        for (const call of line.toolCalls ?? []) {
          if (call.tool === "office.edit") seed.add(call.callId);
        }
      }
      rereadDone.current = seed;
    }
    if (busy) {
      sawLiveTurn.current = true;
      return;
    }
    if (!sawLiveTurn.current || reread === null || rereadDone.current.has(reread.callId)) return;
    rereadDone.current.add(reread.callId);
    send(`Releia o documento ${reread.name} e mostre o texto atualizado. (releitura automática após a troca aplicada)`);
  }, [lines, busy, reread, send]);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const body = doc ? doc.text : "";
  const truncated = body.length > DISPLAY_LIMIT;
  const shown = truncated ? body.slice(0, DISPLAY_LIMIT) : body;
  const hits = countOccurrences(body, from);

  const format = doc ? formatOf(doc.name) : "";
  const editable = format !== "" && EDITABLE_FORMATS.has(format);

  // Aspas duplas continuam barradas por causa do PROMPT: o termo viaja entre
  // aspas no pedido, e aspas dentro de aspas deixam o modelo adivinhando onde o
  // termo acaba. O histórico já não depende do texto (vem das chamadas reais).
  const hasQuote = from.includes('"') || to.includes('"');
  const canSend = doc !== null && editable && from.trim() !== "" && !hasQuote && !busy;

  function submit(): void {
    if (!doc || !canSend) return;
    send(buildReplacePrompt(doc.name, from, to));
    setFrom("");
    setTo("");
  }

  function revert(change: Change): void {
    if (busy) return;
    // O nome sai da PRÓPRIA troca: a edição pode ter sido em outro arquivo que
    // não o documento aberto agora, e desfazer no arquivo errado é pior que
    // não desfazer.
    const name = change.path === "" ? doc?.name ?? "documento" : baseName(change.path);
    send(buildRevertPrompt(name, change.from, change.to));
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
        {format !== "" ? <span className="chip doc-format">{format.toUpperCase()}</span> : null}
        {doc && !editable ? (
          <span className="chip doc-readonly" title="a troca de texto só existe para .docx e .pptx">
            somente leitura
          </span>
        ) : null}
        {doc && doc.path !== "" ? <span className="card-eyebrow">{doc.path}</span> : null}
        <span className="surface-toolbar-spacer" />
      </div>

      <div className="split">
        <div className="split-main">
          <div className="doc-page" role="document">
            {doc ? (
              <>
                <div className="doc-extract">{highlight(shown, from)}</div>
                {doc.truncated ? (
                  <p className="card-eyebrow">
                    texto parcial: a extração passou do teto do gateway e veio projetada (início + fim)
                  </p>
                ) : null}
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
                  disabled={!doc || !editable}
                />
              </label>
              <label className="doc-field">
                <span className="card-eyebrow">por</span>
                <input
                  className="doc-input"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="texto novo"
                  disabled={!doc || !editable}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={!canSend}>
                <Replace aria-hidden="true" />
                Pedir a troca
              </button>
            </div>
            <p className="card-body">
              {doc && !editable
                ? "este formato é somente leitura — a troca de texto só existe para .docx e .pptx"
                : hasQuote
                  ? "sem aspas duplas nos termos — elas atrapalham a leitura do pedido"
                  : from.trim() === ""
                    ? "o pedido vai pela conversa, como qualquer outra instrução"
                    : `${hits} ${hits === 1 ? "ocorrência encontrada" : "ocorrências encontradas"}`}
            </p>
          </form>

          <section className="card doc-changes" aria-label="trocas aplicadas">
            <div className="card-head">
              <span className="card-title">trocas aplicadas ({changes.length})</span>
            </div>
            <p className="card-eyebrow">
              desfazer envia a troca inversa — é uma instrução nova, não um histórico com rollback
            </p>
            {changes.length === 0 ? (
              <p className="card-body">nenhuma troca aplicada nesta sessão</p>
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
                      <span className="chip">desfeita</span>
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
        <span>{changes.length} trocas aplicadas</span>
        <span>quem edita o arquivo é o especialista</span>
      </div>
    </div>
  );
}

export default DocumentSurface;
