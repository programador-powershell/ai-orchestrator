/**
 * A barra superior.
 *
 * Metade fixa (título, modelo, especialista, tema, configurações) e metade
 * dinâmica: o slot `#topbar-actions`, onde a superfície ativa injeta os botões
 * dela por portal. A superfície não desenha barra própria — se desenhasse, o app
 * teria duas barras empilhadas e a tela única viraria uma pilha de painéis.
 *
 * ESTA BARRA É TAMBÉM A BARRA DE TÍTULO DA JANELA. A janela principal sobe com
 * `decorations: false` (ver tauri.conf.json), ou seja, o Windows não desenha
 * moldura, nem os botões de minimizar/maximizar/fechar, nem a faixa de arrasto.
 * Tudo isso é responsabilidade daqui: sem os botões abaixo o aplicativo abre e
 * não fecha, e sem `data-tauri-drag-region` ele não sai do lugar da tela.
 */
import { ArrowUpCircle, Bot, Minus, Moon, Settings, Square, Sun, Wifi, WifiOff, X } from "lucide-react";
import type { UpdateTrack } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { MASTER, SPECIALIST_ICON, specialistById } from "../lib/specialists";
import { TopbarSlot } from "./TopbarActions";

/* ----------------------------- a atualização ----------------------------- */

/**
 * O que cada trilha custa a quem está usando o app.
 *
 * A divisão vem de `docs/atualizacao.md` e o texto é escrito do ponto de vista
 * da PESSOA, não do sistema: ela não precisa saber que existe um sidecar, mas
 * precisa saber se tem algo a fazer. É por isso que "dados" e "cérebro" dizem
 * explicitamente "nada a fazer" em vez de simplesmente não aparecerem — chegar
 * a versão nova e não haver instrução nenhuma é o que faz a pessoa procurar um
 * botão que não existe.
 */
const UPDATE_TRACK_LABEL: Record<UpdateTrack, string> = {
  data: "dados (especialistas, modelos, política): nada a fazer, já está valendo",
  gateway: "cérebro: nada a fazer, ele reinicia sozinho",
  ui: "interface: reabra o aplicativo",
  shell: "aplicativo: instale a versão nova"
};

/** Do que custa MENOS ao que custa MAIS — a leitura termina no que pede ação. */
const UPDATE_TRACK_ORDER: UpdateTrack[] = ["data", "gateway", "ui", "shell"];

/**
 * O verbo do chip: a ÚNICA coisa que a pessoa precisa fazer.
 *
 * Quando há mais de uma trilha pendente, vence a mais cara — quem precisa
 * instalar não precisa ser lembrado de reabrir, porque instalar já reabre.
 */
export function updateAction(tracks: UpdateTrack[]): string {
  if (tracks.includes("shell")) return "instalar";
  if (tracks.includes("ui")) return "reabrir";
  return "pronta";
}

/** O texto do `title`: o que muda, e o que fazer com cada parte. */
export function describeUpdate(version: string, tracks: UpdateTrack[]): string {
  const cabeca = version.trim() === "" ? "Atualização pronta." : `Atualização ${version} pronta.`;
  // Trilha desconhecida (gateway mais novo do que esta tela) é IGNORADA em vez
  // de virar "undefined" no aviso: o chip continua correto sobre o que ele
  // conhece, e o resto chega quando a interface for atualizada.
  const conhecidas = UPDATE_TRACK_ORDER.filter((track) => tracks.includes(track));
  if (conhecidas.length === 0) return `${cabeca} Nada a fazer agora.`;
  return `${cabeca} ${conhecidas.map((track) => UPDATE_TRACK_LABEL[track]).join(" · ")}.`;
}

/**
 * Os três controles da janela, na ordem que o Windows usa.
 *
 * `action` é o nome do método em `@tauri-apps/api/window` — a lista é fechada de
 * propósito, para que o nome do método não venha de nenhum lugar que não seja
 * este arquivo.
 */
const WINDOW_BUTTONS = [
  { action: "minimize", label: "Minimizar", Icon: Minus },
  { action: "toggleMaximize", label: "Maximizar ou restaurar", Icon: Square },
  { action: "close", label: "Fechar", Icon: X }
] as const;

type WindowAction = (typeof WINDOW_BUTTONS)[number]["action"];

/**
 * Aciona a janela nativa.
 *
 * O import é DINÂMICO pelo mesmo motivo do laboratório de avatares (Rail.tsx):
 * fora do Tauri o módulo não tem com quem falar, e carregá-lo no topo faria o
 * app quebrar no `import` durante o `pnpm dev` no navegador. Os botões nem
 * aparecem lá fora (ver `isTauri` abaixo), então este caminho só roda no
 * aplicativo de verdade.
 *
 * `close()` na janela `main` dispara o `CloseRequested` que o Rust intercepta —
 * é ele quem derruba o gateway, os MCP e os terminais antes de o processo sair
 * (ver src-tauri/src/lib.rs). Fechar por aqui NÃO é atalho para sair do app.
 */
async function runWindowAction(action: WindowAction) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  } catch (error) {
    // Só registra: um erro no console é melhor do que um botão que trava a
    // barra inteira com uma promessa rejeitada sem dono.
    console.error(`não foi possível ${action} a janela`, error);
  }
}

