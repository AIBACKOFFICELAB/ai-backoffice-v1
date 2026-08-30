/**
 * P1A — validates the model's raw structured-output text against
 * EstimateClosingModelOutput's shape, for use as the `validate` callback
 * ai.generateStructured<T>() requires (see MODEL_GATEWAY.md). A response
 * that fails this never reaches shadowRunner.ts as parsed data — it
 * becomes an `invalid_response` AiGatewayError instead (the gateway's own
 * "fail conservatively" behavior, not something this file re-implements).
 */

import {
  ESTIMATE_CLOSING_REASON_CODES,
  EstimateClosingModelOutput,
  EstimateClosingReasonCode,
  SUGGESTED_TIMINGS,
} from "./types";

const RECOMMENDATION_VALUES = new Set(["follow_up", "wait", "owner_review"]);
const CHANNEL_VALUES = new Set(["sms", "email", "phone", "none"]);
const REASON_CODE_VALUES = new Set<string>(ESTIMATE_CLOSING_REASON_CODES);
const TIMING_VALUES = new Set<string>(SUGGESTED_TIMINGS);

const MAX_REASON_CODES = 5;
const MAX_RATIONALE_LENGTH = 4000; // generous sanity bound, not a UI limit

export type ModelOutputValidation = { ok: true; value: EstimateClosingModelOutput } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attempts to parse `rawText` as JSON, then validates its shape. Every
 * field is checked against a fixed, bounded contract — nothing here trusts
 * free-text beyond the two string fields the model is allowed to produce
 * (rationale, which is never persisted verbatim — see shadowRunner.ts) and
 * malformed/out-of-set enum values are rejected outright rather than
 * coerced, so a confused model response fails conservatively instead of
 * silently becoming a default recommendation.
 */
export function validateEstimateClosingModelOutput(rawText: string): ModelOutputValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, errors: ["response was not valid JSON"] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ["response must be a JSON object"] };
  }

  const errors: string[] = [];

  if (typeof parsed.recommendation !== "string" || !RECOMMENDATION_VALUES.has(parsed.recommendation)) {
    errors.push(`recommendation must be one of: ${Array.from(RECOMMENDATION_VALUES).join(", ")}`);
  }

  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  let reasonCodes: EstimateClosingReasonCode[] = [];
  if (!Array.isArray(parsed.reasonCodes)) {
    errors.push("reasonCodes must be an array");
  } else if (parsed.reasonCodes.length > MAX_REASON_CODES) {
    errors.push(`reasonCodes must not exceed ${MAX_REASON_CODES} entries`);
  } else {
    const invalid = parsed.reasonCodes.filter((code) => typeof code !== "string" || !REASON_CODE_VALUES.has(code));
    if (invalid.length > 0) {
      errors.push(`reasonCodes contains unrecognized value(s): ${invalid.join(", ")}`);
    } else {
      reasonCodes = parsed.reasonCodes as EstimateClosingReasonCode[];
    }
  }

  if (typeof parsed.rationale !== "string" || parsed.rationale.trim().length === 0) {
    errors.push("rationale is required and must be a non-empty string");
  } else if (parsed.rationale.length > MAX_RATIONALE_LENGTH) {
    errors.push(`rationale exceeds the maximum allowed length (${MAX_RATIONALE_LENGTH})`);
  }

  if (typeof parsed.suggestedChannel !== "string" || !CHANNEL_VALUES.has(parsed.suggestedChannel)) {
    errors.push(`suggestedChannel must be one of: ${Array.from(CHANNEL_VALUES).join(", ")}`);
  }

  if (parsed.suggestedTiming !== null && (typeof parsed.suggestedTiming !== "string" || !TIMING_VALUES.has(parsed.suggestedTiming))) {
    errors.push(`suggestedTiming must be null or one of: ${Array.from(TIMING_VALUES).join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      recommendation: parsed.recommendation as EstimateClosingModelOutput["recommendation"],
      confidence: parsed.confidence as number,
      reasonCodes,
      rationale: parsed.rationale as string,
      suggestedChannel: parsed.suggestedChannel as EstimateClosingModelOutput["suggestedChannel"],
      suggestedTiming: parsed.suggestedTiming as EstimateClosingModelOutput["suggestedTiming"],
    },
  };
}
