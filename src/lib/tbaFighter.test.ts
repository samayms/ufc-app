import { describe, expect, it } from "vitest";
import { fighterDisplayName, isTbaFighter, isTbaMatchup } from "./tbaFighter.ts";

describe("unannounced fighters", () => {
  it("recognises every shape ESPN sends for an unnamed side", () => {
    expect(isTbaFighter("TBA TBA")).toBe(true);
    expect(isTbaFighter("Opponent TBA")).toBe(true);
    expect(isTbaFighter("TBA")).toBe(true);
    expect(isTbaFighter("tba")).toBe(true);
  });

  it("leaves real fighters alone", () => {
    expect(isTbaFighter("Islam Makhachev")).toBe(false);
    expect(isTbaFighter("Ian Machado Garry")).toBe(false);
    expect(isTbaFighter(undefined)).toBe(false);
    // A name that merely contains those letters is not a placeholder.
    expect(isTbaFighter("Tbarek Ali")).toBe(false);
  });

  it("collapses the filler first name to a bare TBA", () => {
    expect(fighterDisplayName("Opponent TBA")).toBe("TBA");
    expect(fighterDisplayName("TBA TBA")).toBe("TBA");
    expect(fighterDisplayName("Dan Hooker")).toBe("Dan Hooker");
  });

  it("treats a matchup as unannounced when either side is", () => {
    expect(isTbaMatchup("TBA TBA", "Opponent TBA")).toBe(true);
    expect(isTbaMatchup("Dan Hooker", "Opponent TBA")).toBe(true);
    expect(isTbaMatchup("Opponent TBA", "Dan Hooker")).toBe(true);
    expect(isTbaMatchup("Dan Hooker", "Salahdine Parnasse")).toBe(false);
  });
});
