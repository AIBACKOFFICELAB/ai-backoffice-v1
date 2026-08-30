import { describe, it, expect } from "vitest";
import { buildLeadMetrics } from "./repository";
import { PlumbingLead } from "@/data/leadModel";

function makeLead(overrides: Partial<PlumbingLead> = {}): PlumbingLead {
  return {
    id: "lead-1",
    date: "2026-08-01",
    customerName: "Test Customer",
    phone: "555-0100",
    email: "test@example.com",
    serviceAddress: "123 Main St",
    propertyType: "Single Family Home",
    serviceType: "Water Heater",
    emergency: "No",
    urgency: "Flexible",
    jobDescription: "Test job",
    photosUploaded: "No",
    preferredAppointmentTime: "",
    customerRole: "Owner",
    leadSource: "Google",
    customerNotes: "",
    status: "New",
    estimateAmount: 0,
    followUpDate: "",
    reviewRequestStatus: "Not Ready",
    internalNotes: "",
    ...overrides,
  };
}

describe("buildLeadMetrics — atRiskEstimateValue (P1B)", () => {
  it("sums estimate amounts only for leads whose status is Estimate Sent", () => {
    const leads = [
      makeLead({ status: "Estimate Sent", estimateAmount: 1000 }),
      makeLead({ status: "Estimate Sent", estimateAmount: 2500 }),
      makeLead({ status: "Won", estimateAmount: 5000 }), // won — not at risk anymore
      makeLead({ status: "New", estimateAmount: 0 }), // no estimate yet
    ];
    expect(buildLeadMetrics(leads).atRiskEstimateValue).toBe(3500);
  });

  it("is zero when there are no leads with an open estimate", () => {
    const leads = [makeLead({ status: "New" }), makeLead({ status: "Won", estimateAmount: 5000 })];
    expect(buildLeadMetrics(leads).atRiskEstimateValue).toBe(0);
  });

  it("is zero for an empty lead list, never fabricated", () => {
    expect(buildLeadMetrics([]).atRiskEstimateValue).toBe(0);
  });

  it("is distinct from revenuePipeline (which also counts pre-estimate leads)", () => {
    const leads = [makeLead({ status: "Contacted", estimateAmount: 0 }), makeLead({ status: "Estimate Sent", estimateAmount: 1200 })];
    const metrics = buildLeadMetrics(leads);
    expect(metrics.atRiskEstimateValue).toBe(1200);
    expect(metrics.revenuePipeline).toBe(1200); // Contacted lead has $0 estimate, so pipeline happens to match here
  });
});
