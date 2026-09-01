import { Approval } from "./types";

/**
 * P1 Sprint 3 — a still-`pending` approval whose deadline has already
 * passed is not safely decidable, but the backend only converts it to
 * `expired` LAZILY, on the next approve/reject attempt (see
 * service.ts::expireIfPastDeadline) — never eagerly, never on a plain
 * read. A read-only page must therefore derive "is this effectively
 * expired" itself rather than trusting `status` alone (Codex review
 * finding on PR #21: without this, a pending-past-deadline approval
 * displayed under "Pending" with active decision buttons, and — before
 * the accompanying service.ts fix — REJECT would even succeed on it,
 * landing it on a misleading terminal status instead of "expired").
 */
export function isEffectivelyExpired(approval: Pick<Approval, "status" | "expiresAt">, now: Date = new Date()): boolean {
  return approval.status === "pending" && approval.expiresAt !== null && new Date(approval.expiresAt) < now;
}

export type ApprovalDisplayBucket = "pending" | "approved" | "rejected" | "expired";

/** The bucket an approval renders under — NOT simply `approval.status`,
 * for the same reason as isEffectivelyExpired above. */
export function classifyApprovalBucket(approval: Pick<Approval, "status" | "expiresAt">, now: Date = new Date()): ApprovalDisplayBucket {
  if (isEffectivelyExpired(approval, now)) return "expired";
  switch (approval.status) {
    case "pending":
      return "pending";
    case "approved":
    case "executing":
    case "executed":
      return "approved";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
  }
}
