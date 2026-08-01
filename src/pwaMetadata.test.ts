import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
};

function pngDimensions(path: string) {
  const png = readFileSync(path);
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("home-screen app icon metadata", () => {
  it("provides the UFC icon for iOS and the web app manifest", () => {
    const html = readFileSync("index.html", "utf8");
    const manifest = JSON.parse(
      readFileSync("public/manifest.webmanifest", "utf8"),
    ) as { icons: ManifestIcon[] };

    expect(html).toContain(
      'rel="apple-touch-icon" sizes="180x180" href="/icons/ufc-app-icon-180.png"',
    );
    expect(manifest.icons).toEqual([
      {
        src: "/icons/ufc-app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/ufc-app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ]);

    for (const size of [180, 192, 512]) {
      const path = `public/icons/ufc-app-icon-${size}.png`;
      expect(existsSync(path)).toBe(true);
      expect(pngDimensions(path)).toEqual({ width: size, height: size });
    }
  });
});
