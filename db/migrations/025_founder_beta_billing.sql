-- Founder Beta paid enrollment: minimal server-authoritative billing state.
-- Payment truth comes ONLY from the signed Stripe webhook (service role);
-- tenants may read their own row but can never write it (no write policies).

CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'founder_beta_299',
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  purchaser_email text,
  subscription_status text NOT NULL,
  entitlement text NOT NULL DEFAULT 'active' CHECK (entitlement IN ('active', 'restricted', 'revoked')),
  onboarding_status text NOT NULL DEFAULT 'onboarding_required' CHECK (onboarding_status IN ('onboarding_required', 'in_progress', 'complete')),
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id),
  UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer ON public.billing_subscriptions (stripe_customer_id);

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_select_tenant ON public.billing_subscriptions;
CREATE POLICY billing_select_tenant ON public.billing_subscriptions
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
-- Deliberately NO insert/update/delete policies: authenticated tenant users
-- cannot self-assign paid status or alter entitlement.

-- Webhook event ledger: idempotency + retry/failure observability.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (deny-by-default for every tenant user).
