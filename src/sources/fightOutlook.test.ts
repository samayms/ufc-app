import { describe, expect, it } from "vitest";
import {
  FIGHT_OUTLOOK_MAX_CHARS,
  FIGHT_OUTLOOK_MAX_WORDS,
  FIGHT_OUTLOOK_MIN_CHARS,
  FIGHT_OUTLOOK_MIN_WORDS,
  buildFightOutlookPrompt,
  enforceFightOutlookSummary,
} from "./fightOutlook.ts";

describe("the fight outlook budget", () => {
  it("keeps the floor below the ceiling with real headroom", () => {
    expect(FIGHT_OUTLOOK_MAX_CHARS).toBeGreaterThan(FIGHT_OUTLOOK_MIN_CHARS);
    expect(FIGHT_OUTLOOK_MIN_CHARS).toBeGreaterThan(0);
  });

  it("matches the validated word budget (50-68 words, real output landed at 55-62)", () => {
    expect(FIGHT_OUTLOOK_MIN_WORDS).toBe(50);
    expect(FIGHT_OUTLOOK_MAX_WORDS).toBe(68);
  });
});

describe("enforceFightOutlookSummary", () => {
  it("never returns an em dash", () => {
    const result = enforceFightOutlookSummary(
      "Medic presses forward — Rodriguez circles — and looks for the counter.",
    );

    expect(result).not.toContain("—");
    expect(result).toBe(
      "Medic presses forward, Rodriguez circles, and looks for the counter.",
    );
  });

  it("replaces en dashes and double hyphens used as em dashes", () => {
    expect(enforceFightOutlookSummary("Medic presses – Rodriguez circles.")).toBe(
      "Medic presses, Rodriguez circles.",
    );
    expect(
      enforceFightOutlookSummary("Medic presses -- Rodriguez circles."),
    ).toBe("Medic presses, Rodriguez circles.");
  });

  it("keeps a scoreline written with a dash readable as a score", () => {
    const result = enforceFightOutlookSummary("Medic is favored 3–1 on the line.");

    expect(result).toBe("Medic is favored 3-1 on the line.");
    expect(result).not.toContain("–");
  });

  it("collapses newlines and stray whitespace into flowing prose", () => {
    expect(
      enforceFightOutlookSummary("Medic presses.\n\n  Rodriguez  answers.\n"),
    ).toBe("Medic presses. Rodriguez answers.");
  });

  it("strips markdown and quoting the model may add", () => {
    expect(enforceFightOutlookSummary('"Medic takes this fight."')).toBe(
      "Medic takes this fight.",
    );
    expect(enforceFightOutlookSummary("- Medic takes this fight.")).toBe(
      "Medic takes this fight.",
    );
    expect(enforceFightOutlookSummary("**Medic** takes this fight.")).toBe(
      "Medic takes this fight.",
    );
  });

  it("never exceeds the budget", () => {
    const long = "Medic lands a hard low kick and circles away. ".repeat(20);

    expect(enforceFightOutlookSummary(long).length).toBeLessThanOrEqual(
      FIGHT_OUTLOOK_MAX_CHARS,
    );
  });

  it("trims an overlong summary at a sentence boundary", () => {
    const sentences =
      "Medic pressures behind volume and range early in the preview's read of the fight. " +
      "Rodriguez counters with a check hook that the writer says lands clean and loud. " +
      "Medic changes levels often and the preview says he finishes a double leg against the fence. " +
      "Rodriguez scrambles back up and resets patiently in the middle of the cage each time. " +
      "Medic closes rounds with a combination upstairs that the preview says wobbles Rodriguez badly. " +
      "Rodriguez survives to the horn but the preview has him dropping a clear round to Medic there. " +
      "The writer expects Medic to keep the pace and take a clear decision on the cards.";
    const result = enforceFightOutlookSummary(sentences);

    expect(result.length).toBeLessThanOrEqual(FIGHT_OUTLOOK_MAX_CHARS);
    expect(result.endsWith(".")).toBe(true);
    expect(result).not.toContain("The writer expects");
  });

  it("falls back to a word boundary when one sentence overruns the budget", () => {
    const runOn = `Medic ${"presses forward ".repeat(40)}`;
    const result = enforceFightOutlookSummary(runOn);

    expect(result.length).toBeLessThanOrEqual(FIGHT_OUTLOOK_MAX_CHARS);
    expect(result.endsWith(".")).toBe(true);
    expect(result).not.toMatch(/\s\.$/);
    expect(result).not.toMatch(/[a-z]{2,}$/);
  });

  it("returns an empty string for empty or unusable model output", () => {
    expect(enforceFightOutlookSummary("")).toBe("");
    expect(enforceFightOutlookSummary("   \n  ")).toBe("");
  });

  it("leaves a well-sized summary untouched", () => {
    const good =
      "Medic pressures behind a heavy jab and looks to close distance, " +
      "while Rodriguez prefers to counter off the back foot and mix in " +
      "takedowns when the pace slows. Medic's volume and cardio have been " +
      "the deciding factor in his recent wins, and the preview expects " +
      "that pressure to be the difference again here.";
    expect(enforceFightOutlookSummary(good)).toBe(good);
  });
});

describe("buildFightOutlookPrompt", () => {
  const input = {
    redName: "Uros Medic",
    blueName: "Daniel Rodriguez",
    weightClass: "Welterweight",
    titleFight: false,
    rawPreviewText:
      "Medic brings heavy hands and a granite chin. Rodriguez is a durable " +
      "grinder who wants a five round fight. BETTING ODDS: Medic -150.",
  };

  it("grounds the model in the bout, the fighters, and the preview text", () => {
    const prompt = buildFightOutlookPrompt(input);

    expect(prompt).toContain("Uros Medic");
    expect(prompt).toContain("Daniel Rodriguez");
    expect(prompt).toContain("Welterweight");
    expect(prompt).toContain(input.rawPreviewText);
  });

  it("marks a title fight when the bout is one", () => {
    const prompt = buildFightOutlookPrompt({ ...input, titleFight: true });

    expect(prompt).toContain("title fight");
  });

  it("omits the title fight marker for a non-title bout", () => {
    expect(buildFightOutlookPrompt(input)).not.toContain("title fight");
  });

  it("asks for a length in words and states the hard character ceiling", () => {
    const prompt = buildFightOutlookPrompt(input);

    expect(prompt).toContain(String(FIGHT_OUTLOOK_MIN_WORDS));
    expect(prompt).toContain(String(FIGHT_OUTLOOK_MAX_WORDS));
    expect(prompt).toContain(String(FIGHT_OUTLOOK_MAX_CHARS));
  });

  it("forbids em dashes explicitly", () => {
    expect(buildFightOutlookPrompt(input).toLowerCase()).toContain("em dash");
  });

  it("tells the model not to restate betting odds numbers", () => {
    expect(buildFightOutlookPrompt(input).toLowerCase()).toContain(
      "betting odds numbers",
    );
  });

  it("tells the model to refer to fighters by surname", () => {
    expect(buildFightOutlookPrompt(input).toLowerCase()).toContain(
      "surname",
    );
  });
});
