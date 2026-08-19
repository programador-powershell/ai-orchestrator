/**
 * Fachada dos módulos do schema editável (portados do AI-Orchestrator,
 * lib/schema.ts + DataView.tsx).
 *
 * A superfície e o rail importam daqui (`../lib/schema`) para não acoplar no
 * layout interno dos arquivos — o export SQL completo (junções n-n, ações de
 * FK), quando for portado, se pendura nesta mesma fachada sem tocar em quem
 * já consome.
 *
 * schemaDoc/ddl/migration/history não tocam DOM nem rede: rodam em Node e são
 * cobertos pelos `*.test.ts` vizinhos. `studio` é o único com estado (zustand
 * de módulo) — é a ponte rail ↔ superfície, como o schemaFoco é para o foco.
 */
export * from "./schemaDoc";
export * from "./ddl";
export * from "./migration";
export * from "./history";
export * from "./studio";
