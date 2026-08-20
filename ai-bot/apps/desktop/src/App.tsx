/**
 * A tela única.
 *
 * Não há abas nem menu de modos: a pessoa escreve no composer, o master decide
 * quem atende, e este shell se transforma — barra superior, barra lateral e a
 * cor de acento do app inteiro mudam junto com o especialista ativo.
 *
 * As superfícies são isoladas por `ErrorBoundary`. Uma superfície que quebra
 * mostra um cartão com o erro e nada mais: a conversa continua legível, o
 * composer continua funcionando, e ninguém perde o que escreveu porque um canvas
 * estourou um índice.
 */
import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  type CSSProperties,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode
} from "react";
import { AlertTriangle } from "lucide-react";
import { useApp } from "./lib/store";
import { MASTER, specialistById } from "./lib/specialists";
import { Topbar } from "./shell/Topbar";
import { Rail } from "./shell/Rail";
import { Stage } from "./shell/Stage";
import { ApprovalCard } from "./shell/ApprovalCard";
import { AskCard } from "./shell/AskCard";
import { SettingsPanel } from "./shell/SettingsPanel";
import { Composer } from "./shell/Composer";
import { StatusBar } from "./shell/StatusBar";
import { DelegationPopup } from "./shell/DelegationPopup";
import { NoticePopup } from "./shell/NoticePopup";

/** Igual ao carregador das superfícies: aceita `export default` ou o nomeado, e
 *  mantém o laboratório fora do bundle inicial — ele só abre quando alguém
 *  clica no bot. */
const AvatarLab: LazyExoticComponent<ComponentType<{ standalone?: boolean }>> = lazy(async () => {
  const mod = (await import("./avatar/AvatarLab")) as Record<string, unknown>;
  const found = (mod.default ?? mod.AvatarLab) as ComponentType<{ standalone?: boolean }> | undefined;
  if (found === undefined || found === null) {
    throw new Error("O módulo AvatarLab não exporta um componente React.");
  }
  return { default: found };
});

/**
 * O laboratório de avatares tem JANELA PRÓPRIA no aplicativo nativo
 * (`tauri.conf.json`, rótulo "avatars"), e essa janela carrega o mesmo
 * `index.html` com `?window=avatars`. Quando esse parâmetro está presente, o
 * documento é SÓ o laboratório: sem barra superior, sem barra lateral, sem
 * composer.
 *
 * Ler isto uma vez, fora do componente, é de propósito — o parâmetro não muda
 * durante a vida da janela, e reavaliá-lo a cada render abriria espaço para o
 * shell inteiro montar por um quadro antes de sumir.
 */
const IS_AVATAR_WINDOW =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("window") === "avatars";

/**
 * Diz ao Rust que a interface montou.
 *
 * É a contrapartida da TRILHA B da atualização (ver `docs/atualizacao.md` e
 * `src-tauri/src/overlay.rs`): quando a janela está carregando um bundle web
 * BAIXADO, a casca dá vinte segundos para esta chamada chegar. Sem ela, a pasta
 * vai para quarentena e o app reinicia com a interface embutida.
 *
 * O que isso salva é o modo de falha que nenhum hash pega: um bundle íntegro,
 * assinado, verificado — e que estoura no primeiro import. Do lado de fora, uma
 * janela em branco é indistinguível de uma janela lenta; esta linha é o que faz
 * a diferença entre as duas.
 *
 * Import dinâmico e falha silenciosa pelo mesmo motivo dos outros: no navegador
 * do `pnpm dev` não existe comando nenhum para chamar, e a ausência dele não
 * pode virar erro na tela.
 */
function reportUiHealth() {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("ui_ready"))
    .catch(() => {
      /* fora do Tauri não há casca para avisar */
    });
}

/* ----------------------------- ErrorBoundary ----------------------------- */

