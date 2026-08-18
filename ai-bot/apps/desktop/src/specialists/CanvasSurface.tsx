/**
 * Superfície do especialista de DESIGN.
 *
 * Três faixas: os TOKENS extraídos à esquerda, a prévia do HTML no centro, a
 * conversa compacta à direita.
 *
 * Nada aqui é estado próprio da tela: o painel é a leitura do último
 * `tool.result` de `design.replicate` que passou pela conversa. Guardar uma
 * cópia dos tokens neste componente criaria uma segunda verdade, que envelhece
 * sozinha assim que a pessoa replicar outra URL.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Braces, Check, Copy, Download, Globe, Link2, Palette, ShieldCheck, Type, X } from "lucide-react";
import type { ConversationLine, ToolResult } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";
import { ConversationSurface } from "./ConversationSurface";

/* --------------------------- leitura do tool.result ---------------------- */

interface DesignColor {
  /** Nome do token quando a ferramenta deu um; senão o próprio valor. */
  name: string;
  value: string;
  note: string;
}

interface DesignVariable {
  name: string;
  value: string;
}

interface DesignFont {
  family: string;
  note: string;
}

interface DesignSnapshot {
  url: string;
  title: string;
  colors: DesignColor[];
  variables: DesignVariable[];
  fonts: DesignFont[];
  html: string;
}

const EMPTY: DesignSnapshot = { url: "", title: "", colors: [], variables: [], fonts: [], html: "" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Cor chega como "#aabbcc" ou como objeto com nome e uso. */
function readColors(value: unknown): DesignColor[] {
  if (!Array.isArray(value)) return [];
  const out: DesignColor[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item, value: item, note: "" });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const raw = asText(record.value) || asText(record.hex) || asText(record.color);
    if (raw === "") continue;
    out.push({
      name: asText(record.name) || asText(record.token) || raw,
      value: raw,
      note: asText(record.role) || asText(record.usage) || asText(record.note)
    });
  }
  return out;
}

/** Variáveis chegam como lista de objetos ou como mapa nome→valor. */
function readVariables(value: unknown): DesignVariable[] {
  const out: DesignVariable[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      const name = asText(record.name) || asText(record.property);
      const raw = asText(record.value);
      if (name !== "" && raw !== "") out.push({ name, value: raw });
    }
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw === "string") out.push({ name, value: raw });
  }
  return out;
}

function readFonts(value: unknown): DesignFont[] {
  if (!Array.isArray(value)) return [];
  const out: DesignFont[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ family: item, note: "" });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const family = asText(record.family) || asText(record.name) || asText(record.value);
    if (family === "") continue;
    out.push({ family, note: asText(record.role) || asText(record.usage) || asText(record.weight) });
  }
  return out;
}

function dedupe(colors: DesignColor[]): DesignColor[] {
  const seen = new Set<string>();
  const out: DesignColor[] = [];
  for (const color of colors) {
    const key = color.value.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(color);
  }
  return out;
}

/**
 * Quando o `output` não é JSON ainda dá para aproveitar: CSS cru tem cor, tem
 * custom property e tem font-family. Melhor mostrar o que deu para ler do que um
 * painel vazio ao lado de uma resposta que claramente trouxe tokens.
 */
function fromText(text: string): DesignSnapshot {
  const colors = dedupe(
    [...text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)|hsla?\([^)]{3,60}\)/g)].map((match) => ({
      name: match[0],
      value: match[0],
      note: ""
    }))
  );

  const variables: DesignVariable[] = [];
  for (const match of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;\n}]{1,120})/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    variables.push({ name, value: value.trim() });
  }

  const fonts: DesignFont[] = [];
  for (const match of text.matchAll(/font-family\s*:\s*([^;\n}]{1,120})/gi)) {
    const family = match[1];
    if (family === undefined) continue;
    fonts.push({ family: family.trim(), note: "" });
  }

  return {
    ...EMPTY,
    colors,
    variables: variables.slice(0, 60),
    fonts,
    html: /^\s*(<!doctype|<html|<div|<section|<body|<main)/i.test(text) ? text : ""
  };
}

function parse(result: ToolResult): DesignSnapshot {
  const raw = result.output ?? "";
  const root = asRecord(safeJson(raw));
  if (!root) return fromText(raw);

  // A ferramenta pode aninhar tudo em `tokens` ou espalhar na raiz; os dois
  // formatos aparecem na prática porque o host que responde é outro programa.
  const source = asRecord(root.tokens) ?? root;
  return {
    url: asText(root.url) || asText(root.source),
    title: asText(root.title),
    colors: dedupe(readColors(source.colors ?? source.palette)),
    variables: readVariables(source.variables ?? source.cssVariables ?? source.custom),
    fonts: readFonts(source.fonts ?? source.typography ?? source.families),
    html: asText(root.html) || asText(root.markup) || asText(root.preview)
  };
}

/** O último resultado vence: replicar de novo troca a tela inteira. */
function readDesign(lines: ConversationLine[]): DesignSnapshot {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const results = lines[index]?.toolResults;
    if (results === undefined) continue;
    for (let inner = results.length - 1; inner >= 0; inner -= 1) {
      const result = results[inner];
      if (result === undefined) continue;
      if (result.tool === "design.replicate" && result.ok) return parse(result);
    }
  }
  return EMPTY;
}

