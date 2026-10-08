export type Entitlement = "active" | "restricted" | "revoked";

/** Subscription status -> product entitlement. Pure + exhaustively tested.
 * Only a paid-current subscription is `active`; payment trouble restricts
 * (recoverable); a canceled/ended subscription revokes. Unknown -> restricted
 * (fail closed). */
export function entitlementForStatus(status: string): Entitlement {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "canceled":
    case "incomplete_expired":
      return "revoked";
    default:
      return "restricted"; // past_due, unpaid, incomplete, paused, unknown
  }
}
