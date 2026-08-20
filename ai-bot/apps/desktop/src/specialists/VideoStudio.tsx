/**
 * Estúdio de VÍDEO — a aba Vídeo do estúdio de Design (porta a aba de vídeo
 * do AI-Orchestrator, modes/DesignView.tsx, para a superfície do AI-BOT).
 *
 * O que mora aqui é só o que precisa de DOM: o <video> do preview, o
 * transporte (playhead por requestAnimationFrame escrevendo em refs, nunca em
 * estado — 60 setState/s re-renderizariam a superfície inteira), a régua e o
 * teclado. Toda decisão de corte vive em ../lib/video e é coberta por testes
 * de Node; a superfície só FIA o gesto na operação imutável.
 *
 * DECISÃO DE SEGURANÇA DA CASA (não negociável): esta UI NÃO executa ffmpeg.
 * O orquestrador rodava o comando pelo terminal local; aqui o export MONTA o
 * comando (lista de args, lib/video/ffmpegArgs) e o envia ao COMPOSER via
 * setInput — a pessoa lê, ajusta e dispara, e mesmo então o ffmpeg só roda no
 * turno do agente, atrás do portão de aprovação. Dois pares de olhos antes de
 * qualquer processo: o de quem exporta e o de quem aprova.
 *
 * O store é de módulo (padrão do useCanvasStudio, no CanvasSurface): o projeto
 * de vídeo sobrevive à troca de aba Canvas⇄Vídeo — desmontar a superfície não
 * pode custar a timeline. Os object URLs importados vivem nele e morrem com a
 * sessão do app; por isso o export usa os NOMES dos arquivos e pede no texto
 * que a pessoa confirme a pasta — blob: não aponta para nada fora do navegador.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  FileVideo,
  Image as ImageIcon,
  Pause,
  Play,
  Plus,
  Scissors,
  Send,
  SlidersHorizontal,
  Trash2,
  Type
} from "lucide-react";
import type { ConversationLine } from "@aibot/contracts";
import {
  addClip,
  buildFfmpegArgs,
  buildTicks,
  clipAt,
  clipDuration,
  clipOffsets,
  formatFfmpegArgs,
  formatTime,
  moveClip,
  removeClip,
  splitClipAt,
  totalDuration,
  trimClip
} from "../lib/video";
import type { LogoOverlay, TextOverlay, TransitionKind, VideoClip, VideoMedia } from "../lib/video";
import { useApp } from "../lib/store";

/* ------------------------------ o store ---------------------------------- */

export interface StudioMedia extends VideoMedia {
  /**
   * URL de preview (URL.createObjectURL) — só vale nesta sessão do app e
   * NUNCA entra no comando ffmpeg: lá vão os nomes reais dos arquivos.
   */
  url: string;
}

/**
 * Ids com contador de série + Date: o contador garante unicidade na sessão
 * (dois cliques no mesmo milissegundo — o caso normal num teste — produziriam
 * ids iguais só com Date.now(), a mesma armadilha corrigida nos stencils).
 */
let serie = 0;
const uid = () => `vid${(serie += 1).toString(36)}-${Date.now().toString(36)}`;

interface VideoStudioState {
  media: StudioMedia[];
  clips: VideoClip[];
  texts: TextOverlay[];
  logos: LogoOverlay[];
  selectedClipId: string | null;
  /** Incrementado a cada remoção de clipe — o player reseta o transporte,
   *  senão o playhead aponta para um tempo que não existe mais. */
  playbackEpoch: number;
  /** Importa um arquivo local: vídeo vira mídia+clipe; imagem vira mídia de
   *  logo. A duração vem de um <video> descartável (probe de metadado). */
  importarArquivo(file: File): void;
  adicionarMidia(item: StudioMedia): void;
  adicionarClipe(mediaId: string): void;
  dividirEm(tempo: number): void;
  aparar(id: string, patch: { start?: number; end?: number }): void;
  patchClipe(id: string, patch: Partial<Pick<VideoClip, "transition" | "transitionDuration">>): void;
  removerClipe(id: string): void;
  mover(id: string, para: number): void;
  selecionarClipe(id: string | null): void;
  adicionarTexto(): void;
  patchTexto(id: string, patch: Partial<TextOverlay>): void;
  removerTexto(id: string): void;
  adicionarLogo(mediaId: string): void;
  patchLogo(id: string, patch: Partial<LogoOverlay>): void;
  removerLogo(id: string): void;
}

