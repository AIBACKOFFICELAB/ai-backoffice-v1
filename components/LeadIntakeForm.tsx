"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { intakeOptions, textFields } from "@/lib/leads/intake/validation";
import { Input, Label, Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

const labels: Record<keyof typeof intakeOptions, string> = {
  propertyType: "Property type", serviceType: "Service needed", emergency: "Is this an emergency?",
  urgency: "How soon do you need service?", customerRole: "Your role", leadSource: "How did you find us?",
};
export function LeadIntakeForm({ endpoint, manual = false }: { endpoint: string; manual?: boolean }) {
  const router = useRouter();
  const identity = useRef<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      // Persist the identity (no PII) across refresh/network retries until confirmed.
      const key = `intake-v1:${endpoint}`;
      if (!identity.current) {
        try { identity.current = sessionStorage.getItem(key); } catch { /* memory still protects retries */ }
        identity.current ||= crypto.randomUUID();
        try { sessionStorage.setItem(key, identity.current); } catch { /* storage may be disabled */ }
      }
      const body = Object.fromEntries(new FormData(form));
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, sourceRef: identity.current }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "We could not confirm your request. Please retry this same submission.");
      try { sessionStorage.removeItem(key); } catch { /* confirmation still succeeded */ }
      if (manual && result?.lead?.id) { router.push(`/leads/${encodeURIComponent(result.lead.id)}`); router.refresh(); }
      setSuccess(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to confirm your request. Please retry.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { submitting.current = false; setBusy(false); }
  }
  if (success) return <Card className="space-y-3 p-6"><h2 className="text-xl font-semibold text-ink-900" tabIndex={-1} ref={node => node?.focus()}>Request received</h2><p>The team can now review your request. An appointment has not yet been confirmed.</p></Card>;
  return <form onSubmit={submit} aria-busy={busy} className="space-y-5 rounded-card bg-white p-5 shadow-card ring-1 ring-surface-border sm:p-6">
    <p className="text-sm text-ink-500">All fields are required unless marked optional.</p>
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Service request details</legend>
      {Object.entries(textFields).map(([name, field]) => {
        const long = name === "jobDescription" || name === "customerNotes";
        const props = { id: name, name, maxLength: field.max, required: field.required, autoComplete: field.autoComplete };
        return <div key={name} className={long || name === "serviceAddress" ? "sm:col-span-2" : ""}>
          <Label htmlFor={name}>{field.label}</Label>
          {long ? <Textarea {...props} rows={4} /> : <Input {...props} type={name === "email" ? "email" : name === "phone" ? "tel" : "text"} />}
        </div>;
      })}
      {(Object.keys(intakeOptions) as (keyof typeof intakeOptions)[]).map(name => <div key={name}>
        <Label htmlFor={name}>{labels[name]}</Label>
        <select id={name} name={name} required defaultValue="" className="w-full rounded-control border border-surface-border bg-white px-3.5 py-2.5 text-ink-900 focus-ring">
          <option value="" disabled>Select an option</option>
          {intakeOptions[name].map(value => <option key={value}>{value}</option>)}
        </select>
      </div>)}
      <div hidden aria-hidden="true"><label htmlFor="website">Leave empty</label><input id="website" name="website" tabIndex={-1} autoComplete="off" /></div>
    </fieldset>
    <p className="text-sm text-ink-500">This form does not confirm emergency dispatch or an appointment.</p>
    {error && <p role="alert" tabIndex={-1} ref={errorRef} className="text-sm font-medium text-red-700">{error}</p>}
    <Button type="submit" disabled={busy}>{busy ? "Submitting…" : manual ? "Create lead" : "Send service request"}</Button>
    <span className="sr-only" aria-live="polite">{busy ? "Submitting your request" : ""}</span>
  </form>;
}
