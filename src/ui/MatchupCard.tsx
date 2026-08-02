import { type ReactNode, useLayoutEffect, useRef } from "react";
import "./newComponents.css";
import { useFighterPhoto } from "./fighterPhoto.ts";

/** Never shrink text past this fraction of its natural size — a label that
 * still doesn't fit at this size is left here and allowed to visually
 * overflow its box rather than either going illegibly small or getting
 * truncated. */
const FIT_TEXT_MIN_SCALE = 0.78;
const FIGHTER_NAME_MIN_SCALE = 0.64;

/**
 * Text that shrinks its own font-size just enough to avoid overflowing a
 * target-width box — e.g. a weight class like "Women's Flyweight" in the
 * bout row's status column. Only shrinks when the text would actually
 * overflow at its normal size; short labels render unchanged. Never
 * truncates — a label that can't fit even at the smallest readable size
 * just spills past the box instead of being cut off.
 */
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * True (sub-pixel) rendered width of `text` at a given font size, via an
 * offscreen canvas — independent of the target element's own box, which is
 * the point: scrollWidth/clientWidth on a box can never report content
 * narrower than the box itself (scrollWidth is clamped to clientWidth), so
 * comparing them can never detect "this fits with room to spare," only
 * "this overflows." Canvas measurement has no such floor.
 */
function measureTextWidth(text: string, fontSizePx: number, style: CSSStyleDeclaration): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return 0;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSizePx}px ${style.fontFamily}`;
  if ("letterSpacing" in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = style.letterSpacing;
  }
  const rendered = style.textTransform === "uppercase" ? text.toUpperCase() : text;
  return ctx.measureText(rendered).width;
}

export function FitText({
  text,
  className,
  minScale = FIT_TEXT_MIN_SCALE,
}: {
  text: string;
  className: string;
  minScale?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const FIT_SAFETY_PX = 1;

    const fit = () => {
      el.style.fontSize = "";
      const style = window.getComputedStyle(el);
      const naturalSize = parseFloat(style.fontSize);
      const boxWidth = el.clientWidth;
      if (boxWidth === 0) return; // Not laid out (e.g. hidden ancestor) — nothing to measure yet.

      const fits = (fontSizePx: number) =>
        measureTextWidth(text, fontSizePx, style) <= boxWidth - FIT_SAFETY_PX;

      if (fits(naturalSize)) return;

      const minSize = naturalSize * minScale;
      if (!fits(minSize)) {
        // Doesn't fit even at the smallest readable size — leave it there
        // and let it spill past its box rather than going smaller still.
        el.style.fontSize = `${minSize}px`;
        return;
      }

      let lo = minSize;
      let hi = naturalSize;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      el.style.fontSize = `${lo}px`;
    };

    fit();
    window.addEventListener("resize", fit);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(fit);
    resizeObserver?.observe(el);

    // The label is set in a custom webfont (--font-data). If that font is
    // still swapping in when `fit` first runs, the measurement above used
    // fallback-font metrics — re-measure once the real font is ready, or
    // some labels end up mismeasured while others coincidentally aren't,
    // depending on how each word's width differs between the two fonts.
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });

    return () => {
      cancelled = true;
      window.removeEventListener("resize", fit);
      resizeObserver?.disconnect();
    };
  }, [minScale, text]);

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}

/** Source-agnostic shape for one side of a matchup — callers adapt real data into this. */
export interface MatchupFighterEntry {
  name: string;
  photoUrl?: string;
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const last = parts.at(-1) ?? name;
  return { first, last };
}

export function MatchupFighter({
  fighter,
  corner,
  isLoser,
  isWinner,
}: {
  fighter: MatchupFighterEntry | undefined;
  corner: "red" | "blue";
  isLoser?: boolean;
  /** Tints the block with a subtle corner-colored gradient, same signal as
   *  the winner arrow. */
  isWinner?: boolean;
}) {
  const photo = useFighterPhoto(fighter?.photoUrl);
  const blueSuffix = corner === "blue" ? " is-blue" : "";
  if (!fighter) {
    return <div className={`event-card-fighter${blueSuffix}`} />;
  }
  const { first, last } = splitName(fighter.name);
  const loserSuffix = isLoser ? " is-loser" : "";
  const winnerSuffix = isWinner ? " is-winner" : "";
  return (
    <div className={`event-card-fighter${blueSuffix}${winnerSuffix}`}>
      <span
        className={`event-card-fighter-photo fighter-photo-${corner}`}
        aria-hidden={photo.isPlaceholder ? "true" : undefined}
      >
        <img
          className="fighter-photo-img"
          src={photo.src}
          alt={photo.isPlaceholder ? "" : fighter.name}
          onError={photo.onError}
        />
      </span>
      <span className={`event-card-fighter-names${blueSuffix}`}>
        <span className={`event-card-fighter-firstname${blueSuffix}${loserSuffix}`}>{first}</span>
        <FitText
          text={last}
          className={`event-card-fighter-lastname${blueSuffix}${loserSuffix}`}
          minScale={FIGHTER_NAME_MIN_SCALE}
        />
      </span>
    </div>
  );
}

/**
 * Shared "red fighter vs blue fighter" card shell — the browse-events screen
 * (EventList) and every bout-list row (CardRail, ScheduledCardRail) all use
 * this same layout so a fight looks the same wherever it's shown. The only
 * thing that varies between them is what goes in the center column: "vs" on
 * the events screen, a live/upcoming/final status chip in bout lists.
 */
export function MatchupCard({
  header,
  red,
  blue,
  redIsLoser,
  blueIsLoser,
  winnerCorner,
  center,
  centerDetail,
  isLive,
  isSelected,
  onSelect,
}: {
  header?: ReactNode;
  red: MatchupFighterEntry | undefined;
  blue: MatchupFighterEntry | undefined;
  redIsLoser?: boolean;
  blueIsLoser?: boolean;
  /** A completed bout's winner, rendered with the same corner arrow as BoutHeader. */
  winnerCorner?: "red" | "blue";
  center: ReactNode;
  /** Secondary line below the result/status, usually the weight class. */
  centerDetail?: ReactNode;
  isLive?: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`event-card${isLive ? " is-live" : ""}${isSelected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-current={isSelected ? "true" : undefined}
    >
      {header && <div className="event-card-header">{header}</div>}
      <div className="event-card-matchup">
        <MatchupFighter
          fighter={red}
          corner="red"
          isLoser={redIsLoser}
          isWinner={winnerCorner === "red"}
        />
        <span className="event-card-center">
          <span className="event-card-center-result">
            <span className="event-card-arrow-slot event-card-arrow-slot-left">
              {winnerCorner === "red" && (
                <span
                  className="tot-winner-arrow tot-winner-arrow-red event-card-winner-arrow"
                  role="img"
                  aria-label={`${red?.name ?? "Red corner"} won`}
                />
              )}
            </span>
            {center}
            <span className="event-card-arrow-slot event-card-arrow-slot-right">
              {winnerCorner === "blue" && (
                <span
                  className="tot-winner-arrow tot-winner-arrow-blue event-card-winner-arrow"
                  role="img"
                  aria-label={`${blue?.name ?? "Blue corner"} won`}
                />
              )}
            </span>
          </span>
          {centerDetail}
        </span>
        <MatchupFighter
          fighter={blue}
          corner="blue"
          isLoser={blueIsLoser}
          isWinner={winnerCorner === "blue"}
        />
      </div>
    </button>
  );
}
