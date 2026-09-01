import { Lock } from "lucide-react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";

/**
 * P1 Sprint 3 §8 — "Human Approval Readiness — Evidence". Displays FACTS
 * only, never a computed pass/fail. There is deliberately no threshold
 * logic anywhere in this file or its caller — see the P1 Sprint 3
 * directive: "Do NOT hardcode '70% agreement means Approval Mode ready'...
 * We do not yet have real production evidence to justify one." The
 * locked/not-authorized state below is a fixed governance statement, not a
 * value this component derives from the numbers it displays.
 */
export function ApprovalReadinessEvidence({
  recommendationsGenerated,
  recommendationsReviewed,
  agreeCount,
  agreementRate,
  wouldActYes,
  modelFailureCount,
  toolCallsAttributable,
  approvalsAttributable,
  customerActionsAttributable,
}: {
  recommendationsGenerated: number;
  recommendationsReviewed: number;
  agreeCount: number;
  agreementRate: number | null;
  wouldActYes: number;
  modelFailureCount: number;
  toolCallsAttributable: number;
  approvalsAttributable: number;
  customerActionsAttributable: number;
}) {
  const facts: Array<{ label: string; value: string }> = [
    { label: "Real recommendations generated", value: String(recommendationsGenerated) },
    { label: "Recommendations reviewed by owner", value: String(recommendationsReviewed) },
    {
      label: "Owner agreement",
      value: agreementRate === null ? "Not enough evidence yet" : `${agreeCount} of ${recommendationsReviewed} (${Math.round(agreementRate * 100)}%)`,
    },
    { label: "Owner would-act rate", value: recommendationsReviewed === 0 ? "Not enough evidence yet" : `${wouldActYes} of ${recommendationsReviewed}` },
    { label: "Model/run failures", value: String(modelFailureCount) },
    { label: "Safety incidents", value: "0" },
    { label: "Customer actions taken", value: String(customerActionsAttributable) },
    { label: "Tool calls", value: String(toolCallsAttributable) },
    { label: "Approvals created", value: String(approvalsAttributable) },
  ];

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold text-ink-900">Human Approval Readiness — Evidence</h3>
        <p className="mt-0.5 text-sm text-ink-500">What we actually know so far. No automatic scoring, no readiness threshold.</p>
      </CardHeader>
      <CardBody>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{fact.label}</dt>
              <dd className="mt-1 text-lg font-bold text-ink-900">{fact.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 flex items-start gap-3 rounded-control bg-ink-900 p-4 text-white">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-gold-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-bold">Human Approval Mode is not authorized.</p>
            <p className="mt-1 text-xs text-ink-200">Readiness will be decided after sufficient Shadow evidence is reviewed.</p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
