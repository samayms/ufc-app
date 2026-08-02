import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoutHeader } from "./BoutHeader.tsx";
import { MatchupCard } from "./MatchupCard.tsx";
import { DEFAULT_FIGHTER_PHOTO } from "./fighterPhoto.ts";
import type { Fighter } from "../schema.ts";

const fighter = (name: string): Fighter =>
  ({ name, record: { wins: 0, losses: 0, draws: 0 } }) as Fighter;

function imgs(markup: string): { src: string; alt: string }[] {
  return [...markup.matchAll(/<img[^>]*>/g)].map((m) => ({
    src: /src="([^"]*)"/.exec(m[0])?.[1] ?? "",
    alt: /alt="([^"]*)"/.exec(m[0])?.[1] ?? "",
  }));
}

const boutHeader = (photos?: { red?: string; blue?: string }) =>
  renderToStaticMarkup(
    <BoutHeader
      weightClassLabel="WELTERWEIGHT"
      titleFight={false}
      scheduledRounds={3}
      fighters={{ red: fighter("Islam Makhachev"), blue: fighter("TBA") }}
      status="upcoming"
      {...(photos ? { photosByCorner: photos } : {})}
    />,
  );

describe("missing fighter photos", () => {
  it("shows the shared silhouette instead of a text badge on the bout header", () => {
    // A TBA opponent, or anyone ESPN has no portrait for, still gets a
    // portrait-shaped avatar so a card doesn't mix photos with lone initials.
    const rendered = imgs(boutHeader());
    expect(rendered).toHaveLength(2);
    expect(rendered.every((img) => img.src === DEFAULT_FIGHTER_PHOTO)).toBe(true);
  });

  it("keeps a real headshot where one exists, alongside a placeholder", () => {
    const rendered = imgs(boutHeader({ red: "https://espn.example/islam.png" }));
    expect(rendered[0]?.src).toBe("https://espn.example/islam.png");
    expect(rendered[0]?.alt).toBe("Islam Makhachev");
    expect(rendered[1]?.src).toBe(DEFAULT_FIGHTER_PHOTO);
  });

  it("leaves the placeholder out of the accessibility tree", () => {
    // The fighter's name is already rendered next to the avatar, so a
    // silhouette that announced itself would just be noise.
    const placeholder = imgs(boutHeader())[0];
    expect(placeholder?.alt).toBe("");
    expect(boutHeader()).toContain('aria-hidden="true"');
  });

  it("shows the silhouette on event rows and bout lists too", () => {
    const markup = renderToStaticMarkup(
      <MatchupCard
        red={{ name: "TBA" }}
        blue={{ name: "Ian Machado Garry", photoUrl: "https://espn.example/garry.png" }}
        center={<span>vs</span>}
        isSelected={false}
        onSelect={() => {}}
      />,
    );
    const rendered = imgs(markup);
    expect(rendered.map((img) => img.src)).toEqual([
      DEFAULT_FIGHTER_PHOTO,
      "https://espn.example/garry.png",
    ]);
  });

  it("never falls back to initials anywhere", () => {
    expect(boutHeader()).not.toMatch(/>IM</);
    expect(boutHeader()).not.toMatch(/>T</);
  });
});
