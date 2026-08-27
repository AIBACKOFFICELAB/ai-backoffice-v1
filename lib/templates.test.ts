import { describe, it, expect } from "vitest";
import { renderTemplate } from "./templates";

describe("renderTemplate", () => {
  it("substitutes known variables", () => {
    expect(renderTemplate("Hi {{customer_name}}, re: {{service_type}}", { customer_name: "Jane", service_type: "Water Heater" })).toBe(
      "Hi Jane, re: Water Heater"
    );
  });

  it("replaces unknown variables with an empty string rather than leaving the placeholder", () => {
    expect(renderTemplate("Hi {{customer_name}}", {})).toBe("Hi ");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ customer_name }}", { customer_name: "Jane" })).toBe("Hi Jane");
  });

  it("leaves plain text untouched", () => {
    expect(renderTemplate("no variables here", { unused: "x" })).toBe("no variables here");
  });
});
