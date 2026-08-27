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
| `mock` | `lib/ai/providers/mock.ts` | Always registered. Deterministic, no network — used by every test in this repo and as the router's fallback when no real provider is configured. |

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

## Failure handling

A provider throwing (bad key, rate limit, network) records a `status:
'failed'` invocation row with the error message, then rethrows — callers
(the agent runtime) are responsible for deciding what that means for the
run (see `AGENT_SECURITY.md` / `ARCHITECTURE.md`'s end-to-end path, where a
model gateway failure marks the `agent_run` `failed` with a
`failure_reason`, never a silent success).

## Testing

`lib/ai/gateway.test.ts` and `lib/ai/router.test.ts` — provider swapping,
success/failure invocation recording, routing decisions per
complexity/cost/latency preference, and the "no provider configured" path
(`AiGatewayError`, still recorded as a failed invocation, never a silent
no-op).

## Known gaps (explicitly deferred, not hidden)

- No real embeddings provider.
- No token-budget/cost-cap enforcement per tenant — `model_invocations`
  gives the data to build that once a real workflow needs it.
- `resolveRoute` doesn't yet read `agents.model_policy` — the schema
  supports it, the router doesn't consume it yet.
