-- Trilha de auditoria das execuções do agente na estação (computer_exec).
--
-- Tabela PRÓPRIA, e não `usage_events`, de propósito: aquela responde "quanto
-- de modelo foi consumido" e alimenta o relatório de custo. Misturar ação de
-- agente ali inflaria `calls` e diluiria o percentual de chamadas medidas — o
-- número ficaria errado com cara de certo. São perguntas diferentes: uma é
-- gasto, a outra é "o que a IA rodou na máquina de quem".

CREATE TABLE agent_actions (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Grupos no MOMENTO da ação, pelo mesmo motivo de usage_events: quem muda
  -- de área não pode levar consigo o histórico de auditoria.
  group_ids uuid[] NOT NULL DEFAULT '{}',
  -- Rótulo do agente que pediu; numa árvore de delegação, saber qual nó
  -- pediu é metade da resposta.
  agent text NOT NULL,
  -- Objetivo da execução, para a linha ter contexto sem abrir o log inteiro.
  goal text NOT NULL DEFAULT '',
  -- Comando JÁ REDIGIDO pelo cliente (lib/agentAudit.ts). O comando é o
  -- registro de auditoria, mas pode carregar credencial — os padrões
  -- conhecidos saem antes de trafegar. Formato desconhecido passa: é limite
  -- declarado, não garantia.
  command text NOT NULL,
  -- false = o humano RECUSOU. Negar é informação de auditoria tanto quanto
  -- permitir, e some se só o aprovado for gravado.
  approved boolean NOT NULL,
  exit_code integer,
  duration_ms integer NOT NULL DEFAULT 0,
  -- O comando rodou dentro do Job Object? false vira alerta na trilha.
  jailed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_actions_workspace_created_idx
  ON agent_actions (workspace_id, created_at DESC);
CREATE INDEX agent_actions_user_idx
  ON agent_actions (workspace_id, user_id, created_at DESC);
