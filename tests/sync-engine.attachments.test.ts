import { encodeHlc, PROTOCOL_VERSION, sha256Hex, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import type { BlobClient } from "@/sync/blob-client";
import { createHlcGenerator } from "@/sync/hlc";
import { type AttachmentDeps, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });
const bytes = (...n: number[]): ArrayBuffer => new Uint8Array(n).buffer;

// Fake blob client: stores blobs by hash, records upload/HEAD calls.
class FakeBlobClient implements BlobClient {
  readonly store = new Map<string, ArrayBuffer>();
  readonly uploads: string[] = [];
  failUploadStatus: number | null = null;

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash);
  }
  async upload(hash: string, data: ArrayBuffer): Promise<{ ok: boolean; status: number }> {
    this.uploads.push(hash);
    if (this.failUploadStatus !== null) return { ok: false, status: this.failUploadStatus };
    this.store.set(hash, data);
    return { ok: true, status: 201 };
  }
  async download(hash: string): Promise<ArrayBuffer | null> {
    return this.store.get(hash) ?? null;
  }
}

const setup = (over?: Partial<AttachmentDeps>) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  const blob = new FakeBlobClient();
  const oversize: { path: string; size: number; max: number }[] = [];
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => (last = h),
  });
  const attachments: AttachmentDeps = {
    blob,
    onOversize: (path, size, max) => oversize.push({ path, size, max }),
    ...over,
  };
  const engine = new SyncEngine(vault, transport, gen, undefined, attachments);
  return { vault, transport, engine, blob, oversize };
};

describe("SyncEngine attachments (Spec-03)", () => {
  it("local creation of a non-.md file → upload (if missing) + attach delta", async () => {
    const { vault, transport, engine, blob } = setup();
    const data = bytes(1, 2, 3, 4);
    const hash = await sha256Hex(data);
    await vault.writeBinary("img.png", data);

    await engine.handleLocalAttach("img.png");

    expect(blob.uploads).toEqual([hash]); // uploaded (server did not have it)
    expect(transport.sent).toHaveLength(1);
    const delta = transport.sent[0]?.delta;
    expect(delta).toMatchObject({ op: "attach", path: "img.png", hash, size: 4 });
  });

  it("dedup: if blob is already on the server — do not re-upload, but still send attach", async () => {
    const { vault, transport, engine, blob } = setup();
    const data = bytes(5, 6, 7);
    const hash = await sha256Hex(data);
    blob.store.set(hash, data); // already on the server
    await vault.writeBinary("a.png", data);

    await engine.handleLocalAttach("a.png");

    expect(blob.uploads).toEqual([]); // not uploaded
    expect(transport.sent[0]?.delta).toMatchObject({ op: "attach", hash });
  });

  it("receiving attach → download + write the binary", async () => {
    const { vault, engine, blob } = setup();
    const data = bytes(9, 9, 9);
    const hash = await sha256Hex(data);
    blob.store.set(hash, data);

    await engine.applyIncoming({ op: "attach", path: "down.png", hash, size: 3, hlc: hlc(1) });

    expect([...new Uint8Array((await vault.readBinary("down.png"))!)]).toEqual([9, 9, 9]);
  });

  it("echo: an applied attach does not produce an outgoing one (shadow by hash)", async () => {
    const { transport, engine, blob } = setup();
    const data = bytes(1, 1);
    const hash = await sha256Hex(data);
    blob.store.set(hash, data);
    await engine.applyIncoming({ op: "attach", path: "e.png", hash, size: 2, hlc: hlc(5) });

    // local modify event for the same file with the same content — an echo
    await engine.handleLocalAttach("e.png");
    expect(transport.sent).toHaveLength(0);
  });

  it("LWW: an incoming attach with an older/equal HLC is ignored", async () => {
    const { vault, engine, blob } = setup();
    const dNew = bytes(2, 2);
    const dOld = bytes(3, 3, 3);
    const hNew = await sha256Hex(dNew);
    const hOld = await sha256Hex(dOld);
    blob.store.set(hNew, dNew);
    blob.store.set(hOld, dOld);

    await engine.applyIncoming({ op: "attach", path: "x.png", hash: hNew, size: 2, hlc: hlc(5) });
    await engine.applyIncoming({ op: "attach", path: "x.png", hash: hOld, size: 3, hlc: hlc(3) });
    expect([...new Uint8Array((await vault.readBinary("x.png"))!)]).toEqual([2, 2]);
  });

  it("exceeding the limit: do not upload, do not send, notify (REQ-03.3)", async () => {
    const { vault, transport, engine, blob, oversize } = setup();
    // limit from snapshot — 4 bytes
    await engine.applySnapshot(snap(8 /* unused */, 4));
    await vault.writeBinary("big.bin", bytes(1, 2, 3, 4, 5));

    await engine.handleLocalAttach("big.bin");

    expect(blob.uploads).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(oversize[0]).toMatchObject({ path: "big.bin", size: 5, max: 4 });
  });

  it("server returned 413 (limit desync): do not send attach, notify", async () => {
    const { vault, transport, engine, blob, oversize } = setup();
    blob.failUploadStatus = 413;
    await vault.writeBinary("img.png", bytes(1, 2, 3));

    await engine.handleLocalAttach("img.png");

    expect(transport.sent).toHaveLength(0);
    expect(oversize).toHaveLength(1);
  });

  it("deleting an attachment → delete delta; .obsidian is handled at a higher level", async () => {
    const { vault, transport, engine, blob } = setup();
    const data = bytes(7);
    const hash = await sha256Hex(data);
    blob.store.set(hash, data);
    await engine.applyIncoming({ op: "attach", path: "img.png", hash, size: 1, hlc: hlc(1) });

    await vault.remove("img.png");
    await engine.handleLocalDelete("img.png");

    expect(transport.sent.at(-1)?.delta).toMatchObject({ op: "delete", path: "img.png" });
  });

  it("renaming an attachment → rename delta (blob is left untouched)", async () => {
    const { transport, engine, blob } = setup();
    const data = bytes(4, 5);
    const hash = await sha256Hex(data);
    blob.store.set(hash, data);
    await engine.applyIncoming({ op: "attach", path: "a/img.png", hash, size: 2, hlc: hlc(1) });

    await engine.handleLocalRename("a/img.png", "b/pic.png");

    expect(blob.uploads).toEqual([]);
    expect(transport.sent.at(-1)?.delta).toMatchObject({
      op: "rename",
      fromPath: "a/img.png",
      toPath: "b/pic.png",
    });
  });
});

// snapshot with a given attachment limit (vaultId does not matter — binding is not connected).
const snap = (_n: number, maxAttachmentBytes: number): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files: [],
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes,
});
