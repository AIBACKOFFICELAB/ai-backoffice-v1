import { Card } from "@/components/ui/Card";
import { ApprovalDecisionButtons } from "@/components/approvals/ApprovalDecisionButtons";

const STATUS_TONE: Record<string, string> = {
  pending: "bg-warning-50 text-warning-700",
  approved: "bg-brand-50 text-brand-700",
  rejected: "bg-danger-50 text-danger-700",
  expired: "bg-surface-sunken text-ink-500",
  executing: "bg-brand-50 text-brand-700",
  executed: "bg-success-50 text-success-700",
};

/**
 * P1 Sprint 3 §11 — a safe approval summary card. Never renders
 * `approval.payload` (the raw requested-action data) — only the fields
 * this directive explicitly allows: requested action name, risk level,
 * status, timestamps, the agent/run it came from, and a short, truncated
 * prefix of the payload_digest as a technical reference (a SHA-256 hex
 * digest is not sensitive on its own — it doesn't reveal the payload it
 * was computed from — but showing only a short prefix, not the full 64
 * hex chars, keeps this a glance-able reference rather than a copyable
 * credential-like string).
 */
export function ApprovalCard({
  requestedAction,
  riskLevel,
  status,
  createdAt,
  expiresAt,
  agentName,
  payloadDigest,
  approvalId,
  canDecide,
}: {
  requestedAction: string;
  riskLevel: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  agentName: string;
  payloadDigest: string;
  approvalId: string;
  canDecide: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink-900">{requestedAction}</p>
          <p className="mt-0.5 text-sm text-ink-500">{agentName}</p>
        </div>
        <span className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[status] ?? "bg-surface-sunken text-ink-700"}`}>{status}</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-500 sm:grid-cols-4">
        <div>
          <dt className="font-semibold uppercase tracking-wide text-ink-400">Risk</dt>
          <dd className="mt-0.5">{riskLevel}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-ink-400">Requested</dt>
          <dd className="mt-0.5">{createdAt}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-ink-400">Expires</dt>
          <dd className="mt-0.5">{expiresAt ?? "—"}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-ink-400">Reference</dt>
          <dd className="mt-0.5 font-mono">{payloadDigest.slice(0, 16)}…</dd>
        </div>
      </dl>

      {status === "pending" && (
        <div className="mt-4 border-t border-surface-border pt-3">
          <ApprovalDecisionButtons approvalId={approvalId} canDecide={canDecide} />
        </div>
      )}
    </Card>
  );
}
