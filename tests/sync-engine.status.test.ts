import { encodeHlc, PROTOCOL_VERSION, sha256Hex, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import type { BlobClient } from "@/sync/blob-client";
import { createHlcGenerator } from "@/sync/hlc";
import { type AttachmentDeps, type FileSyncState, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

const fakeBlob: BlobClient = {
  has: async () => false,
  upload: async () => ({ ok: true, status: 201 }),
  download: async () => null,
};

const setup = (withAttachments = false) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  const events: { path: string; state: FileSyncState }[] = [];
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => (last = h),
  });
  const attachments: AttachmentDeps | undefined = withAttachments ? { blob: fakeBlob } : undefined;
  const engine = new SyncEngine(vault, transport, gen, undefined, attachments, (path, state) =>
    events.push({ path, state }),
  );
  return { vault, transport, engine, events };
};

const lastFor = (events: { path: string; state: FileSyncState }[], path: string) =>
  [...events].reverse().find((e) => e.path === path)?.state;

describe("SyncEngine per-file status (Spec-09)", () => {
  it("markPending → pending", () => {
    const { engine, events } = setup();
    engine.markPending("a.md");
    expect(events).toContainEqual({ path: "a.md", state: "pending" });
  });

  it("локальный upsert → synced", async () => {
    const { vault, engine, events } = setup();
    vault.files.set("a.md", "hi");
    await engine.handleLocalUpsert("a.md");
    expect(lastFor(events, "a.md")).toBe("synced");
  });

  it("эхо upsert (без изменений) → synced", async () => {
    const { vault, engine, events } = setup();
    vault.files.set("a.md", "hi");
    await engine.handleLocalUpsert("a.md");
    await engine.handleLocalUpsert("a.md"); // второй раз — эхо
    expect(lastFor(events, "a.md")).toBe("synced");
  });

  it("входящий upsert → synced", async () => {
    const { engine, events } = setup();
    await engine.applyIncoming({ op: "upsert", path: "b.md", content: "x", hlc: hlc(1) });
    expect(lastFor(events, "b.md")).toBe("synced");
  });

  it("вложение сверх лимита → error", async () => {
    const { vault, engine, events } = setup(true);
    await engine.applySnapshot(snap(4)); // лимит 4 байта
    await vault.writeBinary("big.bin", new Uint8Array([1, 2, 3, 4, 5]).buffer);
    await engine.handleLocalAttach("big.bin");
    expect(lastFor(events, "big.bin")).toBe("error");
  });

  it("успешное вложение → synced", async () => {
    const { vault, engine, events } = setup(true);
    const data = new Uint8Array([9, 9]).buffer;
    await sha256Hex(data);
    await vault.writeBinary("ok.png", data);
    await engine.handleLocalAttach("ok.png");
    expect(lastFor(events, "ok.png")).toBe("synced");
  });
});

const snap = (maxAttachmentBytes: number): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files: [],
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes,
});
