import { describe, expect, it } from "vitest";

import { serveStaticSpa, type StaticSpaResponse } from "./staticSpa.ts";

class Response implements StaticSpaResponse {
  status: number | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  end(body?: string): void { this.body = body; }
}

function reader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<Uint8Array> => {
    const value = files[path];
    if (value === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return new TextEncoder().encode(value);
  };
}

const ROOT = "/app/dist";

describe("serveStaticSpa", () => {
  it("serves built assets with a matching content type", async () => {
    const response = new Response();
    await expect(serveStaticSpa({
      pathname: "/assets/app.js", response, distDirectory: ROOT,
      read: reader({ "/app/dist/assets/app.js": "console.log(1)" }),
    })).resolves.toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers?.["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers?.["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("serves index.html for root and safe extensionless SPA routes", async () => {
    const read = reader({ "/app/dist/index.html": "<div id=\"root\"></div>" });
    for (const pathname of ["/", "/fight/123"]) {
      const response = new Response();
      await expect(serveStaticSpa({ pathname, response, distDirectory: ROOT, read })).resolves.toBe(true);
      expect(response.status).toBe(200);
      expect(response.headers?.["Content-Type"]).toBe("text/html; charset=utf-8");
    }
  });

  it("does not turn missing static assets into SPA responses", async () => {
    const response = new Response();
    await expect(serveStaticSpa({
      pathname: "/assets/missing.js", response, distDirectory: ROOT,
      read: reader({ "/app/dist/index.html": "shell" }),
    })).resolves.toBe(false);
    expect(response.status).toBeUndefined();
  });

  it("rejects decoded traversal and malformed encoded paths", async () => {
    for (const pathname of ["/%2e%2e/secret", "/%ZZ"]) {
      const response = new Response();
      await expect(serveStaticSpa({ pathname, response, distDirectory: ROOT, read: reader({}) })).resolves.toBe(true);
      expect(response.status).toBe(404);
    }
  });
});
