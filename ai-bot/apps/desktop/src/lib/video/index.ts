/**
 * Fachada dos módulos puros do estúdio de Vídeo (portados do AI-Orchestrator:
 * lib/videoCompose.ts + a parte pura de modes/DesignView.tsx).
 *
 * A superfície importa daqui (`../lib/video`) pelo mesmo motivo da fachada do
 * canvas: não acoplar no layout interno dos arquivos — se a exportação ganhar
 * um alvo novo (outro renderizador, outro contêiner), o módulo se pendura
 * nesta mesma fachada sem tocar em quem já consome.
 *
 * Nenhum módulo abaixo toca DOM, rede ou processo: tudo roda em Node e é
 * coberto pelos `*.test.ts` vizinhos. Em especial, NADA aqui executa ffmpeg —
 * o plano sai como lista de args e quem roda é o agente, com aprovação.
 */
export * from "./timeline";
export * from "./ffmpegArgs";
