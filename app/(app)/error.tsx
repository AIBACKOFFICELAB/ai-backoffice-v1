"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center rounded-card border border-red-100 bg-red-50 px-6 py-16 text-center">
      <p className="text-lg font-semibold text-red-900">Something went wrong loading this page.</p>
      <p className="mt-1.5 max-w-sm text-sm text-red-700">
        Your data is safe. Try again, and contact support if this keeps happening.
      </p>
      <Button onClick={reset} className="mt-5" variant="secondary">
        Try again
      </Button>
    </div>
  );
}
