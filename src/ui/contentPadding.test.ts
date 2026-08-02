import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./dashboard.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
}

function rules(): Rule[] {
  // Every rule block is flat (no nesting inside a rule), so the inner-most
  // brace pair a scan finds is always one rule — @media wrappers are simply
  // skipped over rather than needing to be parsed.
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: (match[1] ?? "").split(",").map((one) => one.trim()),
    body: match[2] ?? "",
  }));
}

const declaresPadding = (body: string) =>
  /(^|[;{\s])padding(-top|-right|-bottom|-left)?\s*:/.test(body);

describe(".app-content-underlay geometry", () => {
  /**
   * The underlay is the swipe-back gesture's live preview of the screen back
   * leads to: it sits exactly on top of .app-content and hands off to it the
   * instant the gesture completes. Any box-model difference between the two
   * therefore shows up as content visibly jumping at that handoff — which is
   * exactly what a responsive override applied to only one of them caused
   * (a phone-sized `padding-top: 7px` against the underlay's inherited
   * 11px, i.e. a 4px "slight scroll up" the moment you finished swiping
   * back).
   */
  it("takes its padding from the same rules as .app-content, at every breakpoint", () => {
    const mismatched = rules()
      .filter(
        (rule) =>
          declaresPadding(rule.body) &&
          (rule.selectors.includes(".app-content") ||
            rule.selectors.includes(".app-content-underlay")),
      )
      .filter(
        (rule) =>
          !(
            rule.selectors.includes(".app-content") &&
            rule.selectors.includes(".app-content-underlay")
          ),
      )
      .map((rule) => rule.selectors.join(", "));

    expect(mismatched).toEqual([]);
  });
});
