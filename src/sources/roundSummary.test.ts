import { describe, expect, it } from "vitest";
import {
  ROUND_SUMMARY_MAX_CHARS,
  ROUND_SUMMARY_MIN_CHARS,
  buildRoundSummaryPrompt,
  enforceRoundSummary,
} from "./roundSummary.ts";

describe("the round summary budget", () => {
  it("fits the five-line clamp the dashboard renders", () => {
    // .round-summary p clamps at 5 lines; a line holds ~83 characters at the
    // phone width, so a perfectly packed clamp is ~417.
    expect(ROUND_SUMMARY_MAX_CHARS).toBeLessThan(417);
    expect(ROUND_SUMMARY_MAX_CHARS).toBeGreaterThan(ROUND_SUMMARY_MIN_CHARS);
  });

  it("leaves the floor high enough to fill four lines", () => {
    expect(ROUND_SUMMARY_MIN_CHARS).toBeGreaterThanOrEqual(83 * 3.5);
  });
});

describe("enforceRoundSummary", () => {
  it("never returns an em dash", () => {
    const result = enforceRoundSummary(
      "Reyes lands a check hook — Volkov staggers — and the round turns.",
    );

    expect(result).not.toContain("—");
    expect(result).toBe(
      "Reyes lands a check hook, Volkov staggers, and the round turns.",
    );
  });

  it("replaces en dashes and double hyphens used as em dashes", () => {
    expect(enforceRoundSummary("Reyes presses – Volkov circles.")).toBe(
      "Reyes presses, Volkov circles.",
    );
    expect(enforceRoundSummary("Reyes presses -- Volkov circles.")).toBe(
      "Reyes presses, Volkov circles.",
    );
  });

  it("keeps a scoreline written with a dash readable as a score", () => {
    const result = enforceRoundSummary("The writers had it 10–9 Reyes.");

    expect(result).toBe("The writers had it 10-9 Reyes.");
    expect(result).not.toContain("–");
  });

  it("collapses newlines and stray whitespace into flowing prose", () => {
    expect(enforceRoundSummary("Reyes jabs.\n\n  Volkov  answers.\n")).toBe(
      "Reyes jabs. Volkov answers.",
    );
  });

  it("strips markdown and quoting the model may add", () => {
    expect(enforceRoundSummary('"Reyes controls the round."')).toBe(
      "Reyes controls the round.",
    );
    expect(enforceRoundSummary("- Reyes controls the round.")).toBe(
      "Reyes controls the round.",
    );
    expect(enforceRoundSummary("**Reyes** controls the round.")).toBe(
      "Reyes controls the round.",
    );
  });

  it("never exceeds the budget", () => {
    const long = "Reyes lands a hard low kick and circles away. ".repeat(20);

    expect(enforceRoundSummary(long).length).toBeLessThanOrEqual(
      ROUND_SUMMARY_MAX_CHARS,
    );
  });

  it("trims an overlong summary at a sentence boundary", () => {
    const sentences =
      "Reyes opens behind a jab and takes the center early on. " +
      "Volkov answers with a body kick that lands clean and loud. " +
      "Reyes shoots a double leg and finishes it against the fence. " +
      "Volkov works back up and resets in the middle of the cage. " +
      "Reyes closes the round with a combination upstairs to finish. " +
      "Volkov digs to the body once more before the ten second clap. " +
      "Volkov protests the call but the horn sounds on that action.";
    const result = enforceRoundSummary(sentences);

    expect(result.length).toBeLessThanOrEqual(ROUND_SUMMARY_MAX_CHARS);
    expect(result.endsWith(".")).toBe(true);
    expect(result).not.toContain("Volkov protests");
  });

  it("falls back to a word boundary when one sentence overruns the budget", () => {
    const runOn = `Reyes ${"presses forward ".repeat(40)}`;
    const result = enforceRoundSummary(runOn);

    expect(result.length).toBeLessThanOrEqual(ROUND_SUMMARY_MAX_CHARS);
    expect(result.endsWith(".")).toBe(true);
    expect(result).not.toMatch(/\s\.$/);
    expect(result).not.toMatch(/[a-z]{2,}$/);
  });

  it("returns an empty string for empty or unusable model output", () => {
    expect(enforceRoundSummary("")).toBe("");
    expect(enforceRoundSummary("   \n  ")).toBe("");
  });

  it("leaves a well-sized summary untouched", () => {
    const good =
      "Reyes opens behind the jab and takes the center, digging a low kick " +
      "each time Volkov resets. Volkov answers with a body lock against the " +
      "fence but cannot finish the takedown. Reyes scrambles free and lands " +
      "the sharper counters late to close the round.";
    expect(enforceRoundSummary(good)).toBe(good);
  });
});

describe("buildRoundSummaryPrompt", () => {
  const input = {
    round: 2,
    redName: "Danilo Reyes",
    blueName: "Artem Volkov",
    commentary:
      "Volkov changes levels behind his jab and briefly puts Reyes on the canvas.",
    scorerCards: [
      { scorer: "Jay Pettry", winner: "Volkov", roundScore: "10-9" },
    ],
  };

  it("grounds the model in the round, the fighters, and the commentary", () => {
    const prompt = buildRoundSummaryPrompt(input);

    expect(prompt).toContain("Round 2");
    expect(prompt).toContain("Danilo Reyes");
    expect(prompt).toContain("Artem Volkov");
    expect(prompt).toContain(input.commentary);
  });

  it("states the character budget the dashboard enforces", () => {
    const prompt = buildRoundSummaryPrompt(input);

    expect(prompt).toContain(String(ROUND_SUMMARY_MAX_CHARS));
    expect(prompt).toContain(String(ROUND_SUMMARY_MIN_CHARS));
  });

  it("forbids em dashes explicitly", () => {
    expect(buildRoundSummaryPrompt(input).toLowerCase()).toContain("em dash");
  });

  it("passes the scorers' read of the round as grounding", () => {
    expect(buildRoundSummaryPrompt(input)).toContain("Jay Pettry");
  });

  it("omits the scorer section when no card exists yet", () => {
    const prompt = buildRoundSummaryPrompt({ ...input, scorerCards: [] });

    expect(prompt).not.toContain("Jay Pettry");
    expect(prompt).toContain(input.commentary);
  });
});
