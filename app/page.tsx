import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";

const links = [
  "/dashboard",
  "/lead-inbox",
  "/leads/lead-1001",
  "/follow-ups",
  "/review-requests",
  "/pricing",
  "/settings",
];

export default function HomePage() {
  return (
    <div className="space-y-4">
      <PageTitle title="Home" />
      <p>App Router starter is ready.</p>
      <ul className="list-disc pl-6">
        {links.map((href) => (
          <li key={href}>
            <Link className="text-blue-600 underline" href={href}>
              {href}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
