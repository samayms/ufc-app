import { useState } from "react";
import defaultFighterHeadshot from "../assets/default-fighter-headshot.png";

/**
 * The stand-in headshot for a fighter with no photo of their own — an
 * announced-but-unnamed opponent ("TBA"), someone ESPN has no portrait for,
 * or a portrait whose URL 404s at load time.
 *
 * It's ESPN's own generic silhouette (a.espncdn.com/i/headshots/nophoto.png),
 * vendored rather than hotlinked so a missing photo never depends on a
 * network round-trip, and so the app keeps rendering the same placeholder if
 * that URL ever moves. Transparent background, so the avatar circle's own
 * corner-tinted gradient still shows through exactly as it does behind a
 * real headshot.
 */
export const DEFAULT_FIGHTER_PHOTO: string = defaultFighterHeadshot;

export function resolveFighterPhoto(
  photoUrl: string | undefined,
  failedUrl: string | undefined,
): { src: string; isPlaceholder: boolean } {
  const isPlaceholder = !photoUrl || failedUrl === photoUrl;
  return {
    src: isPlaceholder ? DEFAULT_FIGHTER_PHOTO : photoUrl,
    isPlaceholder,
  };
}

/**
 * Resolves which image an avatar should show, falling back to the shared
 * placeholder both when no URL was supplied and when the supplied one fails
 * to load. Callers render an <img> unconditionally and spread the result —
 * every fighter gets a portrait-shaped avatar, so a card with a TBA opponent
 * has the same silhouette as the rest of the card rather than a lone text
 * badge among photos.
 */
export function useFighterPhoto(photoUrl: string | undefined): {
  src: string;
  /** True when the placeholder is showing, i.e. the image carries no
   *  information the fighter's adjacent name doesn't already give. */
  isPlaceholder: boolean;
  onError: () => void;
} {
  // Track the URL that failed rather than a permanent boolean. BoutHeader is
  // reused while navigating between fights; a failure on the previous
  // fighter must not poison the next fighter's valid ESPN portrait.
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  const resolved = resolveFighterPhoto(photoUrl, failedUrl);
  return {
    ...resolved,
    onError: () => setFailedUrl(photoUrl),
  };
}
