import { describe, it, expect } from "vitest";
import { labelReasonCode, labelRecommendation, labelChannel, labelTiming } from "./labels";
import { ESTIMATE_CLOSING_REASON_CODES, SUGGESTED_TIMINGS } from "./types";

describe("labels", () => {
  it("has a human-readable label for every known reason code", () => {
    for (const code of ESTIMATE_CLOSING_REASON_CODES) {
      const label = labelReasonCode(code);
      expect(label).not.toBe(code);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("has a human-readable label for every known suggested timing", () => {
    for (const timing of SUGGESTED_TIMINGS) {
      const label = labelTiming(timing);
      expect(label).not.toBe(timing);
    }
  });

  it("returns null timing as null, not a placeholder string", () => {
    expect(labelTiming(null)).toBeNull();
  });

  it("degrades safely for an unrecognized value instead of rendering undefined", () => {
    expect(labelReasonCode("some_future_code")).toBe("some_future_code");
    expect(labelRecommendation("some_future_value")).toBe("some_future_value");
    expect(labelChannel("carrier_pigeon")).toBe("carrier_pigeon");
  });

  it("labels every recommendation type and channel", () => {
    expect(labelRecommendation("follow_up")).toBe("Follow up");
    expect(labelRecommendation("wait")).toBe("Wait");
    expect(labelRecommendation("owner_review")).toBe("Needs your review");
    expect(labelChannel("sms")).toBe("Text message");
    expect(labelChannel("none")).toBe("No contact suggested");
  });
});
