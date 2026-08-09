CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member');
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('openai','anthropic','gemini','moonshot','deepseek','mistral','openai-compatible','openai-images','imagen','black-forest-labs')),
  base_url text,
  encrypted_api_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_workspace_idx ON providers(workspace_id);

CREATE TABLE route_configs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('chat','work','design','data','agent','code')),
  capability text NOT NULL CHECK (capability IN ('chat','image','embedding','rerank')),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, mode, capability)
);

CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id uuid,
  mode text NOT NULL,
  capability text NOT NULL,
  model text NOT NULL,
  status_code integer NOT NULL,
  latency_ms integer NOT NULL,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_workspace_created_idx ON usage_events(workspace_id, created_at DESC);

-- Prompts e respostas não possuem colunas nesta tabela por design.
