import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { resolveNextPath } from "@/lib/auth/passwordRecovery";

/**
 * Code-exchange callback for Supabase's PKCE auth flow (password recovery
 * today; also safe for email-confirmation/magic-link style `?code=` links
 * if this project adds those later). This project's @supabase/ssr setup
 * (lib/supabase/client.ts, lib/supabase/server.ts, middleware.ts) issues
 * PKCE links, not implicit `#access_token=` links, so the code must be
 * exchanged for a session here — server-side, with the response carrying
 * the resulting cookies — before the destination page can see a session.
 *
 * `next` is resolved through a fixed allow-list (resolveNextPath) and never
 * used to build a redirect target directly: this route cannot be turned
 * into an open redirect no matter what `next` value is supplied.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = resolveNextPath(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(new URL("/auth/login", origin));
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      "[auth/callback] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY for this environment."
    );
    const failureUrl = new URL("/auth/forgot-password", origin);
    failureUrl.searchParams.set("error", "config");
    return NextResponse.redirect(failureUrl);
  }

  // The redirect response is created up front so the Supabase client's
  // setAll can attach the session cookies to it directly (the standard
  // @supabase/ssr route-handler pattern — see middleware.ts for the same
  // getAll/setAll shape used there for request-scoped session refresh).
  const response = NextResponse.redirect(new URL(next, origin));

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] exchangeCodeForSession failed:", error.name, error.status);
    const failureUrl = new URL("/auth/forgot-password", origin);
    failureUrl.searchParams.set("error", "expired");
    return NextResponse.redirect(failureUrl);
  }

  return response;
}
