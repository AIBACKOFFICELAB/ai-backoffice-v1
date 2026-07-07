"use client";

import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label } from "@/components/ui/Field";
import { AUDIT_URL } from "@/lib/constants";

/**
 * Supabase auth errors are usually a string `.message`, but a misconfigured
 * client (e.g. wrong/missing project URL or anon key) can surface a network
 * failure or malformed response that isn't a normal AuthError — in that case
 * `.message` may be empty or absent. Never let that reach the UI as a raw
 * object (which renders as "{}" or throws); always fall back to a safe,
 * human-readable string and leave the raw value in the console for debugging.
 */
function safeErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    const message = (err as { message: string }).message;
    if (message.trim().length > 0) return message;
  }
  if (typeof err === "string" && err.trim().length > 0) return err;
  return "We couldn't sign you in. Please check your email/password and try again, or contact support if this keeps happening.";
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") || "/dashboard";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();

      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        console.error("[login] Supabase auth error:", authError.name, authError.status, authError.message);
        setError(safeErrorMessage(authError));
        setLoading(false);
        return;
      }

      router.push(redirectTo);
    } catch (err) {
      console.error("[login] Unexpected error during sign-in:", err);
      setError(safeErrorMessage(err));
      setLoading(false);
    }
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
          <h1 className="text-center text-2xl font-bold text-ink-900">Log in</h1>
          <p className="mt-2 text-center text-sm text-ink-500">Access your Lead Inbox, dashboard, and settings.</p>

          <form onSubmit={handleLogin} className="mt-7 space-y-4" noValidate>
            {error && (
              <div role="alert" className="rounded-control bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
                {error}
              </div>
            )}

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

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
              />
            </div>

            <Button type="submit" disabled={loading} className="mt-2 w-full">
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-ink-500">
            Not a customer yet?{" "}
            <a href={AUDIT_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
              Get a free audit
            </a>
          </p>

          <div className="mt-6 border-t border-surface-border pt-5 text-center">
            <Link href="/" className="text-xs font-medium text-ink-400 hover:text-ink-700">
              ← Back to home
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
