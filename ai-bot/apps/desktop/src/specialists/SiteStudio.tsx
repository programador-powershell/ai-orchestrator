/**
 * Estúdio do SITE ENTREGUE — a aba Site do estúdio de Design.
 *
 * O gesto do produto que esta aba fecha: o bot CONSTRÓI o projeto numa cópia
 * (o staging/sandbox do gateway), a promoção ENTREGA os arquivos ao workspace
 * da sessão no fechamento do turno — e o que foi entregue aparece AQUI,
 * renderizado, não como texto no chat. O contrato de entrada é o index.html
 * do projeto (e o CSS local que ele referencia), lido pela MESMA rota de
 * ferramenta da IDE (/v1/tools/call, fs.read): a tela nunca inventa conteúdo
 * nem busca a rede sozinha. Sem arquivo, o vazio é digno e diz o que vai
 * aparecer ali.
 *
 * SEGURANÇA (duas camadas, ver lib/siteEntregue): o HTML entregue é SANEADO
 * (script, handler on*, URL perigosa e <link> de rede saem do texto) e ainda
 * assim roda numa moldura com sandbox="" — a mesma decisão da prévia
 * replicada do CanvasSurface. Se um dia a prévia precisar de interação, o
 * caminho é abrir no navegador externo (plugin-opener), nunca afrouxar aqui.
 *
 * ATUALIZAÇÃO: a aba recarrega no FECHAMENTO BOM do turno, lido do dado real
 * (o carimbo `interrupted` que o done do gateway deixa na linha —
 * lib/store.fechamentosDeTurno). O sinal é o fechamento, e não a gravação,
 * de propósito: o que o sandbox constrói por proc.exec não deixa fs.write no
 * log, mas chega ao projeto na mesma promoção. No meio do turno nada
 * recarrega (o bot trabalha numa cópia; o fs.read de agora mostraria o
 * projeto de ANTES), e interrupção não recarrega (o staging foi descartado —
 * nada mudou). Replay/montagem só ancoram o contador, a guarda de turno-vivo
 * de sempre (FilesRail/EditorSurface).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Globe2, Hourglass, Import, RefreshCw, ShieldCheck } from "lucide-react";
import { fechamentosDeTurno, useApp } from "../lib/store";
import { chamarFerramenta } from "../lib/ide/ferramentas";
import { extractTokens } from "../lib/canvas";
import { cssLinksLocais, montarSiteEntregue, tituloDoSite, type EstiloDoSite } from "../lib/siteEntregue";
import type { DesignSnapshot } from "./CanvasSurface";

/** O contrato de entrada da aba: é o arquivo que um projeto web entregue tem. */
export const CAMINHO_DO_SITE = "index.html";

interface SiteCarregado {
  /** O index.html cru do projeto — é ele que o "Editar no canvas" importa. */
  html: string;
  /** html + CSS lidos, juntos: a fonte da extração local de tokens. */
  fonte: string;
  /** O documento saneado com o CSS inline — o que vai no srcdoc. */
  srcdoc: string;
  /** Quantas folhas locais entraram inline (para o rodapé contar a verdade). */
  estilos: number;
}

interface SiteStudioProps {
  /**
   * O "editar no canvas": recebe o snapshot (tokens + html) e é o DONO da
   * troca de aba/importação — o caminho de importar como nós (histórico,
   * seleção, persistência por sessão) já existe no CanvasSurface e não é
   * duplicado aqui.
   */
  aoImportar(snapshot: DesignSnapshot): void;
}

