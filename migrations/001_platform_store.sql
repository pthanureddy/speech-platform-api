CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) > 0),
  plan_id text NOT NULL CHECK (plan_id IN ('free', 'starter', 'business')),
  api_key_digest char(64) NOT NULL UNIQUE
    CHECK (api_key_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE speech_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  input_text text NOT NULL CHECK (length(input_text) > 0),
  voice text NOT NULL CHECK (length(voice) > 0),
  format text NOT NULL CHECK (format IN ('mp3', 'wav')),
  character_count integer NOT NULL CHECK (character_count > 0),
  quota_period char(7) NOT NULL
    CHECK (quota_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text NOT NULL
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  output jsonb,
  failure jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT speech_jobs_timestamp_order CHECK (updated_at >= created_at),
  CONSTRAINT speech_jobs_terminal_payload CHECK (
    (status = 'completed' AND output IS NOT NULL AND failure IS NULL)
    OR (status = 'failed' AND failure IS NOT NULL AND output IS NULL)
    OR (status IN ('queued', 'processing', 'cancelled') AND output IS NULL AND failure IS NULL)
  )
);

CREATE INDEX speech_jobs_tenant_created_idx
  ON speech_jobs (tenant_id, created_at DESC, id);

CREATE INDEX speech_jobs_status_updated_idx
  ON speech_jobs (status, updated_at, id);

CREATE TABLE usage_buckets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  reserved_characters bigint NOT NULL DEFAULT 0 CHECK (reserved_characters >= 0),
  consumed_characters bigint NOT NULL DEFAULT 0 CHECK (consumed_characters >= 0),
  character_limit bigint NOT NULL CHECK (character_limit > 0),
  PRIMARY KEY (tenant_id, period),
  CONSTRAINT usage_buckets_within_limit CHECK (
    reserved_characters + consumed_characters <= character_limit
  )
);

CREATE TABLE idempotency_keys (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key varchar(128) NOT NULL CHECK (length(idempotency_key) > 0),
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  job_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT idempotency_keys_job_fk
    FOREIGN KEY (job_id) REFERENCES speech_jobs(id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idempotency_keys_job_idx ON idempotency_keys (job_id);

CREATE TABLE webhook_events (
  event_id text PRIMARY KEY,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  job_id text NOT NULL REFERENCES speech_jobs(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL
);

CREATE INDEX webhook_events_job_idx ON webhook_events (job_id);
