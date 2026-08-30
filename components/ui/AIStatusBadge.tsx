import { Sparkles, Eye } from "lucide-react";

/**
 * Governance-visible AI status labeling (P1B "Shadow Mode UX" /
 * "Human Governed" principles). Never implies an action occurred when it
 * did not — "Shadow Mode" always pairs with an icon + explicit text, never
 * color alone.
 */
export function AIStatusBadge({ mode }: { mode: "shadow" | "active" }) {
  if (mode === "shadow") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-gold-50 px-2.5 py-1 text-xs font-semibold text-gold-600 ring-1 ring-gold-200">
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Shadow Mode
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">
      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
      AI Active
    </span>
  );
}