export const useVideoStudio = create<VideoStudioState>((set, get) => ({
  media: [],
  clips: [],
  texts: [],
  logos: [],
  selectedClipId: null,
  playbackEpoch: 0,
  importarArquivo: (file) => {
    // O object URL alimenta só o <video> do preview. Guardado com o nome real
    // porque o export precisa do NOME — o blob: morre com a sessão.
    const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
    const id = uid();
    if (file.type.startsWith("image/")) {
      // Imagem não tem linha do tempo: entra como mídia de logo, e o painel
      // de sobreposição é quem a coloca sobre o vídeo.
      get().adicionarMidia({ id, name: file.name, kind: "image", duration: 0, url });
      return;
    }
    const commit = (duration: number) => {
      get().adicionarMidia({ id, name: file.name, kind: "video", duration, url });
      // O vídeo importado já entra na timeline: importar sem ver nada
      // acontecer parece importação falhada.
      get().adicionarClipe(id);
    };
    // A duração vem de um <video> descartável — é o navegador que sabe ler o
    // contêiner. Sem metadado legível cai em 10s: placeholder honesto que o
    // aparo corrige (a mídia sem duração conhecida nunca ESTICA um clipe).
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      commit(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 10);
      probe.removeAttribute("src");
    };
    probe.onerror = () => commit(10);
    probe.src = url;
  },
  adicionarMidia: (item) => set((state) => ({ media: [...state.media, item] })),
  adicionarClipe: (mediaId) =>
    set((state) => {
      const alvo = state.media.find((item) => item.id === mediaId);
      if (!alvo) return {};
      const clips = addClip(state.clips, alvo, uid());
      return clips === state.clips ? {} : { clips };
    }),
  dividirEm: (tempo) =>
    set((state) => {
      const clips = splitClipAt(state.clips, tempo, uid());
      return clips === state.clips ? {} : { clips };
    }),
  aparar: (id, patch) =>
    set((state) => {
      const clip = state.clips.find((item) => item.id === id);
      const fonte = clip ? state.media.find((item) => item.id === clip.mediaId) : undefined;
      const clips = trimClip(state.clips, id, patch, fonte?.duration ?? 0);
      return clips === state.clips ? {} : { clips };
    }),
  patchClipe: (id, patch) =>
    set((state) => ({
      clips: state.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip))
    })),
  removerClipe: (id) =>
    set((state) => ({
      clips: removeClip(state.clips, id),
      selectedClipId: state.selectedClipId === id ? null : state.selectedClipId,
      playbackEpoch: state.playbackEpoch + 1
    })),
  mover: (id, para) =>
    set((state) => {
      const clips = moveClip(state.clips, id, para);
      return clips === state.clips ? {} : { clips };
    }),
  selecionarClipe: (selectedClipId) => set({ selectedClipId }),
  adicionarTexto: () =>
    set((state) => ({
      texts: [
        ...state.texts,
        { id: uid(), text: "Texto", x: 48, y: 48, fontSize: 36, color: "#ffffff", from: 0, to: 5 }
      ]
    })),
  patchTexto: (id, patch) =>
    set((state) => ({ texts: state.texts.map((item) => (item.id === id ? { ...item, ...patch } : item)) })),
  removerTexto: (id) => set((state) => ({ texts: state.texts.filter((item) => item.id !== id) })),
  adicionarLogo: (mediaId) =>
    set((state) => {
      const alvo = state.media.find((item) => item.id === mediaId && item.kind === "image");
      if (!alvo) return {};
      return { logos: [...state.logos, { id: uid(), mediaId, x: 24, y: 24, from: 0, to: 5 }] };
    }),
  patchLogo: (id, patch) =>
    set((state) => ({ logos: state.logos.map((item) => (item.id === id ? { ...item, ...patch } : item)) })),
  removerLogo: (id) => set((state) => ({ logos: state.logos.filter((item) => item.id !== id) }))
}));

/**
 * Quadro nominal do preview posicional. O estúdio não conhece a resolução
 * real de cada mídia (o metadado pode nem carregar), então os overlays são
 * posicionados em pixels DESTE quadro de referência e o preview os projeta em
 * porcentagem — mostra ONDE o texto/logo cai, não o tamanho exato do glifo.
 */
export const QUADRO_W = 1280;
export const QUADRO_H = 720;

/* -------------------------- o trabalho do bot ----------------------------- */

/**
 * Uma operação de vídeo que o BOT executou nesta conversa — o conserto
 * anti-casca da aba Vídeo. O Design tem as ferramentas `video.probe/trim/
 * concat/text/export` (rodadas pelo host, atrás do portão de aprovação), e
 * até aqui a aba não reagia a nada disso: o bot cortava e exportava e a tela
 * seguia como se nada tivesse acontecido. A âncora é a mesma das outras
 * janelas — o `tool.result` nas linhas da conversa; a tela mostra, não
 * inventa.
 */
export interface TrabalhoDeVideo {
  /** linha+call — estável entre renders, único mesmo com replay. */
  key: string;
  tool: string;
  ok: boolean;
  /** O(s) arquivo(s) de entrada, dos argumentos da chamada. */
  entrada: string;
  /** O arquivo de saída (trim/concat/text/export); "" para o probe. */
  saida: string;
  /** A primeira linha do resultado (ok) ou o erro — o resumo honesto. */
  resumo: string;
}

function textoDoArg(args: unknown, chave: string): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const valor = (args as Record<string, unknown>)[chave];
  if (typeof valor === "string") return valor.trim();
  if (Array.isArray(valor)) {
    return valor.filter((item): item is string => typeof item === "string").join(", ");
  }
  return "";
}

