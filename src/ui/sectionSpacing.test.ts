import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./screen-transition.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function ruleFor(selector: string): string | undefined {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    (match[1] ?? "")
      .split(",")
      .map((one) => one.trim())
      .includes(selector),
  )?.[2];
}

describe("tab content keeps its parent column's rhythm", () => {
  /**
   * The wrapper sits inside a flex column that spaces its children with
   * `gap`. Left as a plain block it stops that gap at its own boundary, and
   * the panels stacked inside it — tale of the tape, recent form, stat rows —
   * end up flush against each other while everything above them is spaced.
   */
  for (const selector of [
    ".fight-screen > .screen-transition",
    ".scheduled-preview > .screen-transition",
  ]) {
    it(`${selector} lays its panels out as a spaced column`, () => {
      const body = ruleFor(selector);
      expect(body, `no rule found for ${selector}`).toBeDefined();
      expect(body).toMatch(/display:\s*flex/);
      expect(body).toMatch(/flex-direction:\s*column/);
      // `inherit`, not a literal, so the two screens' differing gaps — and
      // their per-breakpoint overrides — keep living in one place.
      expect(body).toMatch(/gap:\s*inherit/);
    });
  }
});
