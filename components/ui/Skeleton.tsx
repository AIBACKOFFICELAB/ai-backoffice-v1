export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-control bg-surface-sunken ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-card bg-white p-5 shadow-card ring-1 ring-surface-border">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="mt-3 h-6 w-1/2" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-2/3" />
    </div>
  );
}
