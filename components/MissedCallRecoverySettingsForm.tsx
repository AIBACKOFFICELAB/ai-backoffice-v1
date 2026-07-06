"use client";

import { useState } from "react";

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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          id="mcr-enabled"
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
        />
        <label htmlFor="mcr-enabled" className="text-sm font-medium text-slate-700">
          Missed Call Recovery enabled
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Business phone (Twilio number)
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.businessPhone ?? ""}
            onChange={(e) => update("businessPhone", e.target.value)}
            placeholder="+17868087223"
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Owner notification phone
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.ownerAlertPhone ?? ""}
            onChange={(e) => update("ownerAlertPhone", e.target.value)}
            placeholder="+17866066944"
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Owner notification email
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.ownerNotificationEmail ?? ""}
            onChange={(e) => update("ownerNotificationEmail", e.target.value)}
            placeholder="owner@example.com"
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Emergency phone
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.emergencyPhone ?? ""}
            onChange={(e) => update("emergencyPhone", e.target.value)}
            placeholder="+17866066944"
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Intake form URL
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.intakeFormUrl ?? ""}
            onChange={(e) => update("intakeFormUrl", e.target.value)}
            placeholder="https://bit.ly/..."
          />
        </label>

        <label className="text-sm font-medium text-slate-700">
          Business tagline
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            value={form.businessTagline ?? ""}
            onChange={(e) => update("businessTagline", e.target.value)}
            placeholder="The Right Way"
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        Recovery message template
        <textarea
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          rows={5}
          value={form.smsTemplate}
          onChange={(e) => update("smsTemplate", e.target.value)}
        />
        <span className="mt-1 block text-xs text-slate-500">
          Available variables: {"{{business_name}}"}, {"{{intake_form_url}}"}, {"{{emergency_phone}}"}, {"{{business_tagline}}"}
        </span>
      </label>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">{error}</div>}
      {savedMessage && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-800 ring-1 ring-green-200">{savedMessage}</div>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition hover:bg-blue-700 disabled:bg-blue-400"
      >
        {saving ? "Saving..." : "Save Missed Call Recovery Settings"}
      </button>
    </form>
  );
}