function countTokens(snapshot: DesignSnapshot): number {
  return snapshot.colors.length + snapshot.variables.length + snapshot.fonts.length;
}

/** O texto que a ação "Exportar tokens" entrega. */
function toCss(snapshot: DesignSnapshot): string {
  const head = snapshot.url
    ? `/* tokens extraídos de ${snapshot.url} — AI-BOT */`
    : "/* tokens extraídos — AI-BOT */";
  const body: string[] = [];
  snapshot.colors.forEach((color, index) => {
    body.push(`  ${color.name.startsWith("--") ? color.name : `--color-${index + 1}`}: ${color.value};`);
  });
  snapshot.variables.forEach((variable) => {
    body.push(`  ${variable.name.startsWith("--") ? variable.name : `--${variable.name}`}: ${variable.value};`);
  });
  snapshot.fonts.forEach((font, index) => {
    body.push(`  --font-${index + 1}: ${font.family};`);
  });
  return `${head}\n:root {\n${body.join("\n")}\n}\n`;
}

/* -------------------------------- copiar -------------------------------- */

type CopyState = "idle" | "done" | "fail";

function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");

  // O aviso volta a ser botão sozinho; sem isto ele trava no visto e a segunda
  // cópia não dá sinal nenhum de que aconteceu.
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);

  function copy(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => setState("done"),
      () => setState("fail")
    );
  }

  return [state, copy];
}

function CopyIconButton({ value, title }: { value: string; title: string }): ReactNode {
  const [state, copy] = useCopy();
  return (
    <button
      type="button"
      className="btn icon-btn"
      title={state === "fail" ? "não deu para copiar" : title}
      onClick={() => copy(value)}
    >
      {state === "done" ? <Check size={13} /> : state === "fail" ? <X size={13} /> : <Copy size={13} />}
    </button>
  );
}

/* ------------------------- ações na barra superior ----------------------- */

