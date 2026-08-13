-- Modelo por GRUPO: o admin escolhe qual modelo cada área usa.
--
-- Até aqui a rota era só por (workspace, modo, capacidade) — todo mundo da
-- empresa no mesmo modelo. Isso não serve: o time de código precisa de um
-- modelo forte e caro, o atendimento resolve com um barato, e a diferença
-- aparece direto na fatura que a relatoria agora mostra.
--
-- Resolução: rota do GRUPO sobrepõe a do workspace. A do workspace continua
-- valendo como padrão para quem não tem override.

CREATE TABLE group_route_configs (
  group_id uuid NOT NULL REFERENCES ad_groups(id) ON DELETE CASCADE,
  -- Sem CHECK de modo aqui de propósito: a lista de modos já mudou duas vezes
  -- (0002 e 0004) e um CHECK desatualizado recusaria modo válido. A validação
  -- é no Rust (admin::validate_modes), que conhece Mode::ALL.
  mode text NOT NULL,
  capability text NOT NULL,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, mode, capability)
);

-- Desempate quando o usuário está em DOIS grupos que definem rota para o
-- mesmo modo.
--
-- "Mais restritivo vence" não se aplica a escolha de modelo — não existe
-- modelo "mais restritivo". Precisa de uma ordem explícita, definida pelo
-- admin, senão a rota escolhida dependeria da ordem de retorno do banco e
-- mudaria sozinha entre uma consulta e outra.
--
-- Maior prioridade vence; empate desempata por nome, só para ser determinístico.
ALTER TABLE ad_groups ADD COLUMN priority integer NOT NULL DEFAULT 0;

CREATE INDEX group_route_configs_mode_idx ON group_route_configs (mode, capability);
