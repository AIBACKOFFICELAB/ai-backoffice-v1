import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Approval, ApprovalStatus, RequestApprovalInput } from "./types";

export type DecideApprovalInput = {
  status: Extract<ApprovalStatus, "approved" | "rejected" | "expired">;
  approverUserId?: string | null;
  reason?: string | null;
};

export interface ApprovalStore {
  create(input: RequestApprovalInput): Promise<Approval>;
  /** Human decision path: pending -> approved/rejected/expired only. Never
   * used for the executing/executed transitions — see beginExecution /
   * completeExecution below. */
  decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval>;
  getById(tenantId: string, id: string): Promise<Approval | null>;
  listByTenant(tenantId: string, opts?: { status?: ApprovalStatus }): Promise<Approval[]>;
  /**
   * Atomic, single-use claim (Codex P0 audit finding B-03): transitions
   * 'approved' -> 'executing' ONLY when both the current status is
   * 'approved' AND the stored payload_digest matches `expectedPayloadDigest`
   * exactly. Implemented as one conditional UPDATE (compare-and-swap) — two
   * concurrent callers can never both succeed, and a caller whose recomputed
   * digest doesn't match (payload tampered since approval) can never
   * succeed either. Returns null on any failure to claim (wrong status,
   * already claimed, or digest mismatch) — callers must not distinguish
   * these via a second query in a way that reintroduces a race; use a
   * read-only diagnostic lookup for error messages only, never to decide
   * whether to proceed.
   */
  beginExecution(tenantId: string, id: string, expectedPayloadDigest: string): Promise<Approval | null>;
  /** Terminal transition: 'executing' -> 'executed', always, regardless of
   * whether the underlying tool succeeded — see execution_result for the
   * outcome. Throws if the approval isn't currently 'executing' (i.e. the
   * caller didn't win beginExecution's claim). */
  completeExecution(tenantId: string, id: string, executionResult: Record<string, unknown>): Promise<Approval>;
}

function mapRow(row: Record<string, any>): Approval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentRunId: row.agent_run_id,
    requestedAction: row.requested_action,
    payload: row.payload ?? {},
    riskLevel: row.risk_level,
    status: row.status,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    approverUserId: row.approver_user_id,
    reason: row.reason,
    payloadDigest: row.payload_digest,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiresAt: row.expires_at,
    executionResult: row.execution_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseApprovalStore implements ApprovalStore {
  async create(input: RequestApprovalInput): Promise<Approval> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("approvals")
      .insert({
        tenant_id: input.tenantId,
        agent_id: input.agentId ?? null,
        agent_run_id: input.agentRunId ?? null,
        requested_action: input.requestedAction,
        payload: input.payload ?? {},
        risk_level: input.riskLevel ?? "medium",
        requested_by_type: input.requestedByType ?? "agent",
        requested_by_id: input.requestedById ?? null,
        expires_at: input.expiresAt ?? null,
        payload_digest: input.payloadDigest,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`[approvals] create failed: ${error.message}`);
    return mapRow(data);
  }

  async decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const row: Record<string, unknown> = { status: input.status, updated_at: now };
    if (input.approverUserId !== undefined) row.approver_user_id = input.approverUserId;
    if (input.reason !== undefined) row.reason = input.reason;
    if (input.status === "approved") row.approved_at = now;
    if (input.status === "rejected") row.rejected_at = now;

    const { data, error } = await supabase.from("approvals").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[approvals] decide failed: ${error.message}`);
    return mapRow(data);
  }

  async getById(tenantId: string, id: string): Promise<Approval | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("approvals").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { status?: ApprovalStatus } = {}): Promise<Approval[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("approvals").select("*").eq("tenant_id", tenantId);
    if (opts.status) query = query.eq("status", opts.status);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`[approvals] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }

  async beginExecution(tenantId: string, id: string, expectedPayloadDigest: string): Promise<Approval | null> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("approvals")
      .update({ status: "executing", updated_at: now })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "approved")
      .eq("payload_digest", expectedPayloadDigest)
      .select();
    if (error) throw new Error(`[approvals] beginExecution failed: ${error.message}`);
    if (!data || data.length !== 1) return null;
    return mapRow(data[0]);
  }

  async completeExecution(tenantId: string, id: string, executionResult: Record<string, unknown>): Promise<Approval> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("approvals")
      .update({ status: "executed", execution_result: executionResult, updated_at: now })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "executing")
      .select()
      .single();
    if (error) throw new Error(`[approvals] completeExecution failed: ${error.message}`);
    return mapRow(data);
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private rows: Approval[] = [];

  async create(input: RequestApprovalInput): Promise<Approval> {
    const now = new Date().toISOString();
    const approval: Approval = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId ?? null,
      agentRunId: input.agentRunId ?? null,
      requestedAction: input.requestedAction,
      payload: input.payload ?? {},
      riskLevel: input.riskLevel ?? "medium",
      status: "pending",
      requestedByType: input.requestedByType ?? "agent",
      requestedById: input.requestedById ?? null,
      approverUserId: null,
      reason: null,
      payloadDigest: input.payloadDigest,
      approvedAt: null,
      rejectedAt: null,
      expiresAt: input.expiresAt ?? null,
      executionResult: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(approval);
    return approval;
  }

  async decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) throw new Error(`approval ${id} not found for tenant ${tenantId}`);
    const now = new Date().toISOString();
    existing.status = input.status;
    existing.updatedAt = now;
    if (input.approverUserId !== undefined) existing.approverUserId = input.approverUserId;
    if (input.reason !== undefined) existing.reason = input.reason;
    if (input.status === "approved") existing.approvedAt = now;
    if (input.status === "rejected") existing.rejectedAt = now;
    return existing;
  }

  async getById(tenantId: string, id: string): Promise<Approval | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { status?: ApprovalStatus } = {}): Promise<Approval[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && (!opts.status || r.status === opts.status));
  }

  /** Mirrors the Supabase implementation's compare-and-swap contract
   * exactly: single-threaded JS makes the race itself impossible to
   * reproduce here, but the *predicate* (status === 'approved' AND digest
   * matches, checked together, atomically within one synchronous function
   * call) is identical, so tests against this store exercise the same
   * decision logic the real UPDATE ... WHERE clause encodes. */
  async beginExecution(tenantId: string, id: string, expectedPayloadDigest: string): Promise<Approval | null> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) return null;
    if (existing.status !== "approved" || existing.payloadDigest !== expectedPayloadDigest) return null;
    existing.status = "executing";
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  async completeExecution(tenantId: string, id: string, executionResult: Record<string, unknown>): Promise<Approval> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) throw new Error(`approval ${id} not found for tenant ${tenantId}`);
    if (existing.status !== "executing") {
      throw new Error(`approval ${id} is '${existing.status}', not 'executing' — cannot complete`);
    }
    existing.status = "executed";
    existing.executionResult = executionResult;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  all(): Approval[] {
    return [...this.rows];
  }
}
