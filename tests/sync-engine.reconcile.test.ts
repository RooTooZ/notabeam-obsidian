import { encodeHlc, PROTOCOL_VERSION, sha256Hex, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import type { BlobClient } from "@/sync/blob-client";
import { createHlcGenerator } from "@/sync/hlc";
import { type AttachmentDeps, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

class FakeBlobClient implements BlobClient {
  readonly store = new Map<string, ArrayBuffer>();
  readonly uploads: string[] = [];
  async has(hash: string): Promise<boolean> {
    return this.store.has(hash);
  }
  async upload(hash: string, data: ArrayBuffer): Promise<{ ok: boolean; status: number }> {
    this.uploads.push(hash);
    this.store.set(hash, data);
    return { ok: true, status: 201 };
  }
  async download(hash: string): Promise<ArrayBuffer | null> {
    return this.store.get(hash) ?? null;
  }
}

const setup = (withAttachments = false) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  const blob = new FakeBlobClient();
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => (last = h),
  });
  const attachments: AttachmentDeps | undefined = withAttachments ? { blob } : undefined;
  const engine = new SyncEngine(vault, transport, gen, undefined, attachments);
  return { vault, transport, engine, blob };
};

const snap = (over: Partial<SnapshotMessage> = {}): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files: [],
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes: 10 * 1024 * 1024,
  ...over,
});

describe("SyncEngine reconcile on connect (REQ-01.13)", () => {
  it("uploads a local .md that is missing on the server", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("offline-new.md", "added while offline");

    await engine.applySnapshot(snap());

    const sent = transport.sent.map((m) => m.delta);
    expect(sent).toContainEqual(
      expect.objectContaining({ op: "upsert", path: "offline-new.md", content: "added while offline" }),
    );
  });

  it("does not re-send a .md that already exists on the server (in snapshot)", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("known.md", "X");

    await engine.applySnapshot(snap({ files: [{ path: "known.md", content: "X", hlc: hlc(1) }] }));

    expect(transport.sent).toHaveLength(0);
  });

  it("does NOT resurrect a file with a tombstone (deleted on another device)", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("deleted-elsewhere.md", "stale local copy");

    await engine.applySnapshot(snap({ tombstones: [{ path: "deleted-elsewhere.md", hlc: hlc(9) }] }));

    expect(transport.sent).toHaveLength(0);
  });

  it("uploads a local attachment that is missing on the server (upload + attach)", async () => {
    const { vault, transport, engine, blob } = setup(true);
    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const hash = await sha256Hex(data);
    await vault.writeBinary("offline.png", data);

    await engine.applySnapshot(snap());

    expect(blob.uploads).toEqual([hash]);
    expect(transport.sent.map((m) => m.delta)).toContainEqual(
      expect.objectContaining({ op: "attach", path: "offline.png", hash, size: 5 }),
    );
  });

  it("does not re-send an attachment already known to the server", async () => {
    const { vault, transport, engine, blob } = setup(true);
    const data = new Uint8Array([7, 7]).buffer;
    const hash = await sha256Hex(data);
    await vault.writeBinary("known.png", data);

    await engine.applySnapshot(snap({ attachments: [{ path: "known.png", hash, size: 2, hlc: hlc(1) }] }));

    expect(blob.uploads).toEqual([]);
    expect(transport.sent).toHaveLength(0);
  });

  it("does not reconcile when binding is refused (halted)", async () => {
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
    const binding = {
      getBound: () => "vault-A",
      bind: () => undefined,
      allowMerge: () => false,
      onRefuse: () => undefined,
    };
    const engine = new SyncEngine(vault, transport, gen, binding);
    vault.files.set("local.md", "X");

    await engine.applySnapshot(snap({ vaultId: "vault-B" })); // mismatch → refused

    expect(transport.sent).toHaveLength(0);
  });
});
