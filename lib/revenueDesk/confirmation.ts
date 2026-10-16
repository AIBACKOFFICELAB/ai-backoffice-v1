/** Independent, server-owned consent boundary. Never implemented from tool
 * arguments, model text, HMAC alone, or an unverified transcript classifier.
 * No live adapter is installed: both voice providers fail closed.
 * An approved future adapter must atomically consume durable evidence for this
 * exact binding, using DB time, and allow replay only for the same booking key.
 * Corrections revoke unconsumed evidence by advancing intakeRevision.
 */
export type ConfirmationBinding = {
  tenantId: string;
  callId: string;
  leadId: string | null;
  intakeRevision: number;
  calendarId: string;
  start: string;
  end: string;
  timezone: string;
  idempotencyKey: string;
};

export interface CallerConfirmationStore {
  /** Must check persisted offered slot, affirmative evidence provenance,
   * current revision, expiry and single-use consumption in one transaction.
   * Errors/absence/ambiguity refuse authorization. No public issuer exists.
   */
  consume(binding: ConfirmationBinding): Promise<boolean>;
}
