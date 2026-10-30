-- PROPOSED PostgreSQL migration. Administrator only; never execute via /ai/sql/execute.
-- Not evidence that these tables exist or have been whitelisted. No triggers or cascading FKs.

CREATE TABLE agent_branch_plan_version (
  tenant_key VARCHAR(128) NOT NULL,
  warehouse_code VARCHAR(64) NOT NULL,
  entity_key VARCHAR(128) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_text TEXT NOT NULL CHECK (octet_length(payload_text) <= 48000),
  idempotency_key VARCHAR(128) NOT NULL,
  created_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_key, warehouse_code, entity_key, revision),
  UNIQUE (tenant_key, idempotency_key)
);

CREATE TABLE agent_branch_cycle_version (
  tenant_key VARCHAR(128) NOT NULL,
  warehouse_code VARCHAR(64) NOT NULL,
  entity_key VARCHAR(128) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_text TEXT NOT NULL CHECK (octet_length(payload_text) <= 48000),
  idempotency_key VARCHAR(128) NOT NULL,
  created_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_key, warehouse_code, entity_key, revision),
  UNIQUE (tenant_key, idempotency_key)
);

CREATE TABLE agent_branch_submission_event (
  tenant_key VARCHAR(128) NOT NULL,
  warehouse_code VARCHAR(64) NOT NULL,
  entity_key VARCHAR(128) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_text TEXT NOT NULL CHECK (octet_length(payload_text) <= 48000),
  idempotency_key VARCHAR(128) NOT NULL,
  created_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_key, warehouse_code, entity_key, revision),
  UNIQUE (tenant_key, idempotency_key)
);
