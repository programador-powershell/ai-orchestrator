-- Fine-tuning só-nuvem: o gateway orquestra jobs em provedores externos.
-- LGPD: NENHUMA tabela abaixo armazena conteúdo de dataset (exemplos, prompts
-- ou respostas) — apenas contagens, identificadores e metadados dos jobs.

CREATE TABLE fine_tune_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  base_model text NOT NULL,
  suffix text,
  method text NOT NULL DEFAULT 'supervised' CHECK (method IN ('supervised','dpo')),
  hyperparams jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validating_files','queued','running','succeeded','failed','cancelled')),
  provider_job_id text,
  provider_file_id text,
  fine_tuned_model text,
  error text,
  training_examples integer NOT NULL DEFAULT 0,
  trained_tokens bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fine_tune_jobs_workspace_created_idx ON fine_tune_jobs(workspace_id, created_at DESC);
CREATE INDEX fine_tune_jobs_active_idx ON fine_tune_jobs(status)
  WHERE status IN ('pending','validating_files','queued','running');

CREATE TABLE fine_tune_job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES fine_tune_jobs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);

CREATE TABLE fine_tuned_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  job_id uuid REFERENCES fine_tune_jobs(id) ON DELETE SET NULL,
  base_model text NOT NULL,
  model_id text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, model_id)
);