/**
 * As operações `video.*` da conversa, na ordem em que aconteceram — as que
 * FALHARAM também entram, com o erro: um export que morreu no meio é
 * exatamente o que a pessoa precisa ver para pedir de novo. Só chamada COM
 * resultado vira linha (o que está em curso ainda não tem o que mostrar).
 */
export function coletarTrabalhoDoBot(lines: ConversationLine[]): TrabalhoDeVideo[] {
  const chamadaPorCall = new Map<string, { tool: string; args: unknown }>();
  for (const line of lines) {
    for (const call of line.toolCalls ?? []) {
      if (call.tool.startsWith("video.")) chamadaPorCall.set(call.callId, { tool: call.tool, args: call.args });
    }
  }

  const out: TrabalhoDeVideo[] = [];
  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      const chamada = chamadaPorCall.get(result.callId);
      // O tool do result é a fonte quando presente; a chamada cobre gateway
      // antigo que não repete o campo no resultado.
      const tool = result.tool !== "" ? result.tool : chamada?.tool ?? "";
      if (!tool.startsWith("video.")) continue;
      const texto = result.ok ? result.output ?? "" : result.error ?? "";
      out.push({
        key: `${line.id}:${result.callId}`,
        tool,
        ok: result.ok,
        entrada: textoDoArg(chamada?.args, "path") || textoDoArg(chamada?.args, "paths"),
        saida: textoDoArg(chamada?.args, "output"),
        resumo: (texto.split("\n")[0] ?? "").trim()
      });
    }
  }
  // As últimas oito bastam: a aba é um estúdio, não um log — o registro
  // integral continua no painel de ferramentas da conversa.
  return out.slice(-8);
}

/* ------------------------------ a superfície ------------------------------ */

