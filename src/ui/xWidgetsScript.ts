/**
 * Singleton loader for the X (Twitter) widgets script.
 *
 * Rendering a `<blockquote class="twitter-tweet">` is a complete, readable
 * embed on its own (it degrades to a plain link to the post). Loading
 * platform.twitter.com/widgets.js progressively enhances it into the rich
 * embed. This module makes sure that script is requested at most once no
 * matter how many embed cards are mounted, and — critically — only when a
 * caller with a real post actually asks for it. Nothing in this module runs
 * at import time, so importing it (e.g. from a test or from fixture-mode
 * rendering with zero configured embeds) never touches the network.
 */

export const X_WIDGETS_SCRIPT_SRC = "https://platform.twitter.com/widgets.js";

export type XWidgetsState = "idle" | "loading" | "ready" | "error";

type Listener = (state: XWidgetsState) => void;

let state: XWidgetsState = "idle";
const listeners = new Set<Listener>();

function setState(next: XWidgetsState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

/**
 * Subscribe to widget-script load state. Immediately invokes `listener`
 * with the current state, then again on every transition. Returns an
 * unsubscribe function for effect cleanup.
 */
export function subscribeXWidgetsState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Injects the X widgets script into `document.head`, at most once per page
 * load. Callers must only invoke this when a real embed is actually being
 * rendered — it does not gate on post-id presence itself, that's the
 * caller's job (see `ScorecardFeed`'s embed card, which only mounts when a
 * configured post exists).
 */
export function ensureXWidgetsScript(): void {
  if (typeof document === "undefined" || state !== "idle") return;
  setState("loading");
  const script = document.createElement("script");
  script.src = X_WIDGETS_SCRIPT_SRC;
  script.async = true;
  script.addEventListener("load", () => setState("ready"));
  script.addEventListener("error", () => setState("error"));
  document.head.appendChild(script);
}
