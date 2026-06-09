import { encodeHlc } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import type { BlobClient } from "@/sync/blob-client";
import { createHlcGenerator } from "@/sync/hlc";
import { type AttachmentDeps, SyncEngine } from "@/sync/sync-engine";
import { VaultWatcher } from "@/sync/vault-watcher";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

const noBlob: BlobClient = {
  has: async () => false,
  upload: async () => ({ ok: true, status: 201 }),
  download: async () => null,
};

const setup = () => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => (last = h),
  });
  const attachments: AttachmentDeps = { blob: noBlob };
  const engine = new SyncEngine(vault, transport, gen, undefined, attachments);
  return { vault, transport, engine };
};

describe("SyncEngine: .canvas синкается как текст (как .md)", () => {
  it("локальный .canvas → upsert (текст), не attach", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("board.canvas", '{"nodes":[]}');
    await engine.handleLocalUpsert("board.canvas");
    expect(transport.sent.at(-1)?.delta).toMatchObject({
      op: "upsert",
      path: "board.canvas",
      content: '{"nodes":[]}',
    });
  });

  it("handleLocalAttach игнорирует .canvas (это текст)", async () => {
    const { vault, transport, engine } = setup();
    await vault.writeBinary("board.canvas", new Uint8Array([1, 2, 3]).buffer);
    await engine.handleLocalAttach("board.canvas");
    expect(transport.sent).toHaveLength(0);
  });

  it("входящий upsert .canvas пишет файл (текст)", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "b.canvas", content: '{"x":1}', hlc: hlc(1) });
    expect(await vault.read("b.canvas")).toBe('{"x":1}');
  });

  it("watcher маршрутизирует .canvas в текстовый upsert (debounce)", async () => {
    const { vault, transport, engine } = setup();
    const watcher = new VaultWatcher(engine, { debounceMs: 5 });
    vault.files.set("c.canvas", "{}");
    watcher.onUpsert("c.canvas");
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.sent.at(-1)?.delta).toMatchObject({ op: "upsert", path: "c.canvas" });
    watcher.dispose();
  });
});
