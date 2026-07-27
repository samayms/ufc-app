import { useState } from "react";
import "./font-review.css";

export type FontVariant = {
  id: string;
  name: string;
  direction: string;
  display: string;
  ui: string;
  data: string;
  stylesheet?: string;
};

const googleFonts = (families: string) =>
  `https://fonts.googleapis.com/css2?${families}&display=swap`;

export const FONT_VARIANTS: readonly FontVariant[] = [
  {
    id: "baseline",
    name: "Current control",
    direction: "Condensed broadcast · familiar, dense, neutral",
    display: "Barlow Condensed",
    ui: "Barlow",
    data: "IBM Plex Mono",
  },
  {
    id: "archivo",
    name: "Wire service",
    direction: "Archival sports desk · sturdy and less stylized",
    display: "Archivo Narrow",
    ui: "Archivo",
    data: "IBM Plex Mono",
    stylesheet: googleFonts(
      "family=Archivo:wght@400;500;600;700&family=Archivo+Narrow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600",
    ),
  },
  {
    id: "humanist",
    name: "Humanist broadcast",
    direction: "Warmer shapes · energetic without shouting",
    display: "Asap Condensed",
    ui: "Schibsted Grotesk",
    data: "IBM Plex Mono",
    stylesheet: googleFonts(
      "family=Asap+Condensed:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700;800",
    ),
  },
  {
    id: "plex",
    name: "Technical control room",
    direction: "Engineered family · calm, precise, cohesive",
    display: "IBM Plex Sans Condensed",
    ui: "IBM Plex Sans",
    data: "IBM Plex Mono",
    stylesheet: googleFonts(
      "family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@400;500;600;700",
    ),
  },
  {
    id: "public",
    name: "Public signal",
    direction: "Direct and legible · like a live information service",
    display: "Saira Condensed",
    ui: "Public Sans",
    data: "B612 Mono",
    stylesheet: googleFonts(
      "family=B612+Mono:wght@400;700&family=Public+Sans:wght@400;500;600;700&family=Saira+Condensed:wght@400;500;600;700;800",
    ),
  },
  {
    id: "editorial",
    name: "Ringside editorial",
    direction: "Serif headlines · more authored, less dashboard-like",
    display: "Newsreader",
    ui: "Public Sans",
    data: "DM Mono",
    stylesheet: googleFonts(
      "family=DM+Mono:wght@400;500&family=Newsreader:wght@400;500;600;700&family=Public+Sans:wght@400;500;600;700",
    ),
  },
  {
    id: "poster",
    name: "Fight poster",
    direction: "One-weight display face · blunt, graphic, distinctive",
    display: "Special Gothic Condensed One",
    ui: "Familjen Grotesk",
    data: "IBM Plex Mono",
    stylesheet: googleFonts(
      "family=Familjen+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Special+Gothic+Condensed+One",
    ),
  },
  {
    id: "single",
    name: "One-family system",
    direction: "No display/mono costume · quiet and product-led",
    display: "Schibsted Grotesk",
    ui: "Schibsted Grotesk",
    data: "Schibsted Grotesk",
    stylesheet: googleFonts(
      "family=Schibsted+Grotesk:wght@400;500;600;700;800",
    ),
  },
] as const;

const fallbackVariant = FONT_VARIANTS[0]!;

export function fontVariantFromSearch(search: string): FontVariant {
  const requested = new URLSearchParams(search).get("font");
  return (
    FONT_VARIANTS.find((variant) => variant.id === requested) ?? fallbackVariant
  );
}

export function applyFontVariant(variant: FontVariant) {
  document.documentElement.dataset.fontVariant = variant.id;

  const existing = document.getElementById("font-variant-stylesheet");
  if (!variant.stylesheet) {
    existing?.remove();
    return;
  }

  const link =
    existing instanceof HTMLLinkElement
      ? existing
      : Object.assign(document.createElement("link"), {
          id: "font-variant-stylesheet",
          rel: "stylesheet",
        });
  link.href = variant.stylesheet;
  if (!link.isConnected) document.head.append(link);
}

function replaceFontQuery(variant: FontVariant) {
  const url = new URL(window.location.href);
  url.searchParams.set("font", variant.id);
  window.history.replaceState({}, "", url);
}

export function FontReviewControls() {
  const params = new URLSearchParams(window.location.search);
  const reviewEnabled = params.get("fontLab") === "1";
  const initial = fontVariantFromSearch(window.location.search);
  const [selectedId, setSelectedId] = useState(initial.id);

  if (!reviewEnabled) return null;

  const index = Math.max(
    0,
    FONT_VARIANTS.findIndex((variant) => variant.id === selectedId),
  );
  const selected = FONT_VARIANTS[index] ?? fallbackVariant;

  const selectVariant = (nextIndex: number) => {
    const normalized =
      (nextIndex + FONT_VARIANTS.length) % FONT_VARIANTS.length;
    const variant = FONT_VARIANTS[normalized] ?? fallbackVariant;
    setSelectedId(variant.id);
    applyFontVariant(variant);
    replaceFontQuery(variant);
  };

  return (
    <aside className="font-review" aria-label="Font review controls">
      <div className="font-review-heading">
        <div>
          <span className="font-review-kicker">Typeface lab</span>
          <strong>{selected.name}</strong>
        </div>
        <span className="font-review-count num">
          {index + 1}/{FONT_VARIANTS.length}
        </span>
      </div>

      <p>{selected.direction}</p>

      <div className="font-review-family-list" aria-label="Selected typefaces">
        <span>Display · {selected.display}</span>
        <span>UI · {selected.ui}</span>
        <span>Data · {selected.data}</span>
      </div>

      <div className="font-review-actions">
        <button
          type="button"
          onClick={() => selectVariant(index - 1)}
          aria-label="Previous font direction"
        >
          Prev
        </button>
        <select
          aria-label="Font direction"
          value={selectedId}
          onChange={(event) => {
            const nextIndex = FONT_VARIANTS.findIndex(
              (variant) => variant.id === event.target.value,
            );
            selectVariant(nextIndex);
          }}
        >
          {FONT_VARIANTS.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => selectVariant(index + 1)}
          aria-label="Next font direction"
        >
          Next
        </button>
      </div>
    </aside>
  );
}
