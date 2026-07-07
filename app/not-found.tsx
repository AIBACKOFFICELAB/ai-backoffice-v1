import Link from "next/link";
import { Button } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
      <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-brand-700">404</p>
      <h1 className="mt-3 text-2xl font-bold text-ink-900">We couldn&apos;t find that page</h1>
      <p className="mt-2 max-w-sm text-ink-500">It may have been moved or the link is out of date.</p>
      <Button href="/" className="mt-6">
        Back to home
      </Button>
      <Link href="/auth/login" className="mt-4 text-sm font-medium text-brand-700 hover:underline">
        Or log in to your account
      </Link>
    </div>
  );
}
