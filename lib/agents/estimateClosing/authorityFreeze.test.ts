import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 5 §3 — AUTHORITY FREEZE regression proof. This sprint may add
 * telemetry and read models; it must never increase execution authority.
 * Rather than re-deriving this at runtime (the structural guarantee IS that
 * these files contain no such code path at all — see
 * shadowRunner.ts/registration.ts's own doc comments, unchanged by this
 * sprint), this test reads the actual SOURCE of every file this sprint
 * touched or added and asserts the forbidden surface is textually absent —
 * a send tool, an approval request, a toolPlan, or a customer-facing
 * secret. A regression here (someone later wiring a tool call into scan
 * telemetry, say) would be caught by this test even before any runtime
 * behavior changed.
 */

const ROOT = join(__dirname); // lib/agents/estimateClosing

/** Strips `/* ... *\/` block comments and `// ...` line comments before
 * scanning — this codebase's own convention is to document a function's
 * ABSENCE of a capability in prose ("never calls requestApproval()"),
 * which would otherwise false-positive against a naive whole-file scan.
 * Good enough for this repo's style (no forbidden pattern legitimately
 * appears inside a string literal in the files this test reads); not a
 * general-purpose JS/TS parser. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSourceWithoutComments(file: string): string {
  return stripComments(readFileSync(join(ROOT, file), "utf8"));
}

const SPRINT_5_FILES = [
  "scanTelemetry.ts",
  "stalledScan.ts",
  "scanRoute.ts",
  "operationsReadModel.ts",
  "recommendationEvidence.ts",
];

const SPRINT_6_FILES = [
  "followThroughTypes.ts",
  "followThrough.ts",
  "followThroughRoute.ts",
  "commercialEvidence.ts",
];

// Owner Evidence Persistence Hotfix — the new narrow evidence writer, plus
// the two files that now construct it by default.
const HOTFIX_FILES = ["evidenceEvent.server.ts", "review.ts", "followThrough.ts"];

// P1 Sprint 7 — Evidence & Operations Closure. Read models, a
// presentation-only incident classifier, and UI; no new write path of any
// kind, by design (§25: "read models, classification, navigation,
// presentation").
const SPRINT_7_FILES = ["evidenceTimeline.ts", "recommendationEvidence.ts", "evaluationReadModel.ts", "operationsReadModel.ts"];

// Usage-specific patterns — an actual import, call, or declaration — NOT a
// bare word match. Every file in this codebase, this test one included,
// legitimately uses these words in DOC COMMENTS to describe their own
// absence (e.g. "never calls requestApproval()"); matching prose would
// make this test fail on its own correct documentation.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+["'][^"']*toolRegistry["']/i, reason: "no scan-path or read-model file may import the tool registry" },
  { pattern: /requestApproval\s*\(/, reason: "no scan-path or read-model file may call requestApproval()" },
  { pattern: /\bsendSms\s*\(/, reason: "no scan-path or read-model file may call sendSms()" },
  { pattern: /\bsendEmail\s*\(/, reason: "no scan-path or read-model file may call sendEmail()" },
  { pattern: /["']send_message["']/, reason: "no scan-path or read-model file may reference a send_message tool" },
  { pattern: /["']call_customer["']/, reason: "no scan-path or read-model file may reference a call_customer tool" },
  { pattern: /CRON_SECRET\s*[:=]\s*["'`][^"'`]/i, reason: "the cron secret must never be hardcoded or echoed as a literal value" },
  { pattern: /toolPlan\s*[:=]/, reason: "no scan-path or read-model file may declare a toolPlan parameter/property" },
];

describe("P1 Sprint 5 authority freeze — new/touched scan-path and read-model files", () => {
  for (const file of SPRINT_5_FILES) {
    it(`${file} contains no send-tool, approval, or toolPlan surface`, () => {
      const source = readSourceWithoutComments(file);
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${file} matched forbidden pattern ${pattern} — ${reason}`).toBe(false);
      }
    });
  }

  for (const file of SPRINT_6_FILES) {
    it(`${file} contains no send-tool, approval, or toolPlan surface`, () => {
      const source = readSourceWithoutComments(file);
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${file} matched forbidden pattern ${pattern} — ${reason}`).toBe(false);
      }
    });
  }

  for (const file of HOTFIX_FILES) {
    it(`${file} contains no send-tool, approval, or toolPlan surface`, () => {
      const source = readSourceWithoutComments(file);
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${file} matched forbidden pattern ${pattern} — ${reason}`).toBe(false);
      }
    });
  }

  for (const file of SPRINT_7_FILES) {
    it(`${file} contains no send-tool, approval, or toolPlan surface (P1 Sprint 7)`, () => {
      const source = readSourceWithoutComments(file);
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        expect(pattern.test(source), `${file} matched forbidden pattern ${pattern} — ${reason}`).toBe(false);
      }
    });
  }

  it("evidenceTimeline.ts is a pure presentation function — imports no store, no Supabase client, and performs no I/O of its own (P1 Sprint 7 §25)", () => {
    const source = readSourceWithoutComments("evidenceTimeline.ts");
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase\/server["']/);
    expect(source).not.toMatch(/from\s+["']@supabase\/supabase-js["']/);
    expect(source).not.toMatch(/Store\b/);
    expect(source).not.toMatch(/\basync function\b/);
    expect(source).not.toMatch(/await\s/);
  });

  it("operationalIncidents.ts (lib/agents/) is a pure classifier — imports only the AgentRun TYPE (never a store class/instance), and never mutates or deletes a run", () => {
    const source = stripComments(readFileSync(join(ROOT, "..", "operationalIncidents.ts"), "utf8"));
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase\/server["']/);
    expect(source).toMatch(/^import \{ AgentRun \} from "\.\/runStore";$/m);
    expect(source).not.toMatch(/AgentRunStore/);
    expect(source).not.toMatch(/\.(update|delete)\s*\(/);
    expect(source).not.toMatch(/\basync function\b/);
  });

  it("revenueCommandCenter.ts's P1 Sprint 7 attention-item builders are pure — no new write call introduced alongside them", () => {
    const source = stripComments(readFileSync(join(ROOT, "..", "..", "dashboard", "revenueCommandCenter.ts"), "utf8"));
    expect(source).not.toMatch(/requestApproval\s*\(/);
    expect(source).not.toMatch(/recordOutcome\s*\(/);
    expect(source).not.toMatch(/updateLead\s*\(/);
    expect(source).not.toMatch(/\.insert\s*\(/);
  });

  it("evidenceEvent.server.ts grants write authority for ONLY the two fixed owner-evidence event types — never a general business_events INSERT surface", () => {
    const source = readSourceWithoutComments("evidenceEvent.server.ts");
    expect(source).toMatch(/estimate\.closing_recommendation_reviewed/);
    expect(source).toMatch(/estimate\.closing_recommendation_followthrough_recorded/);
    // No third event type string is ever registered in the allow-list.
    const allowListMatch = source.match(/ALLOWED_EVENT_TYPES\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
    expect(allowListMatch, "could not locate ALLOWED_EVENT_TYPES literal").not.toBeNull();
    const entries = (allowListMatch![1].match(/"[^"]+"/g) ?? []).length;
    expect(entries).toBe(2);
  });

  it("evidenceEvent.server.ts never exports the elevated/service-role client itself, and never imports a lead-mutation, outcome, approval, or tool-call store", () => {
    const source = readSourceWithoutComments("evidenceEvent.server.ts");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+eventClient/);
    expect(source).not.toMatch(/export\s*\{\s*eventClient/);
    expect(source).not.toMatch(/updateLead\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*leads\/(repository|supabase)["']/i);
    expect(source).not.toMatch(/OutcomeStore/);
    expect(source).not.toMatch(/ApprovalStore/);
    expect(source).not.toMatch(/ToolCallStore/);
    expect(source).not.toMatch(/AgentRunStore/);
  });

  it("evidenceEvent.server.ts is marked server-only and never imported into client-bundled code (followThroughTypes.ts/reviewTypes.ts stay dependency-free)", () => {
    const source = readSourceWithoutComments("evidenceEvent.server.ts");
    expect(source).toMatch(/^import ["']server-only["'];/m);
    expect(readSourceWithoutComments("followThroughTypes.ts")).not.toMatch(/evidenceEvent\.server/);
    expect(readSourceWithoutComments("reviewTypes.ts")).not.toMatch(/evidenceEvent\.server/);
  });

  it("followThrough.ts never imports a lead-mutation function or an OutcomeStore — structurally cannot mutate a lead or write a canonical outcome (P1 Sprint 6 §10/§11)", () => {
    const source = readSourceWithoutComments("followThrough.ts");
    expect(source).not.toMatch(/updateLead\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*leads\/(repository|supabase)["']/i);
    expect(source).not.toMatch(/OutcomeStore/);
    expect(source).not.toMatch(/recordOutcome\s*\(/);
  });

  it("review.ts never imports a lead-mutation function, an OutcomeStore, an ApprovalStore, or a ToolCallStore — structurally cannot mutate a lead, write an outcome, create an approval, or invoke a tool", () => {
    const source = readSourceWithoutComments("review.ts");
    expect(source).not.toMatch(/updateLead\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*leads\/(repository|supabase)["']/i);
    expect(source).not.toMatch(/OutcomeStore/);
    expect(source).not.toMatch(/ApprovalStore/);
    expect(source).not.toMatch(/ToolCallStore/);
    expect(source).not.toMatch(/recordOutcome\s*\(/);
  });

  it("commercialEvidence.ts never writes to outcomes and never imports an OutcomeStore — read-only, observation-only", () => {
    const source = readSourceWithoutComments("commercialEvidence.ts");
    expect(source).not.toMatch(/OutcomeStore/);
    expect(source).not.toMatch(/recordOutcome\s*\(/);
  });

  it("shadowRunner.ts (unchanged by this sprint) still has no toolPlan parameter and never imports the tool/approval runtime", () => {
    const source = readSourceWithoutComments("shadowRunner.ts");
    expect(source).not.toMatch(/toolPlan\s*[:=]/);
    expect(source).not.toMatch(/from\s+["'][^"']*toolRegistry["']/i);
    expect(source).not.toMatch(/requestApproval\s*\(/);
  });

  it("registration.ts (unchanged by this sprint) still registers the agent with zero capability", () => {
    const source = readFileSync(join(ROOT, "registration.ts"), "utf8");
    expect(source).toMatch(/allowedTools:\s*\[\]/);
    expect(source).toMatch(/writeScopes:\s*\[\]/);
    expect(source).toMatch(/approvalPolicy:\s*\{\}/);
  });

  it("scanTelemetry.ts never records an agent_run, model_invocation, tool_call, approval, or outcome — no such store is even imported", () => {
    const source = readFileSync(join(ROOT, "scanTelemetry.ts"), "utf8");
    expect(source).not.toMatch(/runStore|RunStore/);
    expect(source).not.toMatch(/modelInvocationStore|ModelInvocationStore/);
    expect(source).not.toMatch(/toolCallStore|ToolCallStore/);
    expect(source).not.toMatch(/approvalStore|ApprovalStore/i);
    expect(source).not.toMatch(/outcomeStore|OutcomeStore/i);
  });

  it("featureFlag.ts's ESTIMATE_CLOSING_SHADOW_ENABLED semantics are untouched by this sprint — still fail-closed on anything but the exact string 'true'", () => {
    const source = readFileSync(join(ROOT, "featureFlag.ts"), "utf8");
    expect(source).toContain('process.env.ESTIMATE_CLOSING_SHADOW_ENABLED === "true"');
  });

  it("eligibility.ts's Day 7 threshold and stalled semantics are untouched by this sprint", () => {
    const source = readFileSync(join(ROOT, "eligibility.ts"), "utf8");
    expect(source).toContain("day7DueAt");
    expect(source).not.toMatch(/day[0-9]DueAt.*-\s*[0-9]/); // no artificial time-shortening arithmetic
  });
});