/**
 * Estamos dentro do aplicativo nativo?
 *
 * A checagem é a mesma do Rail.tsx. Ela decide se os controles de janela
 * aparecem: no navegador (dev com Vite) não existe janela nativa para minimizar
 * nem fechar, e um botão de fechar que não fecha é pior do que botão nenhum —
 * a pessoa clica, nada acontece, e ela conclui que o app travou.
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function Topbar() {
  const specialists = useApp((state) => state.specialists);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const models = useApp((state) => state.models);
  const activeModel = useApp((state) => state.activeModel);
  const sessions = useApp((state) => state.sessions);
  const session = useApp((state) => state.session);
  const theme = useApp((state) => state.theme);
  const status = useApp((state) => state.status);
  const updateAvailable = useApp((state) => state.updateAvailable);
  const updateVersion = useApp((state) => state.updateVersion);
  const updateTracks = useApp((state) => state.updateTracks);
  const setModel = useApp((state) => state.setModel);
  const setTheme = useApp((state) => state.setTheme);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);

  // Enquanto o master não decidiu nada, quem aparece é o próprio master: mentir
  // "Conversa" antes da primeira rota faria a barra prometer um especialista que
  // ainda não atendeu ninguém.
  const active = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;
  const Icon = SPECIALIST_ICON[active.id] ?? Bot;

  const title = sessions.find((item) => item.id === session)?.title ?? "Nova conversa";

  // O `value` do select precisa existir entre as options, senão o React reclama e
  // o campo mostra o primeiro modelo como se fosse o escolhido — mentira visual.
  const modelIsKnown = models.some((model) => model.id === activeModel);

  return (
    <header className="topbar" data-status={status}>
      <div className="topbar-left">
        <h1 className="topbar-title" title={title}>
          {title}
        </h1>

        <span className="specialist-chip" data-specialist={active.id} title={active.tagline}>
          <Icon size={14} aria-hidden />
          <span>{active.name}</span>
        </span>

        {status !== "ready" ? (
          <span className="topbar-status" data-status={status} role="status">
            {status === "connecting" ? <Wifi size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
            <span>{status === "connecting" ? "conectando…" : "offline"}</span>
          </span>
        ) : null}

        {/*
          O AVISO DE ATUALIZAÇÃO — e por que ele é um chip e não um modal.

          A atualização já foi baixada e verificada; ela não está esperando
          decisão nenhuma, está esperando a próxima abertura. Interromper o
          trabalho de quem está no meio de uma conversa para dizer isso troca um
          aviso por uma interrupção, e a pessoa aprende a fechar o aviso sem ler
          — que é como um aviso deixa de existir mesmo estando na tela.

          Não é botão de propósito: não há nada para clicar. Reabrir o
          aplicativo é decisão de quem está trabalhando, e o `title` diz
          exatamente o que muda e o que fazer com cada parte.
        */}
        {updateAvailable ? (
          <span
            className="update-chip"
            data-action={updateAction(updateTracks)}
            role="status"
            title={describeUpdate(updateVersion, updateTracks)}
          >
            <ArrowUpCircle size={13} aria-hidden />
            <span>
              {updateVersion === "" ? "atualização" : updateVersion} · {updateAction(updateTracks)}
            </span>
          </span>
        ) : null}
      </div>

      {/*
        A FAIXA DE ARRASTO — o que faz a janela sem moldura sair do lugar.
        São duas, uma de cada lado do slot, para que TODO espaço vazio da barra
        seja pegável e os botões da superfície continuem centralizados.

        Elas são elementos PRÓPRIOS, irmãos dos botões, e isso não é detalhe de
        estilo: o `data-tauri-drag-region` marca uma região de arrasto, e o
        script do Tauri decide pelo caminho do clique. Um botão dentro dessa
        região passa a competir com o arrasto — no modo `deep` o clique vira
        arrasto e o botão simplesmente não responde. Por isso a barra inteira
        NÃO leva o atributo: só estas faixas vazias levam.
      */}
      <div className="topbar-drag" data-tauri-drag-region aria-hidden="true" />

      {/* O que a superfície ativa injetar entra exatamente aqui. */}
      <TopbarSlot />

      <div className="topbar-drag" data-tauri-drag-region aria-hidden="true" />

      <div className="topbar-right">
        <label className="topbar-model">
          <span className="visually-hidden">Modelo</span>
          <select
            value={activeModel}
            disabled={models.length === 0}
            onChange={(event) => setModel(event.target.value)}
            title="Modelo usado no próximo envio"
          >
            {models.length === 0 ? <option value="">sem modelos disponíveis</option> : null}
            {activeModel !== "" && !modelIsKnown ? (
              <option value={activeModel}>{activeModel} (fora da lista)</option>
            ) : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {model.local ? " · local" : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="icon-button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "Usar o tema claro" : "Usar o tema escuro"}
          aria-label={theme === "dark" ? "Usar o tema claro" : "Usar o tema escuro"}
        >
          {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          title="Configurações (Ctrl+,)"
          aria-label="Configurações"
        >
          <Settings size={16} aria-hidden />
        </button>

        {/*
          Os controles da janela ficam FORA de qualquer faixa de arrasto (ver o
          comentário lá em cima) e só existem no aplicativo nativo.
        */}
        {isTauri() ? (
          <div className="window-controls">
            {WINDOW_BUTTONS.map(({ action, label, Icon }) => (
              <button
                key={action}
                type="button"
                className="icon-button window-button"
                data-action={action}
                onClick={() => void runWindowAction(action)}
                title={label}
                aria-label={label}
              >
                <Icon size={action === "toggleMaximize" ? 12 : 15} aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export default Topbar;
