/**
 * Composer — o único campo de texto do app.
 *
 * É a peça que mais muda de forma: o placeholder, os atalhos e o destino da linha
 * dependem de QUEM vai ler o que está sendo escrito. Antes da primeira rota quem
 * lê é o master; depois, o especialista ativo; e, se a pessoa fixou um, é ele.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, ArrowUp, Bot, Check, ChevronDown, Paperclip, RotateCcw, Square, X } from "lucide-react";
import type { SpecialistAction, SpecialistDefinition } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { FALLBACK_SPECIALISTS, MASTER, SPECIALIST_ICON, specialistById } from "../lib/specialists";
import { ThinkingOrb } from "./ThinkingOrb";

/** Cresce até aqui; daqui em diante o campo rola em vez de empurrar a conversa. */
const MAX_ROWS = 8;
/** Abaixo disso o contador é ruído: ninguém escreve dois mil caracteres sem perceber. */
const COUNTER_AT = 2000;

const FIELD_ID = "composer-input";
const HINT_ID = "composer-hint";

/**
 * O visually-hidden vai inline de propósito: se a classe utilitária faltasse no CSS
 * do shell, o rótulo e a dica apareceriam por cima do campo. Rótulo de acessibilidade
 * não pode depender de folha de estilo escrita em outro arquivo.
 */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0
};

