/**
 * O LABORATÓRIO DE AVATARES — abre pelo ícone do AI-BOT na barra lateral.
 *
 * Aqui se personaliza o retrato de cada bot especialista. As mudanças entram no
 * store AO VIVO e não há botão de salvar: o store já persiste, e um "salvar" que
 * não faz nada além do que a digitação já fez só ensina o usuário a desconfiar
 * do que vê.
 *
 * O CSS mora num `<style>` local porque este recorte do produto é fechado em
 * três arquivos; as classes são todas prefixadas com `alab-` e leem os tokens do
 * app (`--panel`, `--line`, `--ink`, ...), então tema claro e escuro saem de
 * graça. Nenhuma transição é declarada sobre custom property — é a armadilha já
 * paga neste projeto, onde animar `--accent-h` congelava o matiz de todo mundo
 * no primeiro valor.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Download, RotateCcw, Shuffle, X } from "lucide-react";
import { MASTER_ID, type Avatar, type SpecialistDefinition } from "@ai-bot/contracts";
import { useApp } from "../lib/store";
import { FALLBACK_SPECIALISTS, MASTER } from "../lib/specialists";
import { BotAvatar } from "./BotAvatar";
import {
  ACCESSORIES,
  EYES,
  MOTIONS,
  MOUTHS,
  SHAPES,
  avatarToSvg,
  randomAvatar,
  type AvatarOption
} from "./params";

/**
 * Os três tamanhos reais, lado a lado.
 *
 * 20px não é capricho: é o tamanho que aparece em TODA linha da conversa. Um
 * retrato que fica lindo em 96 e vira borrão em 20 é um retrato inútil, e o
 * único jeito honesto de descobrir isso é olhando os três juntos.
 */
const PREVIEW_SIZES: readonly { size: number; caption: string }[] = [
  { size: 96, caption: "96 px — este laboratório" },
  { size: 32, caption: "32 px — barra lateral" },
  { size: 20, caption: "20 px — linha da conversa" }
];

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface AvatarLabProps {
  /**
   * `true` quando o laboratório é a JANELA inteira (o aplicativo nativo abre
   * uma janela própria, `?window=avatars`). Nesse modo não há backdrop, não há
   * Esc para fechar — a janela do sistema já tem botão de fechar — e o
   * laboratório não depende de `avatarLabOpen`, que é estado da janela
   * principal e não chega até aqui.
   */
  standalone?: boolean;
}

