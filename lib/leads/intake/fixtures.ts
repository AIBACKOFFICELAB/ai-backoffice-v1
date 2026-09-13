// Synthetic fixture shared by intake regression tests; never customer data.
import type { IntakePayload } from "./validation";
export const testIntake: IntakePayload = {
  sourceRef: "00000000-0000-4000-8000-000000000001", customerName: "Test Customer", phone: "+15550101234", email: "test@example.invalid",
  serviceAddress: "1 Test Street", propertyType: "Single Family Home", serviceType: "Water Heater", emergency: "No", urgency: "Flexible",
  jobDescription: "Synthetic request", preferredAppointmentTime: "Next week", customerRole: "Owner", leadSource: "Website", customerNotes: "",
};
