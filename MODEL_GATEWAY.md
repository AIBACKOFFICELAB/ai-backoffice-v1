# Model Gateway — P0.2

## Purpose

Application/business logic never calls a model provider SDK directly and
never references a provider or model name outside `lib/ai/`. Every AI call
goes through `lib/ai/gateway.ts`'s `AiGateway`:

```ts
import { ai } from "@/lib/ai/gateway";

const response = await ai.generate({ tenantId, prompt, workflowId });
// ai.reason() / ai.classify() / ai.extract() / ai.summarize() / ai.embed()
```

A better or cheaper model — or an entirely different provider — should
improve AI BackOffice, not require touching call sites. Swapping the
provider registry is enough; see `lib/ai/gateway.test.ts`
("swapping providers requires no change to call sites").

## Routing metadata

```ts
type AiRoutingMetadata = {
  complexity?: "low" | "medium" | "high";
  latencyPreference?: "fast" | "balanced" | "quality";
  costPreference?: "low" | "balanced" | "premium";
  requiredCapabilities?: string[];
  privacyClass?: "public" | "internal" | "customer_pii" | "financial";
  tenantId: string;               // required
  workflowId?: string;
  agentRunId?: string | null;     // set automatically when called from the agent runtime
};
```

`lib/ai/router.ts::resolveRoute()` is a deterministic lookup table (not a
model choosing a model) mapping this metadata + task type to a
`{provider, model}` decision — auditable, cheap, and the only place model
selection policy lives. It prefers `anthropic` and falls back to whichever
provider **is actually configured** (checked via `Object.keys(chatProviders)`
at call time) — so the gateway, and everything built on top of it, stays
operable in dev/CI without a live API key. See `lib/ai/router.test.ts`.

An individual agent can bias this later via `agents.model_policy` (e.g.
force `costPreference: "low"` for its `classify` calls) without any gateway
change — that plumbing exists in the schema now, wiring it into
`resolveRoute` is a small follow-up once an agent actually needs it.

## Providers

| id | file | notes |
|---|---|---|
| `anthropic` | `lib/ai/providers/anthropic.ts` | Only registered when `ANTHROPIC_API_KEY` is set. Uses the current Claude model family (`claude-sonnet-5` / `claude-opus-5` / `claude-haiku-4-5-20251001`) — update the table in `router.ts`, not call sites, when models change. |
| `mock` | `lib/ai/providers/mock.ts` | Registered in `test`/`development` only — see "Production fail-closed" below. Deterministic, no network — used by every test in this repo and as the router's fallback in dev when no real provider is configured. |

### Production fail-closed (P0.9 Slice C, finding M-01)

`lib/ai/environment.ts::isMockProviderAllowed()` is a hard boundary, not a
policy default: `production` (real Vercel production, or plain
`NODE_ENV=production` with no `VERCEL_ENV`) **never** registers `mock` —
there is no environment-variable override of any kind. A Vercel *preview*
deployment is treated as `development` (mock allowed), since Next.js sets
`NODE_ENV=production` for both a production AND a preview deploy —
`VERCEL_ENV` is what actually distinguishes them. In production with no
real provider configured, `getDefaultChatProviders()`
(`lib/ai/providers/registry.ts`) returns an empty registry; the first
actual call then fails loudly as a normal `configuration`-category
`AiGatewayError` (see "Failure handling" below) — never a silent mock
response standing in for a real model call. See
`lib/ai/environment.test.ts` / `lib/ai/providers/registry.test.ts`.

### Deadlines (P0.9 Slice C, finding M-05)

Every provider invocation has a finite deadline — `30s` for text,
`15s` for embeddings, overridable per call via `timeoutMs`. The gateway
races the provider call against its own `setTimeout` (`lib/ai/gateway.ts::withDeadline`)
and returns control to the caller on time regardless of provider
cooperation, best-effort aborting the provider's own `AbortSignal` in
parallel. A timeout is recorded as a `status: 'failed'` invocation with
`errorCategory: 'timeout'`, same as any other failure.

Embeddings: no real embeddings provider is wired up yet (Anthropic does not
offer one). `ai.embed()` works today only against `mock` — see "Known gaps"
below. Add a real `EmbeddingProvider` when a workflow actually needs
semantic search/RAG; the interface (`lib/ai/providers/types.ts`) already
supports it.

## Observability (P0.7)