function SpecialistGlyph({ id, size = 14 }: { id: string; size?: number }) {
  const Icon = SPECIALIST_ICON[id] ?? Bot;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

export function Composer() {
  const input = useApp((s) => s.input);
  const busy = useApp((s) => s.busy);
  const thinking = useApp((s) => s.thinking);
  const error = useApp((s) => s.error);
  const status = useApp((s) => s.status);
  const specialists = useApp((s) => s.specialists);
  const activeSpecialist = useApp((s) => s.activeSpecialist);
  const specialistOverride = useApp((s) => s.specialistOverride);
  const setInput = useApp((s) => s.setInput);
  const setSpecialistOverride = useApp((s) => s.setSpecialistOverride);
  const send = useApp((s) => s.send);
  const attachments = useApp((s) => s.attachments);
  const attach = useApp((s) => s.attach);
  const detach = useApp((s) => s.detach);
  const stop = useApp((s) => s.stop);
  const connect = useApp((s) => s.connect);

  // O "refazer" reenvia a última coisa que a PESSOA escreveu, não a última linha da
  // conversa — refazer uma resposta do assistente não é uma ação que exista aqui.
  const lastUserText = useApp((s) => {
    for (let i = s.lines.length - 1; i >= 0; i -= 1) {
      // `noUncheckedIndexedAccess` está ligado: indexar array devolve
      // `T | undefined`. A guarda não é cerimônia — `lines` é reescrito pela
      // redução de envelope enquanto o seletor roda.
      const line = s.lines[i];
      if (line?.role === "user") return line.text;
    }
    return "";
  });

  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  /** Posição de cursor a aplicar depois que o React repintar o valor do campo. */
  const caretRef = useRef<number | null>(null);
  /** Composição de IME em curso (acento morto, teclado japonês): Enter confirma, não envia. */
  const composingRef = useRef(false);

  const [pickerOpen, setPickerOpen] = useState(false);

  const catalog = specialists.length > 0 ? specialists : FALLBACK_SPECIALISTS;
  const pinned = specialistOverride !== "";

  /**
   * Quem vai ler a PRÓXIMA linha — e não quem atendeu a última. Enquanto não houve
   * rota, é o master: é ele quem recebe o texto, e o placeholder tem que ser a
   * pergunta dele. Um especialista fixado passa na frente porque a pessoa já decidiu.
   */
  const target = useMemo<SpecialistDefinition>(() => {
    if (specialistOverride) return specialistById(catalog, specialistOverride);
    if (activeSpecialist) return specialistById(catalog, activeSpecialist);
    return MASTER;
  }, [catalog, specialistOverride, activeSpecialist]);

  const actions: SpecialistAction[] = target.actions ?? [];

  const focusField = useCallback(() => {
    fieldRef.current?.focus();
  }, []);

  /* ----------------------------- altura do campo ---------------------------- */

  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    // Zera antes de medir: scrollHeight nunca encolhe sozinho, o campo ficaria grande
    // para sempre depois de apagar o texto.
    el.style.height = "auto";
    const style = window.getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20;
    const frame =
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    const max = line * MAX_ROWS + frame;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  useLayoutEffect(() => {
    const el = fieldRef.current;
    const caret = caretRef.current;
    if (!el || caret === null) return;
    caretRef.current = null;
    el.setSelectionRange(caret, caret);
  }, [input]);

  /* --------------------------------- envio --------------------------------- */

  const submit = useCallback(() => {
    if (busy) return;
    // Anexo sem texto vale como envio: o gesto de anexar já diz "abre isso".
    if (!input.trim() && attachments.length === 0) return;
    // Sem argumento: o store já tem o texto: passar `input` aqui criaria duas fontes
    // de verdade para a mesma string.
    send();
  }, [busy, input, attachments.length, send]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (composingRef.current || event.nativeEvent.isComposing) return;
      // Shift+Enter quebra linha; Ctrl/Cmd+Enter envia mesmo com Shift.
      const wantsSend = event.ctrlKey || event.metaKey || !event.shiftKey;
      if (!wantsSend) return;
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const retry = useCallback(() => {
    // Erro de conexão não tem prompt para repetir — o que falta é a conexão.
    if (status === "offline") {
      connect();
      return;
    }
    if (input.trim()) {
      send();
      return;
    }
    if (lastUserText) send(lastUserText);
  }, [status, input, send, connect, lastUserText]);

  /* --------------------------------- chips --------------------------------- */

  const applyAction = useCallback(
    (action: SpecialistAction) => {
      const prefix = `${action.insert.trimEnd()} `;
      if (input.startsWith(prefix)) {
        // Já está lá: clicar de novo não vira "/revisar /revisar ".
        focusField();
        return;
      }
      caretRef.current = prefix.length; // o cursor fica logo depois do atalho, onde se continua escrevendo
      setInput(`${prefix}${input.replace(/^\s+/, "")}`);
      focusField();
    },
    [input, setInput, focusField]
  );

  /* ------------------------------- seletor --------------------------------- */

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = pickerRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerOpen(false);
        fieldRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const choose = useCallback(
    (id: string) => {
      setSpecialistOverride(id);
      setPickerOpen(false);
      focusField();
    },
    [setSpecialistOverride, focusField]
  );

  const sendTitle = pinned
    ? `Enviar para ${target.name} — Enter`
    : "Enviar — o master escolhe o especialista (Enter)";

  return (
    <div className="composer-wrap">
      {error ? (
        <div className="composer-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="composer-error-text">{error}</span>
          <button type="button" className="composer-retry" onClick={retry}>
            <RotateCcw size={13} aria-hidden="true" />
            Refazer
          </button>
        </div>
      ) : null}

      {/* Fica sempre montado: região viva que só existe quando tem conteúdo costuma
          não ser anunciada, porque o leitor de tela não a viu nascer. */}
      <div className="composer-status">
        <ThinkingOrb label={thinking} />
      </div>

      {actions.length > 0 ? (
        <div className="composer-chips" role="group" aria-label={`Atalhos de ${target.name}`}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="composer-chip"
              onClick={() => applyAction(action)}
              title={`Insere "${action.insert.trimEnd()}" no começo da linha`}
            >
              <span className="composer-chip-glyph" aria-hidden="true">
                {action.glyph}
              </span>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      {pinned ? (
        <p className="composer-pinned-note">
          Fixado em <strong>{target.name}</strong> — o master não vai rotear a próxima linha.
          <button type="button" className="composer-unpin" onClick={() => choose("")}>
            <X size={12} aria-hidden="true" />
            Soltar
          </button>
        </p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="composer-attachments" aria-label="Arquivos anexados">
          {attachments.map((item) => (
            <li key={item.name} className="composer-attachment">
              <Paperclip size={12} aria-hidden="true" />
              <span className="composer-attachment-name">{item.name}</span>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => detach(item.name)}
                aria-label={`Remover ${item.name}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="composer" onSubmit={onSubmit} aria-busy={busy}>
        <label htmlFor={FIELD_ID} style={SR_ONLY}>
          {pinned ? `Mensagem para ${target.name}` : "Mensagem — o master escolhe o especialista"}
        </label>

        <textarea
          id={FIELD_ID}
          ref={fieldRef}
          className="composer-field"
          rows={1}
          value={input}
          placeholder={target.placeholder}
          aria-describedby={HINT_ID}
          autoComplete="off"
          spellCheck
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        <span id={HINT_ID} style={SR_ONLY}>
          Enter envia, Shift+Enter quebra a linha, Ctrl+Enter também envia.
        </span>

        <div className="composer-bar">
          {/*
            O anexo é REFERÊNCIA, não upload: o app é desktop e o arquivo já
            está no disco — o especialista o lê pela pasta do projeto. O que o
            anexo faz AGORA é rotear: mandar um .docx é dizer "documentos" sem
            precisar saber que existe um especialista de documentos.
          */}
          <input
            ref={fileRef}
            type="file"
            multiple
            style={SR_ONLY}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []).map((file) => ({
                name: file.name,
                mime: file.type,
                bytes: file.size
              }));
              if (picked.length > 0) attach(picked);
              // Zera para o MESMO arquivo poder ser anexado de novo depois de
              // removido — input de arquivo não dispara change para valor igual.
              event.target.value = "";
              fieldRef.current?.focus();
            }}
          />
          <button
            type="button"
            className="composer-icon-button"
            onClick={() => fileRef.current?.click()}
            title="Anexar arquivo — o nome decide o especialista; o conteúdo é lido da pasta do projeto"
            aria-label="Anexar arquivo"
          >
            <Paperclip size={14} aria-hidden="true" />
          </button>

          <div className="composer-picker" ref={pickerRef}>
            <button
              type="button"
              className="composer-picker-button"
              data-pinned={pinned ? "true" : "false"}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
              title={
                pinned
                  ? `A conversa passa para ${target.name} — equivale a /mode ${target.id}`
                  : "auto — o master escolhe o modo no primeiro input da conversa"
              }
            >
              <SpecialistGlyph id={pinned ? target.id : MASTER.id} size={13} />
              <span className="composer-picker-label">{pinned ? target.name : "auto"}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>

            {pickerOpen ? (
              <div className="composer-picker-menu" role="menu" aria-label="Fixar especialista">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!pinned}
                  className="composer-picker-item"
                  data-active={!pinned ? "true" : "false"}
                  onClick={() => choose("")}
                >
                  <SpecialistGlyph id={MASTER.id} />
                  <span className="composer-picker-name">auto</span>
                  <span className="composer-picker-tag">o master decide no 1º input</span>
                  {!pinned ? <Check size={13} aria-hidden="true" /> : null}
                </button>

                {catalog.map((specialist) => {
                  const active = specialist.id === specialistOverride;
                  return (
                    <button
                      key={specialist.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className="composer-picker-item"
                      data-active={active ? "true" : "false"}
                      onClick={() => choose(specialist.id)}
                    >
                      <SpecialistGlyph id={specialist.id} />
                      <span className="composer-picker-name">{specialist.name}</span>
                      <span className="composer-picker-tag">{specialist.tagline}</span>
                      {active ? <Check size={13} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="composer-bar-right">
            {input.length > COUNTER_AT ? (
              <span className="composer-count">{input.length.toLocaleString("pt-BR")}</span>
            ) : null}

            {busy ? (
              <button type="button" className="composer-send" data-stop="true" onClick={() => stop()} title="Parar a resposta">
                <Square size={12} strokeWidth={2.5} aria-hidden="true" />
                Parar
              </button>
            ) : (
              <button type="submit" className="composer-send" disabled={input.trim() === ""} title={sendTitle}>
                <ArrowUp size={14} strokeWidth={2.25} aria-hidden="true" />
                Enviar
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

export default Composer;
