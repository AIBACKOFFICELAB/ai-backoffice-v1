/**
 * Agent Registry + Identity + Permissions types (P0.3 / P0.4).
 * See docs/AGENT_SECURITY.md.
 */

export type AgentType =
  | "supervisor"
  | "dev_test"
  | "csr_lead_recovery"
  | "estimate_closing"
  | "job_notes"
  | "proposal"
  | "reputation"
  | "accounts_receivable"
  | "contractor_communication"
  | "custom";

export type AgentStatus = "inactive" | "active" | "paused" | "archived";

/** The four-tier autonomy model from the P0 directive. */
export type AutonomyTier = "AUTO_EXECUTE" | "AUTO_EXECUTE_AND_LOG" | "REQUIRE_APPROVAL" | "HUMAN_ONLY";

/** tool/action key -> autonomy tier. Missing keys default to REQUIRE_APPROVAL
 * (see resolveTier in permissions.ts) — an agent is never auto-trusted for
 * an action nobody explicitly graded. */
export type ApprovalPolicy = Record<string, AutonomyTier>;

/** tool/action key -> routing bias passed through to the model gateway. */
export type ModelPolicy = Record<string, { complexity?: string; costPreference?: string; latencyPreference?: string }>;

export type Agent = {
  id: string;
  tenantId: string;
  agentType: AgentType;
  name: string;
  purpose: string | null;
  status: AgentStatus;
  allowedTools: string[];
  readScopes: string[];
  writeScopes: string[];
  approvalPolicy: ApprovalPolicy;
  modelPolicy: ModelPolicy;
  systemInstructions: string | null;
  instructionsVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentInput = {
  tenantId: string;
  agentType: AgentType;
  name: string;
  purpose?: string | null;
  status?: AgentStatus;
  allowedTools?: string[];
  readScopes?: string[];
  writeScopes?: string[];
  approvalPolicy?: ApprovalPolicy;
  modelPolicy?: ModelPolicy;
  systemInstructions?: string | null;
};

export type UpdateAgentInput = Partial<
  Pick<Agent, "name" | "purpose" | "status" | "allowedTools" | "readScopes" | "writeScopes" | "approvalPolicy" | "modelPolicy" | "systemInstructions">
>;

/**
 * Identity kinds the runtime must distinguish (P0.4) — human authentication
 * alone is insufficient once agents act. USER identities come from Supabase
 * auth; SERVICE identities are non-agent backend processes (cron, webhooks);
 * AGENT identities are always tenant-scoped and always resolve back to a row
 * in the agents table.
 */
export type UserActor = { type: "user"; userId: string };
export type ServiceActor = { type: "service"; serviceId: string };
export type AgentActor = { type: "agent"; agentId: string; tenantId: string };
export type Actor = UserActor | ServiceActor | AgentActor;

/** Fine-grained permissions an actor's action is checked against. */
export type Permission = "READ" | "WRITE" | "SEND" | "EXECUTE" | "APPROVE" | "DELETE" | "FINANCIAL_ACTION";
