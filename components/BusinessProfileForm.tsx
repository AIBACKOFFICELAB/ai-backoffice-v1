"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import type { TenantProfile } from "@/lib/tenant";

export function BusinessProfileForm({ initial }: { initial: TenantProfile }) {
  const [form, setForm] = useState({
    name: initial.name,
    businessType: initial.businessType ?? "",
    phone: initial.phone ?? "",
    email: initial.email ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();

  function update(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage(null);

    try {
      const res = await fetch("/api/tenant/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save business profile.");
      setSavedMessage("Saved!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save business profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="biz-name">Business name</Label>
          <Input id="biz-name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="biz-type">Trade type</Label>
          <Input
            id="biz-type"
            value={form.businessType}
            onChange={(e) => update("businessType", e.target.value)}
            placeholder="Plumbing"
          />
        </div>
        <div>
          <Label htmlFor="biz-phone">Phone</Label>
          <Input
            id="biz-phone"
            type="tel"
            value={form.phone}
            onChange={(e) => update("phone", e.target.value)}
            placeholder="+15551234567"
          />
        </div>
        <div>
          <Label htmlFor="biz-email">Email</Label>
          <Input
            id="biz-email"
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="office@yourbusiness.com"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving…" : "Save business profile"}
        </Button>
        <p id={statusId} aria-live="polite" className="text-sm">
          {error && <span className="font-medium text-red-600">{error}</span>}
          {savedMessage && <span className="font-medium text-emerald-600">{savedMessage}</span>}
        </p>
      </div>
    </form>
  );
}