export function SiteStudio({ aoImportar }: SiteStudioProps): ReactNode {
  const status = useApp((state) => state.status);
  const session = useApp((state) => state.session);
  const busy = useApp((state) => state.busy);
  const lines = useApp((state) => state.lines);
  const replays = useApp((state) => state.replaysAssentados);

  const [site, setSite] = useState<SiteCarregado | null>(null);
  /** Por que não há site na tela — a frase real do gateway, nunca inventada. */
  const [motivo, setMotivo] = useState("");
  const [carregando, setCarregando] = useState(false);

  /**
   * Lê o site entregue: index.html primeiro, depois os <link> LOCAIS que ele
   * referencia (teto no lib/siteEntregue — cada folha é um POST). Resposta que
   * chega depois de a sessão trocar é descartada — a mesma regra do ideStore:
   * a leitura em voo da conversa anterior não pode pintar a tela da nova.
   */
  const carregar = useCallback(async () => {
    const sessao = useApp.getState().session ?? "";
    setCarregando(true);
    const leitura = await chamarFerramenta("fs.read", { path: CAMINHO_DO_SITE });
    if ((useApp.getState().session ?? "") !== sessao) return;
    if (!leitura.ok) {
      setSite(null);
      setMotivo(leitura.error);
      setCarregando(false);
      return;
    }
    const estilos: EstiloDoSite[] = [];
    for (const path of cssLinksLocais(leitura.output)) {
      const css = await chamarFerramenta("fs.read", { path });
      if ((useApp.getState().session ?? "") !== sessao) return;
      // Folha que falhou fica de fora: a página abre sem ela — melhor o layout
      // sem um CSS do que nenhuma página por causa de um link quebrado.
      if (css.ok) estilos.push({ path, css: css.output });
    }
    setSite({
      html: leitura.output,
      fonte: [leitura.output, ...estilos.map((estilo) => estilo.css)].join("\n"),
      srcdoc: montarSiteEntregue(leitura.output, estilos),
      estilos: estilos.length
    });
    setMotivo("");
    setCarregando(false);
  }, []);

  // O site é o do projeto DA SESSÃO: trocar de conversa troca (e zera) tudo.
  // A carga só sai com o gateway pronto — fs.read offline gastaria um erro
  // para dizer o que o vazio já diz.
  useEffect(() => {
    setSite(null);
    setMotivo("");
    if (status !== "ready" || !session) return;
    void carregar();
  }, [status, session, carregar]);

  /*
   * RECARGA NA ENTREGA: só o fechamento BOM do turno recarrega — o dado real
   * do done (carimbo `interrupted` na linha), nunca `busy` caindo, que o stop
   * derruba localmente antes de a verdade chegar. Montagem e flush de replay
   * (o contador `replaysAssentados` andou junto) só REANCORAM: reabrir uma
   * conversa velha cheia de turnos não dispara leitura nenhuma além da carga
   * inicial da montagem.
   */
  const fechamentos = useMemo(() => fechamentosDeTurno(lines), [lines]);
  const fechamentosVistos = useRef(-1);
  const replaysVistos = useRef(-1);
  useEffect(() => {
    const antes = fechamentosVistos.current;
    const replaysAntes = replaysVistos.current;
    fechamentosVistos.current = fechamentos.total;
    replaysVistos.current = replays;
    if (antes < 0 || replaysAntes !== replays) return;
    if (fechamentos.total <= antes) return;
    // Turno interrompido: o gateway descartou a cópia — o projeto visível não
    // mudou e reler agora seria um POST em troca de nada.
    if (fechamentos.ultimoInterrompido) return;
    if (useApp.getState().status !== "ready") return;
    void carregar();
  }, [fechamentos, replays, carregar]);

  /** O gesto do dono: construiu → viu no Design → edita em canvas. A extração
   *  é 100% local (lib/canvas/htmlTokens) sobre o html + CSS já lidos. */
  function importar(): void {
    if (!site) return;
    const tokens = extractTokens(site.fonte);
    aoImportar({
      url: "",
      title: tituloDoSite(site.html) || CAMINHO_DO_SITE,
      colors: tokens.colors.slice(0, 8).map(({ value, count }) => ({
        name: value,
        value,
        note: `${count}× no site entregue`
      })),
      variables: [],
      fonts: tokens.fonts.slice(0, 4).map((family) => ({ family, note: "" })),
      html: site.html
    });
  }

  return (
    <div className="site-studio">
      <div className="surface-toolbar">
        <Globe2 size={13} aria-hidden="true" />
        <span className="surface-title">site entregue — {CAMINHO_DO_SITE} do projeto da sessão</span>
        <span className="surface-toolbar-spacer" />
        {busy ? (
          // Honestidade visual: enquanto o turno vive, o que está na moldura é
          // a entrega ANTERIOR — o bot trabalha numa cópia.
          <span
            className="chip"
            title="O bot trabalha numa cópia do projeto — a entrega chega no fechamento do turno."
          >
            <Hourglass size={12} aria-hidden="true" />
            entrega no fim do turno
          </span>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={carregando}
          onClick={() => void carregar()}
          title="lê o index.html entregue de novo, pela rota de ferramenta"
        >
          <RefreshCw size={13} aria-hidden="true" />
          {carregando ? "lendo…" : "Recarregar"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!site}
          onClick={importar}
          title={
            site
              ? "importa o site entregue como nós editáveis do canvas — frame, paleta e tipografia"
              : "sem site entregue ainda — não há o que importar"
          }
        >
          <Import size={13} aria-hidden="true" />
          Editar no canvas
        </button>
      </div>

      <div className="surface-body site-body">
        {site ? (
          <div className="canvas-frame site-frame">
            {/* sandbox="" vazio DE PROPÓSITO (sem allow-scripts) — o mesmo
                raciocínio documentado na prévia replicada do CanvasSurface;
                aqui o texto ainda chega SANEADO (lib/siteEntregue). */}
            <iframe title="Site entregue da sessão" sandbox="" srcDoc={site.srcdoc} />
            <span className="canvas-caption">
              <ShieldCheck size={12} aria-hidden="true" />
              sandbox="" + sanitização · sem script, sem handler, sem acesso ao app
            </span>
          </div>
        ) : (
          <div className="surface-empty site-vazio">
            <Globe2 size={18} aria-hidden="true" />
            <p className="site-vazio-titulo">Nenhum site entregue ainda.</p>
            <p>
              Peça um projeto web ao bot: ele constrói numa cópia isolada e, quando o turno fechar
              bem, o <code>{CAMINHO_DO_SITE}</code> entregue aparece aqui renderizado numa moldura
              sem scripts — pronto para o «Editar no canvas».
            </p>
            {motivo !== "" ? <p className="site-motivo">{motivo}</p> : null}
          </div>
        )}
      </div>

      <div className="surface-status">
        <span>
          <b>{CAMINHO_DO_SITE}</b>
        </span>
        <span>{site ? `${site.estilos} folha(s) de estilo inline` : "sem entrega ainda"}</span>
        <span>{site ? "moldura isolada, sem script" : "recarrega sozinha quando o turno entregar"}</span>
      </div>
    </div>
  );
}

export default SiteStudio;
