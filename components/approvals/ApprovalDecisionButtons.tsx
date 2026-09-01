"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

/**
 * P1 Sprint 3 §11 — owner-only approve/reject controls for a single
 * pending approval. The server route itself is the real authorization
 * boundary (staff requests are refused with 403 regardless of what this
 * component renders) — this component hides the buttons for a non-owner
 * purely as a UX courtesy, per §11: "STAFF: Must never gain owner approval
 * authority."
 */
export function ApprovalDecisionButtons({ approvalId, canDecide }: { approvalId: string; canDecide: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canDecide) {
    return <p className="text-xs text-ink-400">Only the account owner can decide this.</p>;
  }

  async function decide(action: "approve" | "reject") {
    setPending(action);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to ${action} this request.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} this request.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" onClick={() => decide("approve")} disabled={pending !== null}>
        {pending === "approve" ? "Approving…" : "Approve"}
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => decide("reject")} disabled={pending !== null}>
        {pending === "reject" ? "Rejecting…" : "Reject"}
      </Button>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
