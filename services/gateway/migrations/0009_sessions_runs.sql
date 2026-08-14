-- Sessões e RUNS duráveis — a espinha do harness.
--
-- Até aqui a execução de uma equipe de agentes vivia INTEIRA no renderer:
-- `/orchestrations/validate` calculava ondas e caminho crítico, devolvia o
-- plano e ia embora. Quem executava era a aba. Fechar a janela matava o run no
-- meio, sem registro do que já tinha rodado, e não havia como acompanhar de
-- outra máquina. É a diferença entre "a IA trabalha" e "a IA trabalha e você
-- pode sair da frente".
--
-- ## Local-first
--
-- O id de sessão e de run é gerado pelo CLIENTE (uuid v4). Sem isso não existe
-- local-first: criar um run exigiria ida e volta ao gateway, e o app offline
-- (BYOK/runtime local) não conseguiria nem começar. O gateway ACEITA o id e é
-- a cópia durável — não o dono.
--
-- ## O log é a verdade
--
-- `run_events` é append-only com `seq` monotônico POR RUN, e a chave primária
-- é (run_id, seq). Reenviar o mesmo lote é inofensivo — é o que permite o
-- cliente sincronizar sem transação distribuída: ele reenvia de `last_seq` em
-- diante e o `ON CONFLICT DO NOTHING` descarta o que já chegou. É também o
-- cursor de retomada do WebSocket: reconectar pede `from_seq` e recebe o que
-- perdeu, em vez de um buraco silencioso no meio do run.

CREATE TABLE sessions (
  -- Gerado pelo cliente. Ver "local-first" acima.
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Aba de origem (code, agent, chat…). O mesmo run vale para qualquer uma.
  mode text NOT NULL DEFAULT 'agent',
  title text NOT NULL DEFAULT '',
  -- Raiz do projeto no cliente. É rótulo de agrupamento, não caminho que o
  -- servidor vá abrir — o gateway nunca toca no disco de quem chamou.
  cwd text NOT NULL DEFAULT '',
  -- Sessão de origem quando esta nasceu de um fork/restore.
  parent_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_workspace_user_idx
  ON sessions (workspace_id, user_id, updated_at DESC);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Grupos no MOMENTO do run, pelo mesmo motivo de `usage_events` e
  -- `agent_actions`: quem muda de área não leva o histórico consigo.
  group_ids uuid[] NOT NULL DEFAULT '{}',
  -- O OrchestrationGraph como chegou, e o plano derivado dele. Guardar o plano
  -- evita recalcular ondas a cada leitura e congela a decisão: se o validador
  -- mudar amanhã, o run que já rodou continua explicável pelo plano que usou.
  graph jsonb NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','paused','succeeded','failed','canceled')),
  -- Quem está tocando o run agora. `local` = a estação; `gateway` = o executor
  -- do servidor assumiu (o caso de "fechei o app e quero que continue").
  origin text NOT NULL DEFAULT 'local'
    CHECK (origin IN ('local','gateway')),
  -- Alta d'água dos eventos já persistidos. Denormalizado de propósito: é a
  -- pergunta mais frequente do protocolo (de onde retomo?) e não vale um
  -- MAX(seq) na tabela grande a cada reconexão.
  last_seq bigint NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX runs_session_idx ON runs (session_id, created_at DESC);
CREATE INDEX runs_workspace_status_idx ON runs (workspace_id, status, updated_at DESC);
-- Varredura do executor: só os runs que ele pode assumir.
CREATE INDEX runs_claimable_idx ON runs (origin, status, updated_at)
  WHERE status IN ('pending','running');

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- Monotônico por run, atribuído por quem PRODUZ o evento (o cliente, na
  -- maioria dos casos). Não é bigserial: um id global não diria de onde
  -- retomar, e o cliente precisa numerar offline, antes de haver servidor.
  seq bigint NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  -- node:start, node:done, node:fail, tool:call, tool:result, approval:ask,
  -- approval:decided, token, log, run:status… texto livre de propósito: o
  -- vocabulário do harness ainda vai crescer e migration por evento novo
  -- seria imposto sem receita.
  kind text NOT NULL,
  node_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE run_approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id text NOT NULL DEFAULT '',
  tool text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Uma LINHA por pedido é a correção estrutural do bug da V.9: os
  -- subordinados de uma onda pediam aprovação em paralelo e o segundo pedido
  -- sobrescrevia o `resolve` do primeiro em memória, travando a execução em
  -- "running" sem ninguém para destravar. Com registro por pedido, dois
  -- pedidos simultâneos são duas linhas — não há o que sobrescrever.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired')),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_approvals_pending_idx ON run_approvals (run_id, status, created_at);