interface BoundaryProps {
  name: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

class SurfaceBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // O cartão mostra a mensagem para a pessoa; a pilha inteira fica no console
    // para quem for consertar. Engolir o erro aqui seria perder as duas coisas.
    console.error(`[ai-bot] ${this.props.name} quebrou`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="surface-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <div className="surface-error-body">
            <strong>{this.props.name} parou de responder.</strong>
            <p className="surface-error-message">{error.message}</p>
            <button type="button" className="button-secondary" onClick={() => this.setState({ error: null })}>
              Tentar de novo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* --------------------------------- shell --------------------------------- */

function App() {
  const specialists = useApp((state) => state.specialists);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const activeSurface = useApp((state) => state.activeSurface);
  const status = useApp((state) => state.status);
  const theme = useApp((state) => state.theme);
  const railOpen = useApp((state) => state.railOpen);
  const avatarLabOpen = useApp((state) => state.avatarLabOpen);
  const settingsOpen = useApp((state) => state.settingsOpen);
  const connect = useApp((state) => state.connect);

  const started = useRef(false);
  useEffect(() => {
    // O StrictMode monta e desmonta duas vezes em desenvolvimento; sem a trava, o
    // app abriria dois websockets e a sessão duplicaria antes da primeira linha.
    if (started.current) return;
    started.current = true;
    connect();
    reportUiHealth();
  }, [connect]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // O estado é lido na hora com getState: assim o listener é registrado uma
      // vez só e mesmo assim nunca decide com um valor velho de closure.
      const state = useApp.getState();

      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        state.setSettingsOpen(true);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === "n" || event.key === "N")) {
        event.preventDefault();
        state.newSession();
        return;
      }

      if (event.key === "Escape") {
        // Fecha uma coisa por vez, da mais recente para a mais antiga. O cartão de
        // aprovação NÃO entra nesta lista: autorizar ou recusar é uma decisão
        // explícita, não algo que se resolve por tecla de escape.
        if (state.avatarLabOpen) {
          event.preventDefault();
          state.setAvatarLabOpen(false);
          return;
        }
        if (state.settingsOpen) {
          event.preventDefault();
          state.setSettingsOpen(false);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const active = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;

  // A matiz do app inteiro sai daqui. É trocada de uma vez, sem `transition`:
  // animar uma custom property faz a transição encalhar no valor de partida e
  // TODOS os especialistas ficam com a cor do primeiro. Já aconteceu neste
  // projeto; não repetir.
  const shellStyle = { "--accent-h": String(active.hue) } as CSSProperties;

  // A janela do laboratório carrega o mesmo bundle e monta só o laboratório.
  // O tema vem junto porque ele é persistido no mesmo store — abrir o
  // personalizador em claro enquanto o app está em escuro faria a pessoa
  // escolher a cor do bot contra um fundo que não é o de uso.
  if (IS_AVATAR_WINDOW) {
    return (
      <div className="app-shell app-shell--lab" data-theme={theme} style={shellStyle}>
        <SurfaceBoundary name="O laboratório de avatares">
          <Suspense fallback={<div className="lab-loading">Abrindo o laboratório…</div>}>
            <AvatarLab standalone />
          </Suspense>
        </SurfaceBoundary>
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      data-theme={theme}
      data-specialist={active.id}
      data-surface={activeSurface}
      data-status={status}
      data-rail={railOpen ? "open" : "collapsed"}
      style={shellStyle}
    >
      <SurfaceBoundary name="A barra superior">
        <Topbar />
      </SurfaceBoundary>

      <div className="app-body">
        <SurfaceBoundary name="A barra lateral">
          <Rail />
        </SurfaceBoundary>

        <main className="app-stage">
          {/* A key remonta o boundary ao trocar de superfície: sem isso, um erro
              numa superfície deixaria o cartão de erro colado na próxima. */}
          <SurfaceBoundary key={activeSurface} name="A superfície">
            <Stage />
          </SurfaceBoundary>

          {/* O composer é IRMÃO da superfície, no fluxo da coluna do palco —
              padrão portado do AI-Orchestrator (.mode-viewport + .composer-wrap
              + .statusbar na mesma coluna). Flutuar por cima cobria o rodapé
              das telas de trabalho (saída da IDE, statusbar do editor). Fica
              FORA do boundary com key: trocar de superfície não pode remontar
              o campo e apagar o que a pessoa estava escrevendo. */}
          <SurfaceBoundary name="O campo de texto">
            <Composer />
          </SurfaceBoundary>
        </main>
      </div>

      {/* Abaixo do palco (e do composer, que mora dentro dele): o rodapé diz
          ONDE o próximo comando roda, e é a linha que a pessoa procura depois
          de escrever o pedido, não antes. */}
      <SurfaceBoundary name="O rodapé">
        <StatusBar />
      </SurfaceBoundary>

      {/* Não é interrupção: a delegação não pede permissão (ver o arquivo). Fica
          ao lado dos cartões, e não dentro deles, porque não bloqueia nada. */}
      <SurfaceBoundary name="O aviso de delegação">
        <DelegationPopup />
      </SurfaceBoundary>

      {/* Mesmo espírito da delegação: o bot CONTANDO onde o próximo passo vai
          rodar (container, ai-jail da VPS) — informa antes de fazer, não pede
          nada e some sozinho. */}
      <SurfaceBoundary name="O aviso de execução">
        <NoticePopup />
      </SurfaceBoundary>

      <SurfaceBoundary name="O pedido de aprovação">
        <ApprovalCard />
      </SurfaceBoundary>

      {/* Ao lado da aprovação, e não dentro dela: são interrupções diferentes
          (uma autoriza uma ferramenta, a outra responde ao supervisor) e cada
          uma se monta só quando o estado dela existe. */}
      <SurfaceBoundary name="A pergunta do supervisor">
        <AskCard />
      </SurfaceBoundary>

      {settingsOpen ? (
        <SurfaceBoundary name="As configurações">
          <SettingsPanel />
        </SurfaceBoundary>
      ) : null}

      {avatarLabOpen ? (
        <SurfaceBoundary name="O laboratório de avatares">
          <Suspense fallback={<div className="lab-loading">Abrindo o laboratório…</div>}>
            <AvatarLab />
          </Suspense>
        </SurfaceBoundary>
      ) : null}
    </div>
  );
}

export { App };
export default App;
