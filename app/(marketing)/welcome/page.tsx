import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export const metadata = { title: "Welcome to AI BackOffice Founder Beta" };

// Informational only. Access is granted by the server after the signed
// payment webhook is processed — never by reaching this page.
export default function WelcomePage() {
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8">
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-ink-900">Thank you — welcome to Founder Beta</h1>
        <p className="mt-3 text-ink-600">
          Once your payment is confirmed (usually within a minute), your business account is created automatically.
        </p>
        <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm text-ink-700">
          <li>Use <strong>Set / reset password</strong> below with the email you paid with.</li>
          <li>Sign in — you will land in your workspace with your onboarding steps.</li>
          <li>We schedule your Founder-assisted onboarding session.</li>
        </ol>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button href="/auth/forgot-password">Set / reset password</Button>
          <Button href="/auth/login" variant="secondary">Sign in</Button>
        </div>
        <p className="mt-6 text-xs text-ink-400">
          Not seeing access after a few minutes? Contact us with your payment email. <Link href="/pricing" className="underline">Back to pricing</Link>
        </p>
      </Card>
    </div>
  );
}
