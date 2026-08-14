import type { UiMode } from "@multiplike/contracts";

/**
 * Contratos dos canais de operação chat→superfície.
 * As views aplicam exatamente estes nomes de operação (ver lib/ops.ts).
 */
export const opsChannelForMode: Partial<Record<UiMode, string>> = {
  data: "data",
  work: "work"
};

export const opsCatalogs: Record<string, Record<string, string>> = {
  data: {
    add_table:
      'cria tabela. {"op":"add_table","name":string,"fields":[{"name":string,"type":string,"primaryKey"?:bool,"nullable"?:bool,"references"?:{"table":string,"field":string}}]}',
    drop_table: 'remove tabela. {"op":"drop_table","table":string}',
    rename_table: 'renomeia tabela. {"op":"rename_table","table":string,"name":string}',
    add_field: 'adiciona campo. {"op":"add_field","table":string,"field":{"name":string,"type":string}}',
    drop_field: 'remove campo. {"op":"drop_field","table":string,"field":string}',
    add_relation:
      'cria relação. {"op":"add_relation","fromTable":string,"fromField":string,"toTable":string,"toField":string,"cardinality":"1-1"|"1-n"|"n-n"}',
    set_dialect: 'define dialeto SQL. {"op":"set_dialect","dialect":"postgres"|"mysql"|"ansi"}'
  },
  work: {
    add_task: 'cria cartão. {"op":"add_task","lane":string,"title":string,"detail"?:string}',
    move_task: 'move cartão. {"op":"move_task","title":string,"lane":string}',
    add_lane: 'cria coluna. {"op":"add_lane","name":string}',
    add_automation:
      'cria automação. {"op":"add_automation","name":string,"trigger":string,"action":string}'
  }
};
