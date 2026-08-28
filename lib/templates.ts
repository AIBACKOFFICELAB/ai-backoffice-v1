/**
 * Shared `{{var}}` template rendering, extracted from the (previously
 * duplicated) private helper in lib/modules/missedCallRecovery/service.ts
 * and lib/modules/estimateFollowup/service.ts. Behavior is unchanged — this
 * is a pure de-duplication so both modules' template rendering is covered
 * by one regression test (see lib/templates.test.ts) instead of two
 * untested copies. Per docs/constitution/09_DEVELOPMENT_STANDARDS.md
 * "Shared UI primitives... once a second module needs them" — the same
 * principle applies to shared logic.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? "");
}
