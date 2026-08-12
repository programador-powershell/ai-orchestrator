-- Política por grupo do AD/Entra: quem vê qual módulo, com qual política,
-- e qual prompt master vale. A UI apenas reflete o que estas tabelas dizem.

-- Grupos conhecidos do workspace. ad_object_id é o ObjectId (ou o nome da
-- app role) que chega no token; name é o rótulo humano para o console.
CREATE TABLE ad_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ad_object_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, ad_object_id)
);
CREATE INDEX ad_groups_workspace_idx ON ad_groups(workspace_id);

-- Módulos liberados por grupo. A resolução por usuário é a UNIÃO dos seus
-- grupos: quem está em TI+Comercial vê os dois conjuntos.
CREATE TABLE group_modules (
  group_id uuid NOT NULL REFERENCES ad_groups(id) ON DELETE CASCADE,
  mode text NOT NULL
    CHECK (mode IN ('chat','work','design','data','agent','code','security','office','tune')),
  PRIMARY KEY (group_id, mode)
);

-- Política do grupo (agentTools, approvalPolicy, byok, runtime local, effort).
-- Documento JSON versionado; nos booleanos de segurança o mais restritivo
-- vence quando o usuário pertence a mais de um grupo.
CREATE TABLE group_policies (
  group_id uuid PRIMARY KEY REFERENCES ad_groups(id) ON DELETE CASCADE,
  document jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prompt master: uma linha por workspace (group_id NULL) e, opcionalmente,
-- um override por grupo. O do grupo mais específico vence.
CREATE TABLE prompt_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id uuid REFERENCES ad_groups(id) ON DELETE CASCADE,
  content text NOT NULL,
  allow_local_append boolean NOT NULL DEFAULT true,
  local_max_chars integer NOT NULL DEFAULT 2000,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- UNIQUE(workspace_id, group_id) não segura NULLs no Postgres — o índice
-- parcial garante um único prompt de workspace.
CREATE UNIQUE INDEX prompt_masters_workspace_base
  ON prompt_masters(workspace_id) WHERE group_id IS NULL;
CREATE UNIQUE INDEX prompt_masters_group
  ON prompt_masters(workspace_id, group_id) WHERE group_id IS NOT NULL;

-- Associação usuário↔grupo materializada a cada login: o console admin lista
-- quem está em qual grupo sem consultar o AD.
CREATE TABLE user_group_memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES ad_groups(id) ON DELETE CASCADE,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);
