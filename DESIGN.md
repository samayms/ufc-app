---
name: UFC Live Dashboard
description: A corner-colored fight terminal — private second-screen companion for live UFC cards.
colors:
  bg: "#070a12"
  surface: "#0e1423"
  surface-2: "#151d31"
  border: "#232c42"
  text: "#e8ecf5"
  text-muted: "#96a0b8"
  text-faint: "#6a7490"
  red-corner: "#e8564a"
  red-corner-strong: "#ff7365"
  red-corner-dim: "rgba(232, 86, 74, 0.16)"
  blue-corner: "#4e91f5"
  blue-corner-strong: "#79aeff"
  blue-corner-dim: "rgba(78, 145, 245, 0.16)"
  market: "#e5a83b"
  market-dim: "rgba(229, 168, 59, 0.14)"
  live: "#46c08a"
  live-dim: "rgba(70, 192, 138, 0.14)"
  danger: "#e8564a"
typography:
  display:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  body-dense:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
  label:
    fontFamily: "Fira Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    letterSpacing: "0.08em"
  data:
    fontFamily: "Fira Code, ui-monospace, monospace"
    fontFeature: "tabular-nums"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "24px"
  sp-6: "32px"
components:
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px"
  chip-live:
    backgroundColor: "{colors.live-dim}"
    textColor: "{colors.live}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  chip-final:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-muted}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  chip-upcoming:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-faint}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "1px 8px"
  badge-synthetic:
    backgroundColor: "{colors.market-dim}"
    textColor: "{colors.market}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  rail-bout:
    backgroundColor: "transparent"
    rounded: "{rounded.md}"
    padding: "8px"
  rail-bout-hover:
    backgroundColor: "{colors.surface}"
  rail-bout-selected:
    backgroundColor: "{colors.surface-2}"
---

# Design System: UFC Live Dashboard

## Overview

**Creative North Star: "The Corner-Colored Fight Terminal"**

The octagon's own red-corner/blue-corner grammar organizes every number on
screen. This is a broadcast scoreboard crossed with a betting-exchange
terminal: a near-black, blue-cast ground; dense three-panel layout; tabular
monospace numerals for every datum; and a red/blue duotone that carries bout
identity so completely that with all text removed you would still see opposing
red and blue halves on a dark terminal. It deliberately refuses the generic
KPI-card dashboard of same-size stat tiles.

The mood is operational, not promotional. Nothing glows, nothing floats, and
nothing pretends. Every data panel is stamped with when its data was fetched;
synthetic fixture data wears an amber badge; empty states say plainly what is
missing rather than inventing content. Hierarchy comes from color, position,
and density — not from decoration.

**Key Characteristics:**
- Corner duotone (red vs blue) as the primary meaning-carrier for all fight data
- Near-black blue-cast ground with three surface steps and 1px-border elevation only
- Fira Sans for UI chrome; Fira Code with tabular numerals for every datum
- Dense terminal layout: fixed fight-card rail, fluid bout center, fixed markets rail
- Honest data posture: freshness stamps, synthetic badges, no fabricated liveness

## Colors

A dark blue-cast neutral ground over which exactly three accent families speak:
the red/blue corner duotone (fighters), market amber (money), and live green
(liveness) — the duotone validated CVD-safe against the dark surface.

