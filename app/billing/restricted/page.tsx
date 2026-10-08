import Link from "next/link";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscription needs attention" };

export default function BillingRestrictedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-5 py-12">
      <Card className="max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-ink-900">Your workspace is paused</h1>
        <p className="mt-3 text-sm text-ink-600">
          We could not confirm an active AI BackOffice Founder Beta subscription for your business (a payment may have failed or the
          subscription was canceled). Your data is retained. Update your payment method or contact us to restore access.
        </p>
        <Link href="/auth/logout" className="mt-6 inline-block text-sm font-semibold text-brand-700 underline">Sign out</Link>
      </Card>
    </div>
  );
}
