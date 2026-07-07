"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/Field";

const trades = ["Plumbing", "HVAC", "Electrical", "Roofing", "Cleaning", "Other"];

export function LeadCaptureForm() {
  const searchParams = useSearchParams();
  const plan = searchParams.get("plan");

  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    const form = new FormData(e.currentTarget);
    const businessName = String(form.get("businessName") || "").trim();
    if (!businessName) {
      setError("Business name is required.");
      setStatus("error");
      return;
    }

    try {
      const res = await fetch("/api/prospects/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactName: form.get("contactName") || undefined,
          email: form.get("email") || undefined,
          phone: form.get("phone") || undefined,
          businessType: form.get("businessType") || undefined,
          message: plan ? `[Interested in ${plan} plan] ${form.get("message") || ""}`.trim() : form.get("message") || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || "Something went wrong. Please try again.");
      }

      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-card border border-emerald-200 bg-emerald-50 p-8 text-center">
        <p className="text-lg font-semibold text-emerald-900">Request received.</p>
        <p className="mt-1.5 text-sm text-emerald-800">
          We&apos;ll review your business and follow up within one business day to schedule your free missed-call audit.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={status === "submitting"}>
      {plan && (
        <p className="rounded-control bg-brand-50 px-3.5 py-2 text-sm font-medium text-brand-800">
          Interested in the <span className="font-semibold">{plan}</span> plan
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="businessName">Business name *</Label>
          <Input id="businessName" name="businessName" required placeholder="Rivera Plumbing Co." />
        </div>
        <div>
          <Label htmlFor="contactName">Your name</Label>
          <Input id="contactName" name="contactName" placeholder="Jordan Rivera" />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@yourbusiness.com" />
        </div>
        <div>
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" type="tel" placeholder="(555) 123-4567" />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="businessType">Trade</Label>
          <select
            id="businessType"
            name="businessType"
            className="w-full rounded-control border border-surface-border bg-white px-3.5 py-2.5 text-[15px] text-ink-900 focus-ring"
            defaultValue=""
          >
            <option value="" disabled>
              Select your trade
            </option>
            {trades.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="message">What&apos;s costing you the most jobs right now?</Label>
          <Textarea id="message" name="message" rows={3} placeholder="Optional, but it helps us prep your audit." />
        </div>
      </div>

      {error && <FieldError>{error}</FieldError>}

      <Button type="submit" disabled={status === "submitting"} className="w-full sm:w-auto">
        {status === "submitting" ? "Sending…" : "Get My Free Missed-Call Audit"}
      </Button>
      <p className="text-xs text-ink-400">No credit card. We&apos;ll reply within one business day.</p>
    </form>
  );
}
