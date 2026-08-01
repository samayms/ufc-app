import { UfcWordmark } from "./UfcWordmark.tsx";
import "./loading-splash.css";

/**
 * The very first thing shown before any dashboard data exists. Deliberately
 * wordless per product direction — no "Loading" copy, just the mark with a
 * subtle pulse so it doesn't read as frozen.
 */
export function LoadingSplash() {
  return (
    <div
      className="app-splash"
      role="status"
      aria-live="polite"
      aria-label="Assembling fight data"
    >
      <UfcWordmark className="loading-splash-mark" />
    </div>
  );
}
