"use client";
import { Button } from "@/components/ui/Button";
export default function RequestError({ reset }: { reset: () => void }) {
  return <main className="mx-auto max-w-2xl space-y-4 p-6"><h1 className="text-2xl font-bold">Service requests are temporarily unavailable</h1><p>Please try again shortly.</p><Button onClick={reset}>Try again</Button></main>;
}
