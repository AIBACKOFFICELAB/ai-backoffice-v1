import { notFound } from "next/navigation";
import { PageTitle } from "@/components/PageTitle";
import { leads } from "@/data/mock";

export default function LeadDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const lead = leads.find((item) => item.id === params.id);
  if (!lead) notFound();

  return (
    <div className="space-y-3">
      <PageTitle title={`Lead ${lead.id}`} />
      <p>Name: {lead.name}</p>
      <p>Status: {lead.status}</p>
    </div>
  );
}