export function AvatarLab({ standalone = false }: AvatarLabProps = {}) {
  const openState = useApp((s) => s.avatarLabOpen);
  const open = standalone || openState;
  const setOpen = useApp((s) => s.setAvatarLabOpen);
  const avatars = useApp((s) => s.avatars);
  const setAvatar = useApp((s) => s.setAvatar);
  const resetAvatar = useApp((s) => s.resetAvatar);
  const catalog = useApp((s) => s.specialists);

  const [selected, setSelected] = useState<string>(MASTER_ID);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  const close = useCallback(() => {
    if (standalone) return; // a janela do sistema fecha sozinha
    setOpen(false);
  }, [setOpen, standalone]);

  const bots = useMemo<SpecialistDefinition[]>(() => {
    // Antes do `ready` do gateway a lista chega vazia; o catálogo local existe
    // exatamente para o laboratório abrir offline.
    const list = catalog.length > 0 ? catalog : FALLBACK_SPECIALISTS;
    return [MASTER, ...list.filter((s) => s.id !== MASTER_ID)];
  }, [catalog]);

  // Sem efeito para corrigir `selected`: se o id sumir do catálogo (troca de
  // versão do gateway, por exemplo), o fallback acontece na leitura e pronto.
  const current = bots.find((b) => b.id === selected) ?? MASTER;
  const custom = avatars[current.id];
  const avatar = custom ?? current.avatar;

  /* --------------------------- foco preso e Esc -------------------------- */
  useEffect(() => {
    // Prender foco e escutar Esc só faz sentido no modal: na janela própria não
    // há nada "atrás" para proteger, e roubar o Tab do usuário numa janela
    // inteira é bloquear a navegação do sistema.
    if (!open || standalone) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    node?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Devolve o foco a quem abriu — quem navega por teclado não pode ser
      // largado no começo do documento ao fechar a janela.
      previous?.focus();
    };
  }, [open, close, standalone]);

  /* ------------------------------- edição -------------------------------- */

  const apply = useCallback(
    (patch: Partial<Avatar>) => {
      // `custom: true` é o que distingue "o usuário mexeu" de "veio do catálogo",
      // e é o que faz "Restaurar padrão" ter o que restaurar.
      setAvatar(current.id, { ...avatar, ...patch, custom: true });
    },
    [avatar, current.id, setAvatar]
  );

  const draw = useCallback(() => {
    // O relógio é a fonte de entropia do BOTÃO; o DESENHO segue determinístico a
    // partir da semente sorteada. O matiz é preservado porque é a identidade do
    // especialista, não enfeite.
    const seed = Date.now() % 100000;
    setAvatar(current.id, { ...randomAvatar(seed, avatar.hue), custom: true });
  }, [avatar.hue, current.id, setAvatar]);

  const download = useCallback(() => {
    const blob = new Blob([avatarToSvg(avatar, 512)], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `avatar-${current.id}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revogar no próximo tique: revogar na mesma linha do clique corta o
    // download em algumas versões do WebView.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [avatar, current.id]);

  if (!open) return null;

  const tint = {
    "--alab-h": String(avatar.hue),
    "--alab-s": `${avatar.saturation}%`
  } as CSSProperties;

  const panel = (
    <div
      className="alab"
      data-standalone={standalone || undefined}
      style={tint}
      // Na janela própria o painel É a janela: chamar isso de diálogo modal
      // faria o leitor de tela anunciar uma camada que não existe.
      role={standalone ? undefined : "dialog"}
      aria-modal={standalone ? undefined : true}
      aria-labelledby={headingId}
      tabIndex={-1}
      ref={dialogRef}
    >
      <header className="alab-head">
        <BotAvatar avatar={avatar} size={26} />
        <div className="alab-head-text">
          <h2 className="alab-title" id={headingId}>
            Laboratório de avatares
          </h2>
          <p className="alab-sub">Personalize o retrato de cada especialista</p>
        </div>
        {/* Quem fecha a janela do sistema é a moldura do sistema — um "X" aqui
            seria um botão que não faz nada. */}
        {standalone ? null : (
          <button type="button" className="alab-icon-btn" onClick={close} aria-label="Fechar laboratório">
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="alab-body">
        <nav className="alab-list" aria-label="Especialistas">
          {bots.map((bot) => {
            const botAvatar = avatars[bot.id] ?? bot.avatar;
            return (
              <button
                key={bot.id}
                type="button"
                className="alab-bot"
                data-on={bot.id === current.id}
                aria-current={bot.id === current.id}
                onClick={() => setSelected(bot.id)}
              >
                <BotAvatar avatar={botAvatar} size={26} />
                <span className="alab-bot-text">
                  <span className="alab-bot-name">{bot.name}</span>
                  <span className="alab-bot-tag">{bot.tagline}</span>
                </span>
                {avatars[bot.id] ? <span className="alab-dot" title="Personalizado" /> : null}
              </button>
            );
          })}
        </nav>

        <section className="alab-stage" aria-label="Prévia">
          <div className="alab-sizes">
            {PREVIEW_SIZES.map((preview) => (
              <figure className="alab-size" key={preview.size}>
                <div className="alab-size-box" style={{ minHeight: preview.size }}>
                  <BotAvatar avatar={avatar} size={preview.size} title={`Avatar de ${current.name}`} />
                </div>
                <figcaption className="alab-size-cap">{preview.caption}</figcaption>
              </figure>
            ))}
          </div>

          {/* A prova final: o retrato de 20px na frente de uma linha de texto,
              que é onde ele vai viver 99% do tempo. */}
          <div className="alab-line" aria-hidden="true">
            <BotAvatar avatar={avatar} size={20} />
            <span className="alab-line-text">
              <b>{current.name}</b> — {current.placeholder}
            </span>
          </div>
        </section>

        <aside className="alab-controls" aria-label="Controles do avatar">
          <Segmented label="Forma" options={SHAPES} value={avatar.shape} onChange={(v) => apply({ shape: v })} />
          <Segmented label="Olhos" options={EYES} value={avatar.eyes} onChange={(v) => apply({ eyes: v })} />
          <Segmented label="Boca" options={MOUTHS} value={avatar.mouth} onChange={(v) => apply({ mouth: v })} />
          <Segmented
            label="Acessório"
            options={ACCESSORIES}
            value={avatar.accessory}
            onChange={(v) => apply({ accessory: v })}
          />
          <Segmented
            label="Movimento"
            options={MOTIONS}
            value={avatar.motion}
            onChange={(v) => apply({ motion: v })}
          />

          <Slider
            label="Matiz"
            min={0}
            max={359}
            value={avatar.hue}
            suffix="°"
            onChange={(v) => apply({ hue: v })}
          />
          <Slider
            label="Saturação"
            min={0}
            max={100}
            value={avatar.saturation}
            suffix="%"
            onChange={(v) => apply({ saturation: v })}
          />

          <div className="alab-field">
            <span className="alab-label">Semente</span>
            <div className="alab-seed">
              <input
                className="alab-num"
                type="number"
                min={0}
                max={99999}
                value={avatar.seed}
                aria-label="Semente do avatar"
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  apply({ seed: Number.isFinite(next) ? Math.min(Math.max(next, 0), 99999) : 0 });
                }}
              />
              <button type="button" className="alab-btn" onClick={draw}>
                <Shuffle size={13} aria-hidden="true" />
                Sortear
              </button>
            </div>
            <p className="alab-hint">A semente decide os detalhes pequenos — mesma semente, mesmo desenho.</p>
          </div>
        </aside>
      </div>

      <footer className="alab-foot">
        <span className="alab-status">
          {custom ? "Personalizado — as mudanças já estão salvas." : "Usando o retrato padrão do catálogo."}
        </span>
        <button
          type="button"
          className="alab-btn"
          onClick={() => resetAvatar(current.id)}
          disabled={!custom}
        >
          <RotateCcw size={13} aria-hidden="true" />
          Restaurar padrão
        </button>
        <button type="button" className="alab-btn alab-btn-primary" onClick={download}>
          <Download size={13} aria-hidden="true" />
          Baixar SVG
        </button>
      </footer>
    </div>
  );

  if (standalone) {
    return (
      <>
        <style>{LAB_CSS}</style>
        {panel}
      </>
    );
  }

  return (
    <div
      className="alab-backdrop"
      onMouseDown={(event) => {
        // Só o clique que NASCE no backdrop fecha: arrastar um range e soltar
        // fora da janela não pode fechar o laboratório no meio do ajuste.
        if (event.target === event.currentTarget) close();
      }}
    >
      <style>{LAB_CSS}</style>
      {panel}
    </div>
  );
}

/* ------------------------------- controles ------------------------------- */

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: readonly AvatarOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="alab-field">
      <span className="alab-label">{label}</span>
      <div className="alab-seg" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="alab-seg-btn"
            data-on={option.value === value}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  suffix,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="alab-field">
      <label className="alab-label" htmlFor={id}>
        {label}
        <span className="alab-value">
          {Math.round(value)}
          {suffix}
        </span>
      </label>
      <input
        id={id}
        className="alab-range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/* ---------------------------------- CSS ---------------------------------- */

const LAB_CSS = `
.alab-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(16,15,13,.46);backdrop-filter:blur(3px);animation:alab-fade var(--t-fast,180ms) var(--swift,ease)}
@keyframes alab-fade{from{opacity:0}to{opacity:1}}
.alab{--alab-tint:hsl(var(--alab-h,158) var(--alab-s,62%) 44%);display:flex;flex-direction:column;width:min(1000px,100%);max-height:100%;background:var(--panel,#fff);color:var(--ink,#26241f);border:1px solid var(--line,rgba(30,28,24,.1));border-radius:var(--radius-xl,24px);box-shadow:var(--shadow-float,0 10px 30px rgba(0,0,0,.4));overflow:hidden;animation:alab-rise var(--t-base,300ms) var(--spring-soft,ease)}
@keyframes alab-rise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
.alab:focus{outline:none}
/* Janela própria: sem moldura flutuante, sem subir na entrada — o painel ocupa
   a janela do sistema inteira e quem anima a abertura é o gerenciador dela. */
.alab[data-standalone]{width:100%;height:100%;max-height:none;border:0;border-radius:0;box-shadow:none;animation:none;background:var(--bg,#fbfbf9)}
.alab-head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid var(--line,rgba(30,28,24,.1))}
.alab-head-text{flex:1;min-width:0}
.alab-title{margin:0;font-size:var(--fs-title,20px);font-weight:600;letter-spacing:-.01em}
.alab-sub{margin:1px 0 0;font-size:var(--fs-small,11.5px);color:var(--muted,#7a766d)}
.alab-icon-btn{display:grid;place-items:center;width:30px;height:30px;border-radius:var(--radius-sm,10px);border:1px solid transparent;background:transparent;color:var(--muted,#7a766d);cursor:pointer;transition:background var(--t-fast,180ms) var(--swift,ease),color var(--t-fast,180ms) var(--swift,ease)}
.alab-icon-btn:hover{background:var(--hover,#ececeb);color:var(--ink,#26241f)}
.alab-body{flex:1;min-height:0;display:grid;grid-template-columns:216px minmax(0,1fr) 284px}
.alab-list{overflow:auto;padding:8px;border-right:1px solid var(--line,rgba(30,28,24,.1));display:flex;flex-direction:column;gap:2px}
.alab-bot{display:flex;align-items:center;gap:9px;padding:7px 8px;border:1px solid transparent;border-radius:var(--radius-md,14px);background:transparent;color:inherit;text-align:left;cursor:pointer;transition:background var(--t-fast,180ms) var(--swift,ease),border-color var(--t-fast,180ms) var(--swift,ease)}
.alab-bot:hover{background:var(--hover,#ececeb)}
.alab-bot[data-on=true]{background:var(--panel-2,#f4f4f1);border-color:var(--line-strong,rgba(30,28,24,.16))}
.alab-bot-text{flex:1;min-width:0;display:flex;flex-direction:column}
.alab-bot-name{font-size:var(--fs-body,13px);font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.alab-bot-tag{font-size:var(--fs-micro,10px);color:var(--muted,#7a766d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.alab-dot{width:6px;height:6px;border-radius:50%;background:var(--alab-tint);flex:none}
.alab-stage{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:20px;background:var(--canvas,#f0f0ec);overflow:auto}
.alab-sizes{display:flex;align-items:flex-end;gap:22px}
.alab-size{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
.alab-size-box{display:grid;place-items:center;padding:12px;border-radius:var(--radius-lg,20px);background:var(--panel,#fff);border:1px solid var(--line,rgba(30,28,24,.1));box-shadow:var(--shadow-soft,0 1px 2px rgba(0,0,0,.06))}
.alab-size-cap{font-size:var(--fs-micro,10px);color:var(--muted,#7a766d);text-transform:uppercase;letter-spacing:.06em}
.alab-line{display:flex;align-items:center;gap:8px;max-width:100%;padding:9px 12px;border-radius:var(--radius-md,14px);background:var(--panel,#fff);border:1px solid var(--line,rgba(30,28,24,.1))}
.alab-line-text{font-size:var(--fs-body,13px);color:var(--muted,#7a766d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alab-line-text b{color:var(--ink,#26241f);font-weight:550}
.alab-controls{overflow:auto;padding:14px;border-left:1px solid var(--line,rgba(30,28,24,.1));display:flex;flex-direction:column;gap:15px}
.alab-field{display:flex;flex-direction:column;gap:6px}
.alab-label{display:flex;align-items:center;justify-content:space-between;font-size:var(--fs-eyebrow,9px);text-transform:uppercase;letter-spacing:.1em;color:var(--faint,#a8a49a)}
.alab-value{font-family:var(--font-mono,monospace);font-size:var(--fs-micro,10px);color:var(--muted,#7a766d);letter-spacing:0}
.alab-hint{margin:2px 0 0;font-size:var(--fs-micro,10px);color:var(--faint,#a8a49a);line-height:1.4}
.alab-seg{display:flex;flex-wrap:wrap;gap:4px}
.alab-seg-btn{font:inherit;font-size:var(--fs-small,11.5px);padding:5px 9px;border-radius:var(--radius-xs,8px);border:1px solid var(--line,rgba(30,28,24,.1));background:var(--panel-2,#f4f4f1);color:var(--muted,#7a766d);cursor:pointer;transition:background var(--t-fast,180ms) var(--swift,ease),color var(--t-fast,180ms) var(--swift,ease),border-color var(--t-fast,180ms) var(--swift,ease)}
.alab-seg-btn:hover{background:var(--hover,#ececeb);color:var(--ink,#26241f)}
.alab-seg-btn[data-on=true]{background:var(--alab-tint);border-color:var(--alab-tint);color:#fff}
.alab-range{width:100%;accent-color:var(--alab-tint);cursor:pointer}
.alab-seed{display:flex;gap:6px}
.alab-num{flex:1;min-width:0;font:inherit;font-family:var(--font-mono,monospace);font-size:var(--fs-small,11.5px);padding:5px 8px;border-radius:var(--radius-xs,8px);border:1px solid var(--line,rgba(30,28,24,.1));background:var(--panel-2,#f4f4f1);color:var(--ink,#26241f)}
.alab-num:focus-visible,.alab-range:focus-visible,.alab-seg-btn:focus-visible,.alab-bot:focus-visible,.alab-btn:focus-visible,.alab-icon-btn:focus-visible{outline:2px solid var(--alab-tint);outline-offset:1px}
.alab-foot{display:flex;align-items:center;gap:8px;padding:11px 14px;border-top:1px solid var(--line,rgba(30,28,24,.1));background:var(--panel-2,#f4f4f1)}
.alab-status{flex:1;min-width:0;font-size:var(--fs-small,11.5px);color:var(--muted,#7a766d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alab-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:var(--fs-small,11.5px);padding:6px 11px;border-radius:var(--radius-sm,10px);border:1px solid var(--line-strong,rgba(30,28,24,.16));background:var(--panel,#fff);color:var(--ink,#26241f);cursor:pointer;transition:background var(--t-fast,180ms) var(--swift,ease),opacity var(--t-fast,180ms) var(--swift,ease)}
.alab-btn:hover:not(:disabled){background:var(--hover,#ececeb)}
.alab-btn:disabled{opacity:.45;cursor:default}
.alab-btn-primary{background:var(--alab-tint);border-color:var(--alab-tint);color:#fff}
.alab-btn-primary:hover:not(:disabled){background:var(--alab-tint);filter:brightness(1.08)}
@media (max-width:920px){.alab-body{grid-template-columns:180px minmax(0,1fr)}.alab-controls{grid-column:1 / -1;border-left:0;border-top:1px solid var(--line,rgba(30,28,24,.1))}}
@media (prefers-reduced-motion:reduce){.alab-backdrop,.alab{animation:none}}
`;