function ReplicateAction(): ReactNode {
  const send = useApp((state) => state.send);
  const busy = useApp((state) => state.busy);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [warn, setWarn] = useState("");
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  function submit(): void {
    const candidate = url.trim();
    // A recusa acontece aqui, e não no gateway, porque o aviso chega perto do
    // dedo: quem digitou ainda está olhando para o campo.
    if (!/^https?:\/\/\S+$/i.test(candidate)) {
      setWarn("precisa começar com http:// ou https://");
      return;
    }
    send(`/replicar ${candidate}`);
    setUrl("");
    setWarn("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)} title="extrai a linguagem visual de uma página">
        <Globe size={13} aria-hidden="true" />
        Replicar URL
      </button>
    );
  }

  return (
    <span className="inline-prompt" title={warn}>
      <Link2 size={13} aria-hidden="true" />
      <input
        ref={field}
        type="url"
        className="inline-prompt-field"
        value={url}
        placeholder="https://exemplo.com"
        spellCheck={false}
        aria-label="endereço para replicar"
        aria-invalid={warn !== ""}
        onChange={(event) => {
          setUrl(event.target.value);
          if (warn !== "") setWarn("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
        Replicar
      </button>
      <button type="button" className="btn btn-ghost icon-btn" title="fechar" onClick={() => setOpen(false)}>
        <X size={13} />
      </button>
    </span>
  );
}

function ExportTokensAction({ snapshot }: { snapshot: DesignSnapshot }): ReactNode {
  const [state, copy] = useCopy();
  const total = countTokens(snapshot);
  return (
    <button
      type="button"
      className="btn"
      disabled={total === 0}
      title={
        total === 0
          ? "nenhum token extraído ainda"
          : "copia os tokens como um bloco :root pronto para colar no projeto"
      }
      onClick={() => copy(toCss(snapshot))}
    >
      {state === "done" ? <Check size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
      {state === "done" ? "copiado" : state === "fail" ? "não deu" : "Exportar tokens"}
    </button>
  );
}

/* -------------------------------- superfície ---------------------------- */

export function CanvasSurface(): ReactNode {
  const lines = useApp((state) => state.lines);
  const setInput = useApp((state) => state.setInput);
  const snapshot = useMemo(() => readDesign(lines), [lines]);
  const total = countTokens(snapshot);

  return (
    <div className="surface canvas-surface">
      {/* A superfície não desenha barra própria: injeta os botões no slot da
          barra do app. É o que sustenta a promessa de tela única. */}
      <TopbarActions>
        <ReplicateAction />
        <ExportTokensAction snapshot={snapshot} />
      </TopbarActions>

      <div className="surface-toolbar">
        <Palette size={13} aria-hidden="true" />
        <span className="surface-title">{snapshot.title || "Design"}</span>
        {snapshot.url ? (
          <span className="chip" title={snapshot.url}>
            {snapshot.url.replace(/^https?:\/\//, "")}
          </span>
        ) : null}
        <span className="surface-toolbar-spacer" />
        <span className="chip" title="a prévia roda sem JavaScript, sem rede e sem acesso ao aplicativo">
          <ShieldCheck size={12} aria-hidden="true" />
          prévia sem scripts
        </span>
      </div>

      <div className="surface-body canvas-split">
        <aside className="canvas-tokens" aria-label="tokens extraídos">
          {total === 0 ? (
            <div className="card">
              <div className="card-head">
                <Palette size={13} aria-hidden="true" />
                <span className="card-title">Tokens</span>
              </div>
              <div className="card-body">
                Nenhum token extraído ainda. Use “Replicar URL” na barra de cima: o que voltar de{" "}
                <code>design.replicate</code> — cores, variáveis e fontes — aparece aqui.
              </div>
            </div>
          ) : (
            <>
              {snapshot.colors.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Palette size={13} aria-hidden="true" />
                    <span className="card-title">Cores</span>
                    <span className="chip">{snapshot.colors.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.colors.map((color) => (
                      <li className="token-row" key={`${color.name}|${color.value}`}>
                        {/* A amostra é pintada com o valor lido: não existe classe
                            possível para uma cor que só nasce em tempo de execução. */}
                        <span className="token-swatch" style={{ background: color.value }} aria-hidden="true" />
                        <span className="token-text">
                          <b title={color.note || undefined}>{color.name}</b>
                          <code>{color.value}</code>
                        </span>
                        <CopyIconButton value={color.value} title={`copiar ${color.value}`} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {snapshot.variables.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Braces size={13} aria-hidden="true" />
                    <span className="card-title">Variáveis CSS</span>
                    <span className="chip">{snapshot.variables.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.variables.map((variable) => (
                      <li className="token-row" key={variable.name}>
                        <span className="token-text">
                          <b>{variable.name}</b>
                          <code title={variable.value}>{variable.value}</code>
                        </span>
                        <CopyIconButton
                          value={`${variable.name}: ${variable.value};`}
                          title={`copiar ${variable.name}`}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {snapshot.fonts.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Type size={13} aria-hidden="true" />
                    <span className="card-title">Tipografia</span>
                    <span className="chip">{snapshot.fonts.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.fonts.map((font) => (
                      <li className="token-row" key={font.family}>
                        {/* A amostra existe para julgar a fonte, então é escrita
                            na própria fonte. */}
                        <span className="token-sample" style={{ fontFamily: font.family }} aria-hidden="true">
                          Aa
                        </span>
                        <span className="token-text">
                          <b>{font.family}</b>
                          {font.note ? <code>{font.note}</code> : null}
                        </span>
                        <CopyIconButton value={font.family} title={`copiar ${font.family}`} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </aside>

        <div className="canvas-frame">
          {snapshot.html ? (
            <>
              {/*
               * sandbox="" — vazio DE PROPÓSITO, e em especial SEM allow-scripts.
               *
               * O HTML daqui veio de um site de terceiro (design.replicate lê a
               * página de outra pessoa) ou saiu de um modelo. Nos dois casos é
               * texto que ninguém revisou. Um iframe com allow-scripts roda esse
               * JavaScript DENTRO da janela do app: com allow-same-origin junto
               * ele alcança o DOM e o storage do AI-BOT; e mesmo sem ele ainda
               * navega a janela de cima, abre popup, chama a rede e escuta
               * tecla. Em Tauri o estrago passa da aba — a ponte para o sistema
               * de arquivos e para os comandos do host mora nesta mesma janela,
               * e entregar script de terceiro aqui é entregar a janela.
               *
               * O sandbox vazio nega tudo: script, formulário, mesma origem,
               * navegação do topo, popup, download, trava de ponteiro. Prévia de
               * layout não precisa de nada disso — cor, espaço e tipo são CSS.
               * Se um dia a prévia precisar de interação, o caminho é abrir num
               * navegador externo pelo plugin-opener, NÃO afrouxar este atributo.
               */}
              <iframe title="Prévia do HTML replicado" sandbox="" srcDoc={snapshot.html} />
              <span className="canvas-caption">sandbox="" · sem script, sem rede, sem acesso ao app</span>
            </>
          ) : (
            <div className="surface-empty">
              <Globe size={22} aria-hidden="true" />
              <p>Sem prévia ainda.</p>
              <p>
                Cole uma URL em “Replicar URL” ou peça uma tela ao especialista. Quando vier HTML, ele é
                desenhado aqui numa moldura isolada, sem executar script.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => setInput("/replicar ")}
                title="preenche o campo de texto com o atalho"
              >
                Preencher /replicar
              </button>
            </div>
          )}
        </div>

        <aside className="canvas-talk" aria-label="conversa">
          <ConversationSurface compact />
        </aside>
      </div>

      <div className="surface-status">
        <span>
          cores <b>{snapshot.colors.length}</b>
        </span>
        <span>
          variáveis <b>{snapshot.variables.length}</b>
        </span>
        <span>
          fontes <b>{snapshot.fonts.length}</b>
        </span>
        <span>{snapshot.html ? "prévia isolada, sem script" : "sem HTML de prévia"}</span>
      </div>
    </div>
  );
}

export default CanvasSurface;
