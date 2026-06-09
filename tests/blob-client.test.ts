import { describe, expect, it } from "vitest";

import { type BlobHttp, HttpBlobClient, httpBaseFromWs } from "@/sync/blob-client";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

// Фейковый HTTP: отвечает по таблице статусов, записывает запросы.
const fakeHttp = (
  responses: Record<string, { status: number; arrayBuffer?: ArrayBuffer }>,
  log: { method: string; url: string; auth?: string; body?: ArrayBuffer }[] = [],
): BlobHttp => {
  return async (req) => {
    log.push({ method: req.method, url: req.url, auth: req.headers?.authorization, body: req.body });
    const r = responses[req.method] ?? { status: 404 };
    return { status: r.status, arrayBuffer: r.arrayBuffer ?? new ArrayBuffer(0) };
  };
};

describe("httpBaseFromWs", () => {
  it("ws→http, wss→https, без хвостового слеша", () => {
    expect(httpBaseFromWs("ws://localhost:3000")).toBe("http://localhost:3000");
    expect(httpBaseFromWs("wss://obs.progkit.dev/")).toBe("https://obs.progkit.dev");
    expect(httpBaseFromWs("wss://h//")).toBe("https://h");
  });
});

describe("HttpBlobClient", () => {
  it("has: HEAD 200 → true, 404 → false; шлёт токен", async () => {
    const log: { method: string; url: string; auth?: string }[] = [];
    const present = new HttpBlobClient("http://s", "tok", fakeHttp({ HEAD: { status: 200 } }, log));
    expect(await present.has("h1")).toBe(true);
    expect(log[0]?.auth).toBe("Bearer tok");
    expect(log[0]?.url).toBe("http://s/blob/h1");

    const missing = new HttpBlobClient("http://s", "tok", fakeHttp({ HEAD: { status: 404 } }));
    expect(await missing.has("h1")).toBe(false);
  });

  it("upload: 2xx → ok, иначе ok=false со статусом", async () => {
    const ok = new HttpBlobClient("http://s", "t", fakeHttp({ PUT: { status: 201 } }));
    expect(await ok.upload("h", enc("x"))).toEqual({ ok: true, status: 201 });

    const tooLarge = new HttpBlobClient("http://s", "t", fakeHttp({ PUT: { status: 413 } }));
    expect(await tooLarge.upload("h", enc("x"))).toEqual({ ok: false, status: 413 });
  });

  it("download: 200 → байты, 404 → null", async () => {
    const data = enc("payload");
    const has = new HttpBlobClient("http://s", "t", fakeHttp({ GET: { status: 200, arrayBuffer: data } }));
    expect(await has.download("h")).toBe(data);

    const none = new HttpBlobClient("http://s", "t", fakeHttp({ GET: { status: 404 } }));
    expect(await none.download("h")).toBeNull();
  });
});
