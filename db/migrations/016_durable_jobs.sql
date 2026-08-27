-- Durable Execution Layer (P0.6 — Agentic Foundation)
-- See docs/adr/0001-durable-execution-layer.md for the full vendor-vs-native
-- decision record. This is a Postgres-native job queue: retries, exponential
-- backoff, idempotency, dead-lettering, and tenant isolation, built on
-- infrastructure already in the stack (Supabase + Vercel Cron) rather than a
-- new vendor. Appropriate for hundreds-to-low-thousands of jobs/day; the ADR
-- documents the explicit upgrade trigger to a dedicated queue.

CREATE TABLE IF NOT EXISTS public.durable_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  idempotency_key text,
  correlation_id uuid,
  locked_by text,
  locked_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_durable_jobs_tenant_idempotency
  ON public.durable_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_durable_jobs_claim ON public.durable_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_tenant_id ON public.durable_jobs (tenant_id);

ALTER TABLE public.durable_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: internal execution plumbing, service-role only — same
-- deny-by-default posture as platform_prospects (see migration 006).
