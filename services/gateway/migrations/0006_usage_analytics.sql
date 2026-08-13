-- Relatoria de uso e custo por usuário, grupo e modelo.
--
-- Ponto de partida: `usage_events.input_tokens` e `output_tokens` existem
-- desde a 0001 e NUNCA foram escritas — o gateway guardava modo, modelo e
-- latência, e descartava o bloco `usage` do provedor. Sem token não há custo,
-- então não existia base para relatório de gasto nenhum.

-- Cache muda o custo real em ordem de grandeza (leitura de cache costuma
-- custar ~10% da entrada; escrita, ~125%). Somar tudo como "entrada" daria um
-- número errado com cara de certo.
ALTER TABLE usage_events ADD COLUMN cache_read_tokens integer;
ALTER TABLE usage_events ADD COLUMN cache_write_tokens integer;

-- Grupos do usuário NO MOMENTO do evento.
--
-- Por que snapshot em vez de join com a tabela de grupos na hora do relatório:
-- quem sai de TI para Comercial faria todo o gasto passado migrar de área
-- junto, reescrevendo o histórico em silêncio. O relatório do mês fechado tem
-- de continuar dando o mesmo número no mês que vem.
ALTER TABLE usage_events ADD COLUMN group_ids uuid[] NOT NULL DEFAULT '{}';

-- Preço por modelo — definido pelo ADMIN, nunca embutido no binário.
-- Tabela de preço de provedor muda sem aviso; chutar valor no código viraria
-- relatório errado que ninguém questiona. Modelo sem linha aqui aparece como
-- "sem preço" no relatório, e não como custo zero.
CREATE TABLE model_prices (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model text NOT NULL,
  -- numeric, não float: dinheiro somado em ponto flutuante acumula erro.
  input_per_mtok numeric(14, 6) NOT NULL DEFAULT 0,
  output_per_mtok numeric(14, 6) NOT NULL DEFAULT 0,
  cache_read_per_mtok numeric(14, 6) NOT NULL DEFAULT 0,
  cache_write_per_mtok numeric(14, 6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, model)
);

-- Índices das três quebras que o console pede: por usuário, por modelo e por
-- grupo. O índice de 0001 (workspace, created_at) só cobre a linha do tempo.
CREATE INDEX usage_events_workspace_user_idx
  ON usage_events (workspace_id, user_id, created_at DESC);
CREATE INDEX usage_events_workspace_model_idx
  ON usage_events (workspace_id, model, created_at DESC);
CREATE INDEX usage_events_groups_idx
  ON usage_events USING gin (group_ids);
