"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea, FieldHint } from "@/components/ui/Field";

export type MissedCallRecoverySettingsData = {
  enabled: boolean;
  businessPhone: string | null;
  ownerAlertPhone: string | null;
  ownerNotificationEmail: string | null;
  intakeFormUrl: string | null;
  emergencyPhone: string | null;
  businessTagline: string | null;
  smsTemplate: string;
};

export default function MissedCallRecoverySettingsForm({ initial }: { initial: MissedCallRecoverySettingsData }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();

  function update<K extends keyof MissedCallRecoverySettingsData>(key: K, value: MissedCallRecoverySettingsData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage(null);

    try {
      const response = await fetch("/api/modules/missed-call-recovery/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      setSavedMessage("Saved!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <label className="flex items-center gap-2.5">
        <input
          id="mcr-enabled"
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          className="h-4 w-4 rounded border-surface-border text-brand-700 focus-ring"
        />
        <span className="text-sm font-medium text-ink-700">Missed Call Recovery enabled</span>
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="mcr-business-phone">Business phone</Label>
          <Input
            id="mcr-business-phone"
            value={form.businessPhone ?? ""}
            onChange={(e) => update("businessPhone", e.target.value)}
            placeholder="+17868087223"
          />
          <FieldHint>The Twilio number that receives missed calls.</FieldHint>
        </div>

        <div>
          <Label htmlFor="mcr-owner-phone">Owner notification phone</Label>
          <Input
            id="mcr-owner-phone"
            value={form.ownerAlertPhone ?? ""}
            onChange={(e) => update("ownerAlertPhone", e.target.value)}
            placeholder="+17866066944"
          />
          <FieldHint>Where you get a text every time a call is recovered.</FieldHint>
        </div>

        <div>
          <Label htmlFor="mcr-owner-email">Owner notification email</Label>
          <Input
            id="mcr-owner-email"
            type="email"
            value={form.ownerNotificationEmail ?? ""}
            onChange={(e) => update("ownerNotificationEmail", e.target.value)}
            placeholder="owner@example.com"
          />
          <FieldHint>Backup notification channel alongside the SMS alert.</FieldHint>
        </div>

        <div>
          <Label htmlFor="mcr-emergency-phone">Emergency phone</Label>
          <Input
            id="mcr-emergency-phone"
            value={form.emergencyPhone ?? ""}
            onChange={(e) => update("emergencyPhone", e.target.value)}
            placeholder="+17866066944"
          />
          <FieldHint>Given to the caller directly when a call is flagged urgent.</FieldHint>
        </div>

        <div>
          <Label htmlFor="mcr-intake-url">Intake form URL</Label>
          <Input
            id="mcr-intake-url"
            value={form.intakeFormUrl ?? ""}
            onChange={(e) => update("intakeFormUrl", e.target.value)}
            placeholder="https://bit.ly/..."
          />
          <FieldHint>Booking link sent in the recovery text.</FieldHint>
        </div>

        <div>
          <Label htmlFor="mcr-tagline">Business tagline</Label>
          <Input
            id="mcr-tagline"
            value={form.businessTagline ?? ""}
            onChange={(e) => update("businessTagline", e.target.value)}
            placeholder="The Right Way"
          />
          <FieldHint>Appears in the recovery text signature.</FieldHint>
        </div>
      </div>

      <div>
        <Label htmlFor="mcr-template">Recovery message template</Label>
        <Textarea
          id="mcr-template"
          rows={5}
          value={form.smsTemplate}
          onChange={(e) => update("smsTemplate", e.target.value)}
        />
        <FieldHint>
          Available variables: {"{{business_name}}"}, {"{{intake_form_url}}"}, {"{{emergency_phone}}"}, {"{{business_tagline}}"}
        </FieldHint>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving…" : "Save Missed Call Recovery settings"}
        </Button>
        <p id={statusId} aria-live="polite" className="text-sm">
          {error && <span className="font-medium text-red-600">{error}</span>}
          {savedMessage && <span className="font-medium text-emerald-600">{savedMessage}</span>}
        </p>
      </div>
    </form>
  );
}
