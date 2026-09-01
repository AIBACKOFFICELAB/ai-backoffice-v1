import { describe, it, expect } from "vitest";
import { isEffectivelyExpired, classifyApprovalBucket } from "./display";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const PAST = "2026-09-01T11:00:00.000Z";
const FUTURE = "2026-09-01T13:00:00.000Z";

describe("isEffectivelyExpired", () => {
  it("is true for a pending approval whose expiresAt has already passed", () => {
    expect(isEffectivelyExpired({ status: "pending", expiresAt: PAST }, NOW)).toBe(true);
  });

  it("is false for a pending approval whose expiresAt is still in the future", () => {
    expect(isEffectivelyExpired({ status: "pending", expiresAt: FUTURE }, NOW)).toBe(false);
  });

  it("is false for a pending approval with no expiresAt at all", () => {
    expect(isEffectivelyExpired({ status: "pending", expiresAt: null }, NOW)).toBe(false);
  });

  it("is false for a non-pending approval, even with a past expiresAt (already decided/expired)", () => {
    expect(isEffectivelyExpired({ status: "approved", expiresAt: PAST }, NOW)).toBe(false);
    expect(isEffectivelyExpired({ status: "rejected", expiresAt: PAST }, NOW)).toBe(false);
    expect(isEffectivelyExpired({ status: "expired", expiresAt: PAST }, NOW)).toBe(false);
  });
});

describe("classifyApprovalBucket", () => {
  it("classifies a genuinely pending approval as 'pending'", () => {
    expect(classifyApprovalBucket({ status: "pending", expiresAt: FUTURE }, NOW)).toBe("pending");
    expect(classifyApprovalBucket({ status: "pending", expiresAt: null }, NOW)).toBe("pending");
  });

  it("classifies a pending-but-past-deadline approval as 'expired', not 'pending'", () => {
    expect(classifyApprovalBucket({ status: "pending", expiresAt: PAST }, NOW)).toBe("expired");
  });

  it("classifies approved/executing/executed as 'approved'", () => {
    expect(classifyApprovalBucket({ status: "approved", expiresAt: null }, NOW)).toBe("approved");
    expect(classifyApprovalBucket({ status: "executing", expiresAt: null }, NOW)).toBe("approved");
    expect(classifyApprovalBucket({ status: "executed", expiresAt: null }, NOW)).toBe("approved");
  });

  it("classifies rejected as 'rejected'", () => {
    expect(classifyApprovalBucket({ status: "rejected", expiresAt: null }, NOW)).toBe("rejected");
  });

  it("classifies an already-expired-in-the-database approval as 'expired'", () => {
    expect(classifyApprovalBucket({ status: "expired", expiresAt: PAST }, NOW)).toBe("expired");
  });
});