Every gateway call — success or failure — writes one row to
`model_invocations` via `lib/ai/store.ts`: provider, model, task type,
routing preferences, token counts (when the provider returns them),
latency, and `estimated_cost_usd`. `agent_run_id` is nullable — the gateway
is usable outside the agent runtime; when it *is* called from
`lib/agents/runtime.ts`, the run id is passed through automatically for the
full P0.7 observability chain.

**Cost estimation is honest, not invented.** `lib/ai/pricing.ts`'s
`PRICING_TABLE` starts empty; `estimateCostUsd()` returns `null` for any
provider/model without a confirmed `$/million-token` rate rather than
fabricating a number — the same "do not invent fake ROI" principle P0.8
applies to outcomes applies here to cost. Populate the table with confirmed
pricing before relying on `estimated_cost_usd` for financial reporting.
Every recorded row computes its cost the same way, INCLUDING a
structured-output `invalid_response` failure (P0.9 Slice D, D.12): the
provider physically consumed real tokens producing that response
regardless of what the caller's own validator later decided, so that row's
`estimated_cost_usd` is computed from the real token counts too, not
hardcoded `null` the way an ordinary connectivity/auth/timeout failure
correctly is (no tokens were ever consumed for those). See
`lib/ai/gateway.test.ts`'s D.12 scenario.

## Failure handling

A provider throwing (bad key, rate limit, network, timeout) records a
`status: 'failed'` invocation row, then rethrows — callers (the agent
runtime) are responsible for deciding what that means for the run (see
`AGENT_SECURITY.md` / `ARCHITECTURE.md`'s end-to-end path, where a model
gateway failure marks the `agent_run` `failed` with a `failure_reason`,
never a silent success).

**Normalized error taxonomy (P0.9 Slice C, finding M-05/C.6).**
`lib/ai/gateway.ts::normalizeProviderError` maps every thrown value into an
`AiGatewayError` with one of a fixed set of categories — `timeout`,
`provider_unavailable`, `rate_limited`, `authentication`, `invalid_response`,
`configuration`, `unknown` — persisted in `model_invocations.error_category`
(migration `019`). The message is always a FIXED, category-specific string,
never the original provider error text: a provider error can echo back
request content (prompt text, which may carry customer PII) or, in
principle, secret material, so the original error survives only as
`AiGatewayError.cause`, an in-memory property that is never serialized into
the persisted `error` column or logs.

## Structured output (P0.9 Slice C, finding M-05/C.9)

`ai.generateStructured<T>({ ...request, validate })` is a minimal,
provider-independent structured-output primitive — NOT an autonomous
tool-selection loop. The caller supplies its own `validate(rawText): { ok:
true, value: T } | { ok: false, errors: string[] }`; a response that fails
validation is normalized to an `invalid_response` `AiGatewayError` and
never silently trusted as parsed data.

**Exactly one `model_invocations` row per physical provider call (P0.9
Slice D correction 4).** An earlier version of this method called the
ordinary `invokeText` path (which records a succeeded row) and then, on
validation failure, wrote a SECOND row for the same physical call — an
untruthful double-count. `generateStructured` now uses a private,
non-recording `callChatProvider` primitive shared with `invokeText`, and
records exactly once: `status: 'succeeded'` if validation passes,
`status: 'failed'`/`errorCategory: 'invalid_response'`/a FIXED sanitized
message if it doesn't — the caller-supplied validator's own `errors`
strings are deliberately never interpolated into that message, since a
validator can echo back model output (and therefore customer PII) in its
own error text. The failed row still carries the real provider/model/
token/latency metadata from that one physical call — see "Cost estimation"
below for why that matters. See `lib/ai/gateway.test.ts`'s "correction 4"
scenarios.

## Testing

`lib/ai/gateway.test.ts` and `lib/ai/router.test.ts` — provider swapping,
success/failure invocation recording, routing decisions per
complexity/cost/latency preference, the "no provider configured" path
(`AiGatewayError`, still recorded as a failed invocation, never a silent
no-op), deadlines/timeouts, the normalized error taxonomy, and structured
output's single-record invariant. `lib/ai/environment.test.ts` /
`lib/ai/providers/registry.test.ts` — the production fail-closed policy.

## Known gaps (explicitly deferred, not hidden)

- No real embeddings provider.
- No token-budget/cost-cap enforcement per tenant — `model_invocations`
  gives the data to build that once a real workflow needs it.
- `resolveRoute` doesn't yet read `agents.model_policy` — the schema
  supports it, the router doesn't consume it yet.
