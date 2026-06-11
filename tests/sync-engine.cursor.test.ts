import { encodeHlc, PROTOCOL_VERSION, type ServerMessage, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { type CursorStore, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

const setup = (initialCursor = 0) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  let saved = initialCursor;
  const cursorStore: CursorStore = {
    load: () => saved,
    save: (s) => {
      saved = s;
    },
  };
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => (last = h),
  });
  const engine = new SyncEngine(vault, transport, gen, undefined, undefined, undefined, cursorStore);
  engine.start();
  return { vault, transport, engine, cursor: () => saved };
};

const snap = (cursor: number): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files: [],
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes: 10 * 1024 * 1024,
  cursor,
});

describe("SyncEngine cursor + ops (Spec-02)", () => {
  it("snapshot.cursor initializes the cursor", async () => {
    const { transport, cursor } = setup();
    transport.emit(snap(42));
    await new Promise((r) => setTimeout(r, 0));
    expect(cursor()).toBe(42);
  });

  it("an ops batch is replayed in order, cursor = last seq", async () => {
    const { vault, transport, cursor, engine } = setup();
    const ops: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: "ops",
      vaultId: "v1",
      maxAttachmentBytes: 10 * 1024 * 1024,
      deltas: [
        { seq: 5, delta: { op: "upsert", path: "a.md", content: "A", hlc: hlc(1) } },
        { seq: 6, delta: { op: "upsert", path: "b.md", content: "B", hlc: hlc(2) } },
        { seq: 7, delta: { op: "delete", path: "a.md", hlc: hlc(3) } },
      ],
    };
    transport.emit(ops);
    await engine.whenIdle();
    expect(await vault.read("b.md")).toBe("B");
    expect(await vault.read("a.md")).toBeNull(); // the delete from the batch was applied
    expect(cursor()).toBe(7);
  });

  it("a live delta with seq advances the cursor", async () => {
    const { transport, cursor, engine } = setup();
    transport.emit({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "upsert", path: "x.md", content: "X", hlc: hlc(1) },
      seq: 99,
    });
    await engine.whenIdle();
    expect(cursor()).toBe(99);
  });

  // MS11-010 / AUD-015: snapshot допускает понижение курсора (сервер восстановлен из
  // бэкапа). Монотонность сохраняется только на ops/live-пути.
  it("a snapshot rolls the cursor back (server restored from backup)", async () => {
    const { transport, cursor } = setup(100);
    transport.emit(snap(50)); // server maxSeq lower than client cursor
    await new Promise((r) => setTimeout(r, 0));
    expect(cursor()).toBe(50);
  });
});
