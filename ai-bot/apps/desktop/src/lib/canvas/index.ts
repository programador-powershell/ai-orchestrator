/**
 * Fachada dos módulos puros do canvas de Design (portados do AI-Orchestrator).
 *
 * A superfície importa daqui (`../lib/canvas`) para não acoplar no layout
 * interno dos arquivos — quando o vídeo/site entrarem, os módulos novos se
 * penduram nesta mesma fachada sem tocar em quem já consome.
 *
 * Nenhum módulo abaixo toca DOM ou rede: tudo roda em Node e é coberto pelos
 * `*.test.ts` vizinhos.
 */
export * from "./canvasDoc";
export * from "./history";
export * from "./devices";
export * from "./stencils";
export * from "./htmlTokens";
