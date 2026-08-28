import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AiTaskType } from "./types";

export type ModelInvocationRecord = {
  id: string;
  tenantId: string;
  agentRunId: string | null;
  taskType: AiTaskType;
  provider: string;
  model: string;
  complexity: string | null;
  latencyPreference: string | null;
  costPreference: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
  status: "succeeded" | "failed";
  /** Sanitized, safe-to-display failure description — never the raw
   * provider error body (P0.9 Slice C, finding M-05/C.6). See
   * lib/ai/gateway.ts::normalizeProviderError. */
  error: string | null;
  /** Normalized failure category; null on success. See
   * AiGatewayErrorCategory in lib/ai/types.ts. */
  errorCategory: string | null;
};

export interface ModelInvocationStore {
  record(entry: ModelInvocationRecord): Promise<void>;
  listByAgentRun(tenantId: string, agentRunId: string): Promise<ModelInvocationRecord[]>;
}

export class SupabaseModelInvocationStore implements ModelInvocationStore {
  async record(entry: ModelInvocationRecord): Promise<void> {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.from("model_invocations").insert({
      id: entry.id,
      tenant_id: entry.tenantId,
      agent_run_id: entry.agentRunId,
      task_type: entry.taskType,
      provider: entry.provider,
      model: entry.model,
      complexity: entry.complexity,
      latency_preference: entry.latencyPreference,
      cost_preference: entry.costPreference,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      latency_ms: entry.latencyMs,
      estimated_cost_usd: entry.estimatedCostUsd,
      status: entry.status,
      error: entry.error,
      error_category: entry.errorCategory,
    });
    if (error) throw new Error(`[model_invocations] insert failed: ${error.message}`);
  }

  async listByAgentRun(tenantId: string, agentRunId: string): Promise<ModelInvocationRecord[]> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("model_invocations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("agent_run_id", agentRunId)
      .order("started_at", { ascending: true });
    if (error) throw new Error(`[model_invocations] list failed: ${error.message}`);
    return (data ?? []).map((row: Record<string, any>) => ({
      id: row.id,
      tenantId: row.tenant_id,
      agentRunId: row.agent_run_id,
      taskType: row.task_type,
      provider: row.provider,
      model: row.model,
      complexity: row.complexity,
      latencyPreference: row.latency_preference,
      costPreference: row.cost_preference,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      estimatedCostUsd: row.estimated_cost_usd,
      status: row.status,
      error: row.error,
      errorCategory: row.error_category ?? null,
    }));
  }
}

export class InMemoryModelInvocationStore implements ModelInvocationStore {
  private rows: ModelInvocationRecord[] = [];

  async record(entry: ModelInvocationRecord): Promise<void> {
    this.rows.push({ ...entry, id: entry.id ?? randomUUID() });
  }

  async listByAgentRun(tenantId: string, agentRunId: string): Promise<ModelInvocationRecord[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && r.agentRunId === agentRunId);
  }

  all(): ModelInvocationRecord[] {
    return [...this.rows];
  }
}
