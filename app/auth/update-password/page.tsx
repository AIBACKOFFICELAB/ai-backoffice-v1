"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label, FieldError } from "@/components/ui/Field";
import { safeErrorMessage, updatePassword } from "@/lib/auth/passwordRecovery";

type SessionState = "checking" | "ready" | "missing";

function UpdatePasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Defensive: if a Supabase recovery `code` lands here directly — an
    // older cached email link, or the project's Supabase Auth URL
    // configuration not yet updated to route through /auth/callback —
    // forward it through the code-exchange callback instead of failing.
    // This page never attempts the exchange itself.
    const code = searchParams.get("code");
    if (code) {
      router.replace(`/auth/callback?code=${encodeURIComponent(code)}&next=/auth/update-password`);
      return;
    }

    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data, error: getUserError }) => {
      if (cancelled) return;
      if (getUserError || !data.user) {
        setSessionState("missing");
        return;
      }
      setSessionState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const outcome = await updatePassword(supabase, password, confirmPassword);

      if (!outcome.ok) {
        setError(outcome.error);
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);
      setTimeout(() => router.push("/dashboard"), 2000);
    } catch (err) {
      console.error("[update-password] Unexpected error:", err instanceof Error ? err.name : "unknown");
      setError(safeErrorMessage(err, "We couldn't update your password. Please try again."));
      setLoading(false);
    }
  };

  if (sessionState === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-ink-500">Loading…</p>
      </div>
    );
  }

  if (sessionState === "missing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-5 py-12">
        <div className="w-full max-w-md">
          <Card className="p-8 text-center">
            <h1 className="text-2xl font-bold text-ink-900">Link expired</h1>
            <p className="mt-2 text-sm text-ink-500">
              This password reset link is invalid or has expired. Request a new one to continue.
            </p>
            <Button href="/auth/forgot-password" className="mt-6 w-full">
              Request a new link
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-5 py-12">
        <div className="w-full max-w-md">
          <Card className="p-8 text-center">
            <h1 className="text-2xl font-bold text-ink-900">Password updated</h1>
            <p className="mt-2 text-sm text-ink-500">
              Your password has been updated. Taking you to your dashboard…
            </p>
            <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">
              Continue now →
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link href="/" className="font-display text-lg font-bold text-ink-900">
            AI BackOffice
          </Link>
        </div>
        <Card className="p-8">
          <h1 className="text-center text-2xl font-bold text-ink-900">Set a new password</h1>
          <p className="mt-2 text-center text-sm text-ink-500">Choose a new password for your account.</p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
            {error && (
              <div role="alert" className="rounded-control bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
                {error}
              </div>
            )}

            <div>
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                autoComplete="new-password"
              />
            </div>

            <div>
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                autoComplete="new-password"
              />
              {confirmPassword.length > 0 && password !== confirmPassword && (
                <FieldError>Passwords do not match.</FieldError>
              )}
            </div>

            <Button type="submit" disabled={loading} className="mt-2 w-full">
              {loading ? "Updating…" : "Update password"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default function UpdatePasswordPage() {
  return (
    <Suspense fallback={null}>
      <UpdatePasswordForm />
    </Suspense>
  );
}