### Primary
- **Red Corner** (#e8564a): attributes any datum to the red-corner fighter — score cells, split-bar fills, stat bars. Doubles as the danger hue (`--danger` is the same value) for loss marks in recent form.
- **Red Corner Strong** (#ff7365): the legible text tint of red — fighter names, winning score-cell text on the dark ground.
- **Red Corner Dim** (rgba(232, 86, 74, 0.16)): the wash — winning-cell backgrounds, the tale-of-the-tape red half's gradient, loss-mark backgrounds.
- **Blue Corner** (#4e91f5): attributes any datum to the blue-corner fighter; also the app-wide focus-ring color.
- **Blue Corner Strong** (#79aeff): text tint of blue — fighter names, winning score-cell text.
- **Blue Corner Dim** (rgba(78, 145, 245, 0.16)): the blue wash — winning cells, the blue half's gradient.

### Secondary
- **Market Amber** (#e5a83b): the money-and-caveat color. Marks market source names (Kalshi, Polymarket, Sportsbooks headers) and the "Synthetic data" badge. Additionally **reserved** for market movement (odds deltas) once odds-history support lands; that reservation is currently unexercised in the build.
- **Market Amber Dim** (rgba(229, 168, 59, 0.14)): background wash behind the synthetic badge.

### Tertiary
- **Live Green** (#46c08a): liveness and wins — LIVE/END-round chips, the pulsing live dot, the "Live event" kicker, win marks in recent form.
- **Live Green Dim** (rgba(70, 192, 138, 0.14)): wash behind live chips and win marks.

### Neutral
- **Terminal Black** (#070a12): the page ground; blue-cast near-black.
- **Panel Surface** (#0e1423): panel and top-bar background; first elevation step.
- **Raised Surface** (#151d31): second step — selected rail rows, prose blocks, consensus block, neutral chips.
- **Hairline Border** (#232c42): the only elevation device — panel borders, rail dividers, table row rules.
- **Terminal White** (#e8ecf5): primary text and emphasized totals.
- **Muted Steel** (#96a0b8): secondary text — venue lines, native prices, non-winning score cells, nicknames.
- **Faint Steel** (#6a7490): tertiary text — labels, weight classes, freshness stamps, footnotes, de-emphasized losers.

### Named Rules
**The Corner Grammar Rule.** Red and blue exist to attribute data to fighters. The build's only sanctioned non-fighter uses are exactly two: blue-corner as the global focus ring, and the red hue as danger (loss marks). Do not add new non-fighter meanings to either hue.

**The Amber-Is-Money Rule.** Amber never touches fighter data. It marks the market layer (source names) and data caveats (the synthetic badge), and is reserved for market-movement deltas when odds history ships.

**The Dim Wash Rule.** Accents color backgrounds only through their `-dim` alpha variant (14–16% alpha); text on those washes uses the strong or base variant. Solid accent fills appear only in data bars (split bars, stat bars).

## Typography

**UI Font:** Fira Sans (with system-ui, sans-serif)
**Data Font:** Fira Code (with ui-monospace, monospace)

**Character:** A single humanist-grotesque family split into two voices — Fira Sans speaks the chrome, Fira Code speaks the numbers. Terse, technical, broadcast-tight. Display sizes use a slight negative tracking (-0.02em); labels use wide uppercase tracking.

### Hierarchy
- **Display** (700, 2rem): the center-status numeral of the tale of the tape ("End R3", "Jones wins"). One per screen.
- **Headline** (700, 1.5rem, lh 1.2): fighter names in the tale of the tape, tinted by corner. Drops to 1.125rem below 760px.
- **Title** (600, 1.125rem): the event name in the top bar; fighter records.
- **Body** (400, 0.9375rem, lh 1.5): base body size; market percentages.
- **Body Dense** (400–500, 0.8125rem): the workhorse — rail names, tables, prose blocks, stat rows. Prose is capped at 72ch.
- **Label** (600, 0.6875rem, tracking 0.06–0.08em, UPPERCASE): panel headings, rail segment headings, kickers, weight classes, badges. Panel `h2`s use this treatment at 0.8125rem.
- **Data** (Fira Code, tabular-nums): applied via the `.num` utility to every datum — scores, odds, moneylines, times, records, measurements. Chips also use the data face at 0.6875rem/500.

### Named Rules
**The Tabular Numeral Rule.** Every datum renders in Fira Code with `tabular-nums`. Fira Sans never carries a number that means something. Text columns inside data tables explicitly reset to the UI face.

**The Quiet Caps Rule.** All panel and section headings are small uppercase letterspaced labels. Only fighters and fight state get large type; chrome never competes with the fight.

## Layout

A three-panel terminal filling the viewport: a fixed top bar spanning all
columns, then `264px` fight-card rail / fluid `minmax(0, 1fr)` bout center /
`372px` markets rail, at `height: 100vh` with each column scrolling
independently. The center and side columns are vertical stacks of panels with a
16px gap and 16px column padding; the rail is denser (12px/8px padding, 8px row
padding).

Spacing follows the density-8 scale: 4 / 8 / 12 / 16 / 24 / 32px
(`--sp-1`…`--sp-6`). 16px (`--sp-4`) is the panel rhythm; 8px (`--sp-2`) the
in-row rhythm; 2px appears as a sub-step for tight stacks and bar gaps.

Responsive: below 1180px the side rail drops beneath the center (two columns,
rail narrows to 240px, page scrolls as one); below 760px everything stacks in
one column, the rail becomes a top section, the tale of the tape stacks
red-half / status / blue-half with left-aligned gradients, and stat rows
restack label-above-mirrored-bars.

## Elevation & Depth

Flat by doctrine. There are zero `box-shadow`s in the build. Depth is conveyed
two ways only: a 1px hairline border (#232c42) around every panel and between
regions, and the three-step tonal ladder Terminal Black → Panel Surface →
Raised Surface. Interaction states (rail hover/selected) climb that ladder
rather than lifting.

### Named Rules
**The One-Pixel Rule.** Elevation is a 1px border plus a surface step, never a shadow, glow, or blur.

## Shapes

Soft-rectangle terminal geometry, three radii deep: 12px (`--radius-lg`) for
panels and the tale of the tape; 8px (`--radius`) for interactive rows, washes,
and prose blocks; 4px for chips, result marks, and the outer caps of data bars.
The synthetic badge is the lone pill (999px). Data bars square off toward the
center: split and stat bars round only their outward corners (4px 0 0 4px / 0
4px 4px 0), meeting at a hard 2px gap of ground. Corner washes are directional
linear gradients (dim → transparent) flowing outward-in, so the red/blue halves
read as structure, not boxes.

## Components

### Panels
The universal container: Panel Surface background, 1px Hairline Border, 12px radius, 16px padding.
- **Panel head:** baseline-aligned flex row — uppercase label heading left, freshness stamp right, 12px below.
- **Freshness stamp:** Faint Steel, 0.6875rem: `as of <time>` with the time in the data face. Every data panel carries one; this is a system invariant, not decoration.

### Chips
Status capsules in the data face (0.6875rem, 500, 1px×8px padding, 4px radius).
- **Live** (`chip-live`): Live Green on green dim wash — "LIVE R3" / "END R2".
- **Final** (`chip-final`): Muted Steel on Raised Surface — the finish method.
- **Upcoming** (`chip-upcoming`): Faint Steel on Panel Surface.
- **Handle** (`chip-handle`): Muted Steel on Raised Surface — journalist @handles.
- **Synthetic badge:** the amber pill variant (uppercase label type, 2px×8px, 999px) — the only pill and the only amber badge.

### Navigation (Card Rail)
Full-width transparent buttons, 8px radius, 8px padding: two corner-tinted fighter names stacked left (13px, 500, ellipsized), status chip and weight class right. Hover fills Panel Surface (150ms ease); selected fills Raised Surface with `aria-current`. On final bouts the loser's name drops to Faint Steel/400 — the winner keeps the corner tint. Segment headings are uppercase faint labels.

### Split Bar (markets)
The signature market read: red fills from the left, blue from the right, separated by a 2px gap of ground at the red-share point; 10px tall, outer 4px caps. Percentages flank each end in the data face with native prices (cents, moneylines) beneath in Muted Steel — probabilities never hide their native quotes. The consensus variant sits on a Raised Surface wash with per-side ranges.

### Mirrored Stat Rows
Five-column grid (48px value / bar / 132px centered label / bar / 48px value): red bar grows leftward, blue rightward from a shared center, 8px tall, solid corner fills, outward caps only. Values in the data face, 600.

### Tale of the Tape
The bout's masthead: centered uppercase weight-class label, then a 1fr/auto/1fr grid — red fighter right-aligned on a leftward red gradient wash, live/round status centered (Display numeral, pulsing 8px live dot on green states), blue fighter left-aligned on a rightward blue wash. Names take Headline in corner-strong tints; metadata descends through Muted and Faint Steel.

### Round Grid
Collapsed-border table: uppercase faint column heads (R1…R5, Total), source names in the UI face, score cells centered in the data face with 1px top rules. A round's winner cell takes the corner's strong text on the corner's dim wash; ties and unscored cells stay neutral ("—"). Totals in Terminal White, 600. Below, the latest round prose sits in a Raised Surface blockquote (8px radius, 72ch max) with a source-and-time footer.

### Focus & Motion
Focus-visible on any button or link: 2px Blue Corner outline, 2px offset. Motion is limited to the 150ms ease background transition on rail rows and the 2s opacity pulse of the live dot; `prefers-reduced-motion` collapses all animation to 0.01ms.

## Do's and Don'ts

### Do:
- **Do** wrap every meaningful number in `.num` (Fira Code + tabular-nums) — scores, odds, times, records, reach.
- **Do** stamp every data panel with its freshness (`as of <time>`, Faint Steel) and label synthetic data with the amber badge.
- **Do** color fighter-attributed values by corner: strong variant for text on the dark ground, dim variant for washes, base variant for solid bar fills.
- **Do** define every color as a token in `src/index.css`; component CSS uses `var()` only — no raw hex outside the token sheet.
- **Do** write honest empty states in muted body-dense prose ("No cached history for this fighter.") instead of placeholders or invented content.
- **Do** show native market prices (cents, moneylines) alongside any implied probability, and keep the three market sources visually separate.

### Don't:
- **Don't** use shadows, glows, or blurs — elevation is a 1px border and a surface step (The One-Pixel Rule).
- **Don't** put amber on fighter data, or corner red/blue on anything but fighter attribution (plus the two sanctioned exceptions: blue focus ring, red danger).
- **Don't** animate anything except the live dot's pulse and the rail hover fill; no fake liveness — data is round-granular and says so.
- **Don't** render data numerals in Fira Sans or with proportional figures.
- **Don't** introduce same-size stat-tile grids; comparisons are always red-vs-blue mirrored structures around a center.
- **Don't** add a fourth accent family; the palette is duotone + amber + green over neutrals.
