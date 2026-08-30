"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label } from "@/components/ui/Field";
import { requestPasswordReset } from "@/lib/auth/passwordRecovery";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();
    const outcome = await requestPasswordReset(supabase, email, window.location.origin);

    setMessage(outcome.message);
    setSubmitted(true);
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link href="/" className="font-display text-lg font-bold text-ink-900">
            AI BackOffice
          </Link>
        </div>
        <Card className="p-8">
          <h1 className="text-center text-2xl font-bold text-ink-900">Reset your password</h1>
          <p className="mt-2 text-center text-sm text-ink-500">
            Enter the email you use to sign in and we&apos;ll send you a link to reset your password.
          </p>

          {submitted ? (
            <div role="status" className="mt-7 rounded-control bg-brand-50 p-4 text-sm text-brand-900 ring-1 ring-brand-100">
              {message}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourbusiness.com"
                  required
                  disabled={loading}
                />
              </div>

              <Button type="submit" disabled={loading} className="mt-2 w-full">
                {loading ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}

          <div className="mt-6 border-t border-surface-border pt-5 text-center">
            <Link href="/auth/login" className="text-xs font-medium text-ink-400 hover:text-ink-700">
              ← Back to login
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
