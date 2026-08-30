import { describe, it, expect } from "vitest";
import { isOverdueFollowUp, isUnresolvedEmergency } from "./revenueCommandCenter";
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

const TODAY = "2026-08-30";

describe("isOverdueFollowUp", () => {
  it("is true for a due-or-past follow-up date on an open lead", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-29", status: "Contacted" }), TODAY)).toBe(true);
    expect(isOverdueFollowUp(makeLead({ followUpDate: TODAY, status: "Contacted" }), TODAY)).toBe(true);
  });

  it("is false for a future follow-up date", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-09-15", status: "Contacted" }), TODAY)).toBe(false);
  });

  it("is false with no follow-up date set", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "" }), TODAY)).toBe(false);
  });

  it("is false for a lead already Completed or Lost, even if the date is overdue", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-01", status: "Completed" }), TODAY)).toBe(false);
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-01", status: "Lost" }), TODAY)).toBe(false);
  });
});

describe("isUnresolvedEmergency", () => {
  it("is true for an emergency lead still in progress", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "New" }))).toBe(true);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Scheduled" }))).toBe(true);
  });

  it("is false for a non-emergency lead", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "No", status: "New" }))).toBe(false);
  });

  it("is false once an emergency lead reaches a terminal status", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Won" }))).toBe(false);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Lost" }))).toBe(false);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Completed" }))).toBe(false);
  });
});
