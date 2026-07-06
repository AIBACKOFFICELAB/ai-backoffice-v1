"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

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

export default function LoginPage() {
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
        console.error("[login] Supabase auth error:", authError);
        setError(safeErrorMessage(authError));
        setLoading(false);
        return;
      }

      // Success - redirect to dashboard or intended page
      router.push(redirectTo);
    } catch (err) {
      console.error("[login] Unexpected error during sign-in:", err);
      setError(safeErrorMessage(err));
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="w-full max-w-md">
        <div className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-slate-200">
          <h1 className="text-2xl font-bold text-slate-900 text-center">
            Sign In to AI BackOffice
          </h1>
          <p className="mt-2 text-center text-sm text-slate-600">
            Enter your credentials to access the dashboard
          </p>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            {error && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-semibold text-slate-700"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                disabled={loading}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-500"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-semibold text-slate-700"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-500"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition hover:bg-blue-700 disabled:bg-blue-400"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-600">
            Demo credentials: Use any email and password. Create an account in
            Supabase first.
          </p>

          <div className="mt-6 border-t border-slate-200 pt-6">
            <p className="text-center text-xs text-slate-500">
              <Link href="/" className="text-blue-600 hover:underline">
                Back to home
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