export function VideoStudio(): ReactNode {
  const setInput = useApp((state) => state.setInput);
  const lines = useApp((state) => state.lines);

  // A reação da aba ao trabalho do PRÓPRIO bot: as operações video.* desta
  // conversa, derivadas dos tool.result (ver coletarTrabalhoDoBot).
  const trabalhoDoBot = useMemo(() => coletarTrabalhoDoBot(lines), [lines]);

  const media = useVideoStudio((state) => state.media);
  const clips = useVideoStudio((state) => state.clips);
  const texts = useVideoStudio((state) => state.texts);
  const logos = useVideoStudio((state) => state.logos);
  const selectedClipId = useVideoStudio((state) => state.selectedClipId);
  const playbackEpoch = useVideoStudio((state) => state.playbackEpoch);
  const importarArquivo = useVideoStudio((state) => state.importarArquivo);
  const adicionarClipe = useVideoStudio((state) => state.adicionarClipe);
  const dividirEm = useVideoStudio((state) => state.dividirEm);
  const aparar = useVideoStudio((state) => state.aparar);
  const patchClipe = useVideoStudio((state) => state.patchClipe);
  const removerClipe = useVideoStudio((state) => state.removerClipe);
  const mover = useVideoStudio((state) => state.mover);
  const selecionarClipe = useVideoStudio((state) => state.selecionarClipe);
  const adicionarTexto = useVideoStudio((state) => state.adicionarTexto);
  const patchTexto = useVideoStudio((state) => state.patchTexto);
  const removerTexto = useVideoStudio((state) => state.removerTexto);
  const adicionarLogo = useVideoStudio((state) => state.adicionarLogo);
  const patchLogo = useVideoStudio((state) => state.patchLogo);
  const removerLogo = useVideoStudio((state) => state.removerLogo);

  const [playing, setPlaying] = useState(false);
  const [nota, setNota] = useState("");
  // Preferências de exportação persistem por chave própria: pasta e fonte são
  // da MÁQUINA da pessoa, não do projeto — sobrevivem a qualquer timeline.
  const [outputName, setOutputName] = useState("corte-final.mp4");
  const [withAudio, setWithAudio] = useState(true);
  const [mediaFolder, setMediaFolder] = useState(() => window.localStorage.getItem("aibot.video.pasta") ?? "");
  const [fontFile, setFontFile] = useState(() => window.localStorage.getItem("aibot.video.fonte") ?? "");

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  const notaTimerRef = useRef(0);
  // O transporte vive em refs: o rAF escreve 60×/s e estado aqui seria uma
  // re-renderização por quadro da superfície inteira.
  const activeIndexRef = useRef(0);
  const tlTimeRef = useRef(0);
  const clipsRef = useRef<VideoClip[]>([]);
  const mediaRef = useRef<StudioMedia[]>([]);
  const playingRef = useRef(false);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => () => window.clearTimeout(notaTimerRef.current), []);

  function flashNote(texto: string): void {
    setNota(texto);
    window.clearTimeout(notaTimerRef.current);
    notaTimerRef.current = window.setTimeout(() => setNota(""), 3200);
  }

  /* ------------------------------ transporte ----------------------------- */

  function paintTransport(time: number, total: number): void {
    const fraction = total > 0 ? Math.min(1, time / total) : 0;
    if (playheadRef.current) playheadRef.current.style.left = `${fraction * 100}%`;
    if (timeRef.current) timeRef.current.textContent = `${formatTime(time)} / ${formatTime(total)}`;
    // O scrub só é reescrito quando NÃO está sob o dedo — senão o rAF briga
    // com o arrasto da pessoa.
    if (scrubRef.current && document.activeElement !== scrubRef.current) {
      scrubRef.current.value = String(Math.round(fraction * 1000));
    }
  }

  function loadClip(index: number, innerTime: number, autoplay: boolean): void {
    const list = clipsRef.current;
    const clip = list[index];
    const video = videoRef.current;
    if (!clip || !video) return;
    const source = mediaRef.current.find((item) => item.id === clip.mediaId);
    // URL vazia = mídia sem arquivo nesta sessão (ou ambiente sem
    // createObjectURL): o transporte anda, só o quadro não aparece.
    if (!source || source.url === "") {
      activeIndexRef.current = index;
      return;
    }
    activeIndexRef.current = index;
    const apply = () => {
      video.currentTime = clip.start + innerTime;
      if (autoplay) void video.play().catch(() => undefined);
    };
    if (video.src === source.url && video.readyState >= 1) {
      apply();
    } else {
      video.src = source.url;
      video.addEventListener("loadedmetadata", apply, { once: true });
      video.load();
    }
  }

  function seekTimeline(time: number): void {
    const list = clipsRef.current;
    const alvo = clipAt(list, time);
    if (!alvo) return;
    const offsets = clipOffsets(list);
    tlTimeRef.current = (offsets[alvo.index] ?? 0) + alvo.inner;
    loadClip(alvo.index, alvo.inner, playingRef.current);
    paintTransport(tlTimeRef.current, totalDuration(list));
  }

  function togglePlay(): void {
    const video = videoRef.current;
    const list = clipsRef.current;
    if (!video || !list.length) return;
    if (playingRef.current) {
      video.pause();
      setPlaying(false);
      return;
    }
    const total = totalDuration(list);
    if (tlTimeRef.current >= total - 0.05) loadClip(0, 0, true);
    else if (!video.src) loadClip(activeIndexRef.current, 0, true);
    else void video.play().catch(() => undefined);
    setPlaying(true);
  }

  function handleEnded(): void {
    const list = clipsRef.current;
    const index = activeIndexRef.current;
    if (index + 1 < list.length) {
      loadClip(index + 1, 0, true);
    } else {
      setPlaying(false);
      tlTimeRef.current = totalDuration(list);
      paintTransport(tlTimeRef.current, tlTimeRef.current);
    }
  }

  /* Clipe removido: pausa e reseta o transporte — o tempo antigo pode nem
     existir mais na timeline nova. */
  useEffect(() => {
    if (!playbackEpoch) return;
    activeIndexRef.current = 0;
    tlTimeRef.current = 0;
    videoRef.current?.pause();
    setPlaying(false);
  }, [playbackEpoch]);

  /* Playhead sincronizado ao currentTime via requestAnimationFrame; é aqui
     que a emenda acontece no preview: alcançou o out do clipe, carrega o
     próximo. */
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const video = videoRef.current;
      const list = clipsRef.current;
      if (video && list.length) {
        const total = totalDuration(list);
        const offsets = clipOffsets(list);
        const index = Math.min(activeIndexRef.current, list.length - 1);
        const clip = list[index];
        if (clip) {
          const offset = offsets[index] ?? 0;
          let time = offset + Math.max(0, video.currentTime - clip.start);
          if (!video.paused && video.currentTime >= clip.end - 0.05) {
            if (index + 1 < list.length) {
              loadClip(index + 1, 0, true);
              time = offset + clipDuration(clip);
            } else {
              video.pause();
              setPlaying(false);
              time = total;
            }
          }
          tlTimeRef.current = Math.min(time, total);
          paintTransport(tlTimeRef.current, total);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Carrega o primeiro clipe no player assim que existir. */
  useEffect(() => {
    const video = videoRef.current;
    if (video && !video.src && clips.length) loadClip(0, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  /* Atalhos do editor: espaço play/pause, setas ±1s. Só enquanto o estúdio
     está montado — a aba Canvas tem os atalhos dela. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Quem digita num campo está escrevendo, não pedindo transporte.
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTimeline(tlTimeRef.current - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTimeline(tlTimeRef.current + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onRulerPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    // Sem largura medida (primeiro paint, jsdom) a fração seria NaN.
    if (rect.width <= 0) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTimeline(fraction * totalDuration(clipsRef.current));
  }

  /* ---------------------- exportação via composer ------------------------ */

  function exportarComOAgente(): void {
    const estado = useVideoStudio.getState();
    const plan = buildFfmpegArgs(estado.clips, estado.media, {
      output: outputName.trim() || "corte-final.mp4",
      withAudio,
      fontFile: fontFile.trim() || undefined,
      texts: estado.texts,
      logos: estado.logos
    });
    if (!plan.ok) {
      flashNote(plan.reason ?? "não foi possível montar a exportação");
      return;
    }
    // Os NOMES reais dos arquivos importados: é tudo que o estúdio sabe deles
    // — o object URL do preview não serve para o ffmpeg. Por isso o texto pede
    // a confirmação da pasta em vez de fingir que conhece o caminho.
    const nomes = new Set<string>();
    for (const clip of estado.clips) {
      const fonte = estado.media.find((item) => item.id === clip.mediaId);
      if (fonte) nomes.add(fonte.name);
    }
    for (const logo of estado.logos) {
      const fonte = estado.media.find((item) => item.id === logo.mediaId);
      if (fonte) nomes.add(fonte.name);
    }
    const pasta = mediaFolder.trim();
    const linhas = [
      "Exporte o corte de vídeo que montei no estúdio rodando o ffmpeg abaixo.",
      "",
      `Arquivos usados (importados no estúdio — só tenho os NOMES, os object URLs do preview não servem para o ffmpeg): ${[...nomes].join(", ")}.`,
      pasta !== ""
        ? `Eles devem estar na pasta ${pasta} — confirme comigo se é essa mesmo e rode o comando com o cwd nela.`
        : "Antes de rodar, confirme comigo em qual PASTA esses arquivos estão e rode o comando com o cwd nela.",
      `A saída ${plan.output} é gravada na mesma pasta (o -y sobrescreve se já existir) · duração estimada ${plan.durationSec.toFixed(1)}s.`,
      ...(plan.warnings.length ? ["", `Atenção: ${plan.warnings.join("; ")}.`] : []),
      "",
      "```",
      formatFfmpegArgs(plan.args),
      "```"
    ];
    // setInput, e NÃO send: o comando aparece no composer para a pessoa ler e
    // disparar — e mesmo depois disso o ffmpeg só roda no turno do agente,
    // atrás do portão de aprovação. A UI nunca executa processo nenhum.
    setInput(linhas.join("\n"));
    flashNote("comando no composer — revise e envie");
  }

  /* ------------------------------- render -------------------------------- */

  const total = totalDuration(clips);
  const ticks = buildTicks(total);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  const selectedMedia = selectedClip ? media.find((item) => item.id === selectedClip.mediaId) ?? null : null;
  const clipIndex = selectedClip ? clips.indexOf(selectedClip) : -1;
  const isLastClip = clipIndex >= 0 && clipIndex === clips.length - 1;
  // A transição consome dos DOIS vizinhos: passar disso faz o ffmpeg abortar
  // — o mesmo teto que a montagem recusa, mostrado antes de errar.
  const maxTransition =
    clipIndex >= 0 && !isLastClip
      ? Math.max(
          0.1,
          Math.min(
            clipDuration(clips[clipIndex] as VideoClip),
            clipDuration(clips[clipIndex + 1] as VideoClip)
          ) - 0.1
        )
      : 1;
  const imagens = media.filter((item) => item.kind === "image");

  return (
    <div className="video-studio">
      <div className="surface-toolbar vid-toolbar">
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          <Plus size={13} aria-hidden="true" />
          Adicionar mídia
        </button>
        <input
          ref={fileRef}
          className="vid-hidden"
          type="file"
          accept="video/*,image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importarArquivo(file);
            // Zera para o MESMO arquivo poder ser importado de novo — o input
            // de arquivo não dispara change para valor repetido.
            event.target.value = "";
          }}
          aria-label="Selecionar arquivo de vídeo ou imagem"
        />
        <span className="chip">{formatTime(total)} total</span>
        <button
          type="button"
          className="btn"
          disabled={!clips.length}
          onClick={() => dividirEm(tlTimeRef.current)}
          title="Divide o clipe sob o playhead em dois"
        >
          <Scissors size={13} aria-hidden="true" />
          Dividir no playhead
        </button>
        <button
          type="button"
          className="btn"
          disabled={!selectedClipId}
          onClick={() => selectedClipId && removerClipe(selectedClipId)}
        >
          <Trash2 size={13} aria-hidden="true" />
          Excluir clipe
        </button>
        <span className="surface-toolbar-spacer" />
        {nota !== "" ? <span className="chip">{nota}</span> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!clips.length}
          onClick={exportarComOAgente}
          title="monta o comando ffmpeg e o coloca no composer — o agente roda com o portão de aprovação"
        >
          <Send size={13} aria-hidden="true" />
          Exportar com o agente
        </button>
      </div>

      <div className="surface-body vid-body">
        <div className="vid-center">
          {clips.length ? (
            <>
              <div className="vid-player">
                <video
                  ref={videoRef}
                  playsInline
                  onEnded={handleEnded}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
                {/* Preview POSICIONAL dos overlays: projeta os pixels do quadro
                    nominal (QUADRO_W×QUADRO_H) em porcentagem — mostra onde o
                    texto/logo cai, não a métrica exata do render final. */}
                {texts.map((item) => (
                  <span
                    key={item.id}
                    className="vid-text-preview"
                    style={{
                      left: `${(item.x / QUADRO_W) * 100}%`,
                      top: `${(item.y / QUADRO_H) * 100}%`,
                      color: item.color
                    }}
                    title={`${formatTime(item.from)} → ${formatTime(item.to)}`}
                  >
                    {item.text}
                  </span>
                ))}
                {logos.map((item) => {
                  const fonte = media.find((entrada) => entrada.id === item.mediaId);
                  return (
                    <span
                      key={item.id}
                      className="vid-logo-preview"
                      style={{ left: `${(item.x / QUADRO_W) * 100}%`, top: `${(item.y / QUADRO_H) * 100}%` }}
                      title={`${fonte?.name ?? "logo"} · ${formatTime(item.from)} → ${formatTime(item.to)}`}
                    >
                      {fonte && fonte.url !== "" ? (
                        <img src={fonte.url} alt={fonte.name} />
                      ) : (
                        <ImageIcon size={16} aria-hidden="true" />
                      )}
                    </span>
                  );
                })}
              </div>
              <div className="vid-transport">
                <button
                  type="button"
                  className="btn icon-btn"
                  onClick={togglePlay}
                  aria-label={playing ? "Pausar" : "Reproduzir"}
                >
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span className="vid-time" ref={timeRef}>
                  0:00.0 / {formatTime(total)}
                </span>
                <span className="vid-keys">espaço play · ←/→ ±1s</span>
                <input
                  ref={scrubRef}
                  className="vid-scrub"
                  type="range"
                  min={0}
                  max={1000}
                  defaultValue={0}
                  onChange={(event) =>
                    seekTimeline((Number(event.target.value) / 1000) * totalDuration(clipsRef.current))
                  }
                  onPointerUp={(event) => event.currentTarget.blur()}
                  aria-label="Posição na timeline"
                />
              </div>
              <div className="vid-timeline">
                <div className="vid-timeline-head">
                  <Clapperboard size={12} aria-hidden="true" />
                  Timeline
                  <small>
                    {clips.length} clipes · {formatTime(total)}
                  </small>
                </div>
                <div className="vid-track-area">
                  <div className="vid-ruler" onPointerDown={onRulerPointerDown}>
                    {ticks.map((tick) => (
                      <span
                        key={tick}
                        className="vid-tick"
                        style={{ left: `${total ? (tick / total) * 100 : 0}%` }}
                      >
                        {formatTime(tick)}
                      </span>
                    ))}
                  </div>
                  <div className="vid-track">
                    {clips.map((clip) => (
                      <button
                        key={clip.id}
                        type="button"
                        className="vid-clip"
                        data-active={selectedClipId === clip.id}
                        style={{ width: `${total ? (clipDuration(clip) / total) * 100 : 0}%` }}
                        onClick={() => selecionarClipe(clip.id)}
                        title={clip.name}
                      >
                        <strong>{clip.name}</strong>
                        <small>{formatTime(clipDuration(clip))}</small>
                      </button>
                    ))}
                  </div>
                  <div ref={playheadRef} className="vid-playhead" />
                </div>
              </div>
              {media.length ? (
                <div className="vid-media-row">
                  {media.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="btn vid-media"
                      title={
                        item.kind === "video"
                          ? `${item.name} · clique para adicionar como clipe`
                          : `${item.name} · imagem para logo`
                      }
                      // Vídeo re-entra como clipe; imagem entra como logo — o
                      // mesmo clique faz a coisa útil para cada tipo.
                      onClick={() => (item.kind === "video" ? adicionarClipe(item.id) : adicionarLogo(item.id))}
                    >
                      {item.kind === "video" ? (
                        <FileVideo size={12} aria-hidden="true" />
                      ) : (
                        <ImageIcon size={12} aria-hidden="true" />
                      )}
                      {item.name}
                      <small>{item.kind === "video" ? formatTime(item.duration) : "logo"}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="vid-empty">
              <Clapperboard size={26} aria-hidden="true" />
              <b>Monte cortes sem sair do estúdio</b>
              <p>
                Importe vídeos locais (e imagens para logo), divida no playhead, apare as bordas e escreva sobre a
                imagem. O export monta o comando ffmpeg e o entrega ao agente — nada roda sem a sua aprovação.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()}>
                <Plus size={13} aria-hidden="true" />
                Adicionar mídia
              </button>
            </div>
          )}
        </div>

        <aside className="vid-side" aria-label="propriedades do vídeo">
          <section className="card">
            <div className="card-head">
              <SlidersHorizontal size={13} aria-hidden="true" />
              <span className="card-title">Clipe</span>
              {selectedClip ? <span className="chip">{selectedClip.name}</span> : null}
            </div>
            {selectedClip ? (
              <div className="card-body vid-fields">
                <span className="hint">
                  Origem {selectedMedia?.name ?? "—"} · dura {formatTime(clipDuration(selectedClip))}
                </span>
                <div className="vid-field-row">
                  <CampoNumero
                    label="Entrada (s)"
                    value={selectedClip.start}
                    step={0.1}
                    onCommit={(valor) => aparar(selectedClip.id, { start: valor })}
                  />
                  <CampoNumero
                    label="Saída (s)"
                    value={selectedClip.end}
                    step={0.1}
                    onCommit={(valor) => aparar(selectedClip.id, { end: valor })}
                  />
                </div>
                <div className="vid-field-row vid-order">
                  <button
                    type="button"
                    className="btn icon-btn"
                    disabled={clipIndex <= 0}
                    title="Mover clipe para a esquerda"
                    aria-label="Mover clipe para a esquerda"
                    onClick={() => mover(selectedClip.id, clipIndex - 1)}
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn icon-btn"
                    disabled={isLastClip}
                    title="Mover clipe para a direita"
                    aria-label="Mover clipe para a direita"
                    onClick={() => mover(selectedClip.id, clipIndex + 1)}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
                {isLastClip ? (
                  <p className="hint">Último clipe — a transição pertence à emenda com o próximo.</p>
                ) : (
                  <div className="vid-field-row">
                    <label className="vid-field">
                      <small>Transição para o próximo</small>
                      <select
                        value={selectedClip.transition ?? "none"}
                        aria-label="Transição para o próximo clipe"
                        onChange={(event) =>
                          patchClipe(selectedClip.id, { transition: event.target.value as TransitionKind })
                        }
                      >
                        <option value="none">Corte seco</option>
                        <option value="fade">Fade</option>
                        <option value="dissolve">Dissolver</option>
                        <option value="wipeleft">Wipe ←</option>
                        <option value="wiperight">Wipe →</option>
                        <option value="slideup">Slide ↑</option>
                      </select>
                    </label>
                    <CampoNumero
                      label="Duração (s)"
                      value={selectedClip.transitionDuration ?? 0.5}
                      step={0.1}
                      min={0.1}
                      max={maxTransition}
                      disabled={(selectedClip.transition ?? "none") === "none"}
                      onCommit={(valor) => patchClipe(selectedClip.id, { transitionDuration: valor })}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="card-body">
                <p className="hint">Selecione um clipe na timeline para aparar, mover e escolher a transição.</p>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <Type size={13} aria-hidden="true" />
              <span className="card-title">Texto</span>
              <span className="chip">{texts.length}</span>
            </div>
            <div className="card-body vid-fields">
              {texts.map((item) => (
                <div key={item.id} className="vid-overlay-card">
                  <div className="vid-overlay-head">
                    <input
                      className="vid-text-input"
                      value={item.text}
                      aria-label="Conteúdo do texto sobre o vídeo"
                      spellCheck={false}
                      onChange={(event) => patchTexto(item.id, { text: event.target.value })}
                    />
                    <button
                      type="button"
                      className="btn icon-btn"
                      title="Remover texto"
                      aria-label="Remover texto"
                      onClick={() => removerTexto(item.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="vid-field-row">
                    <CampoNumero label="De (s)" value={item.from} step={0.1} onCommit={(v) => patchTexto(item.id, { from: v })} />
                    <CampoNumero label="Até (s)" value={item.to} step={0.1} onCommit={(v) => patchTexto(item.id, { to: v })} />
                  </div>
                  <div className="vid-field-row">
                    <CampoNumero label="X" value={item.x} onCommit={(v) => patchTexto(item.id, { x: v })} />
                    <CampoNumero label="Y" value={item.y} onCommit={(v) => patchTexto(item.id, { y: v })} />
                    <CampoNumero label="Corpo" value={item.fontSize} min={8} onCommit={(v) => patchTexto(item.id, { fontSize: v })} />
                    <label className="vid-field">
                      <small>Cor</small>
                      <input
                        type="color"
                        value={/^#[0-9a-f]{6}$/i.test(item.color) ? item.color : "#ffffff"}
                        aria-label="Cor do texto"
                        onChange={(event) => patchTexto(item.id, { color: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              ))}
              <button type="button" className="btn" onClick={adicionarTexto}>
                <Type size={13} aria-hidden="true" />
                Adicionar texto
              </button>
              {texts.length > 0 ? (
                <label className="vid-field">
                  <small>Arquivo de fonte (.ttf)</small>
                  <input
                    value={fontFile}
                    spellCheck={false}
                    placeholder="C:\Windows\Fonts\arial.ttf"
                    aria-label="Arquivo de fonte para o drawtext"
                    onChange={(event) => {
                      setFontFile(event.target.value);
                      window.localStorage.setItem("aibot.video.fonte", event.target.value);
                    }}
                  />
                </label>
              ) : null}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <ImageIcon size={13} aria-hidden="true" />
              <span className="card-title">Logo</span>
              <span className="chip">{logos.length}</span>
            </div>
            <div className="card-body vid-fields">
              {logos.map((item) => {
                const fonte = media.find((entrada) => entrada.id === item.mediaId);
                return (
                  <div key={item.id} className="vid-overlay-card">
                    <div className="vid-overlay-head">
                      <strong>{fonte?.name ?? "imagem removida"}</strong>
                      <button
                        type="button"
                        className="btn icon-btn"
                        title="Remover logo"
                        aria-label="Remover logo"
                        onClick={() => removerLogo(item.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="vid-field-row">
                      <CampoNumero label="De (s)" value={item.from} step={0.1} onCommit={(v) => patchLogo(item.id, { from: v })} />
                      <CampoNumero label="Até (s)" value={item.to} step={0.1} onCommit={(v) => patchLogo(item.id, { to: v })} />
                      <CampoNumero label="X" value={item.x} onCommit={(v) => patchLogo(item.id, { x: v })} />
                      <CampoNumero label="Y" value={item.y} onCommit={(v) => patchLogo(item.id, { y: v })} />
                    </div>
                  </div>
                );
              })}
              {imagens.length ? (
                <select
                  className="vid-logo-add"
                  value=""
                  aria-label="Sobrepor uma imagem como logo"
                  onChange={(event) => {
                    if (event.target.value !== "") adicionarLogo(event.target.value);
                  }}
                >
                  <option value="">+ Sobrepor uma imagem…</option>
                  {imagens.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint">Importe uma imagem (PNG/JPG) para poder sobrepor um logo.</p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <Send size={13} aria-hidden="true" />
              <span className="card-title">Exportar</span>
            </div>
            <div className="card-body vid-fields">
              <p className="hint">
                O estúdio <strong>não roda</strong> o ffmpeg: o botão monta o comando e o coloca no composer — o
                agente executa depois da sua aprovação, com o cwd na pasta dos vídeos.
              </p>
              <label className="vid-field">
                <small>Pasta dos vídeos (e da saída)</small>
                <input
                  value={mediaFolder}
                  spellCheck={false}
                  placeholder="C:\Users\voce\Videos\projeto"
                  aria-label="Pasta dos vídeos importados"
                  onChange={(event) => {
                    setMediaFolder(event.target.value);
                    window.localStorage.setItem("aibot.video.pasta", event.target.value);
                  }}
                />
              </label>
              <label className="vid-field">
                <small>Arquivo de saída</small>
                <input
                  value={outputName}
                  spellCheck={false}
                  aria-label="Nome do arquivo de saída"
                  onChange={(event) => setOutputName(event.target.value)}
                />
              </label>
              <label className="vid-field vid-check">
                <input
                  type="checkbox"
                  checked={withAudio}
                  aria-label="Incluir áudio"
                  onChange={(event) => setWithAudio(event.target.checked)}
                />
                <small>Incluir áudio</small>
              </label>
            </div>
          </section>

          {/*
            O que o BOT já fez com vídeo nesta conversa (video.probe/trim/
            concat/text/export). Sempre visível, com vazio honesto: é a reação
            da aba à entrega dele — sem esta seção, o export rodava no turno do
            agente e a tela seguia como se nada tivesse acontecido. O registro
            integral (argumentos, saída completa) continua no painel de
            ferramentas da conversa.
          */}
          <section className="card" aria-label="trabalho do bot em vídeo">
            <div className="card-head">
              <Bot size={13} aria-hidden="true" />
              <span className="card-title">Trabalho do bot</span>
              <span className="chip">{trabalhoDoBot.length}</span>
            </div>
            <div className="card-body vid-fields">
              {trabalhoDoBot.length === 0 ? (
                <p className="hint">
                  Quando o bot cortar, emendar ou exportar vídeo nesta conversa (as ferramentas{" "}
                  <code>video.*</code>), o resultado de cada operação aparece aqui.
                </p>
              ) : (
                <ul className="vid-bot-lista">
                  {trabalhoDoBot.map((item) => (
                    <li key={item.key} className="vid-bot-item" data-ok={item.ok ? "true" : "false"}>
                      <div className="vid-overlay-head">
                        <strong>{item.tool}</strong>
                        <span className="chip" data-active={item.ok ? "true" : "false"}>
                          {item.ok ? "ok" : "erro"}
                        </span>
                      </div>
                      {item.saida !== "" ? (
                        <p className="hint" title={item.entrada !== "" ? `entrada: ${item.entrada}` : undefined}>
                          saída <code>{item.saida}</code>
                        </p>
                      ) : item.entrada !== "" ? (
                        <p className="hint">
                          arquivo <code>{item.entrada}</code>
                        </p>
                      ) : null}
                      {item.resumo !== "" ? <p className="hint">{item.resumo}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>

      <div className="surface-status">
        <span>
          clipes <b>{clips.length}</b>
        </span>
        <span>
          duração <b>{formatTime(total)}</b>
        </span>
        <span>
          textos <b>{texts.length}</b> · logos <b>{logos.length}</b>
        </span>
        {selectedClip ? <span>{selectedClip.name} selecionado</span> : null}
        <span>export via agente — nada roda sem aprovação</span>
      </div>
    </div>
  );
}

/* Campo numérico controlado — o grampo de verdade mora na operação imutável
   (trimClip etc.); min/max aqui são só o afford do spinner. */
function CampoNumero({
  label,
  value,
  onCommit,
  step,
  min,
  max,
  disabled
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="vid-field">
      <small>{label}</small>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        min={min}
        max={max}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }}
      />
    </label>
  );
}

export default VideoStudio;
