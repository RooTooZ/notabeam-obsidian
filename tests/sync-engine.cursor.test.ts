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
  it("snapshot.cursor инициализирует курсор", async () => {
    const { transport, cursor } = setup();
    transport.emit(snap(42));
    await new Promise((r) => setTimeout(r, 0));
    expect(cursor()).toBe(42);
  });

  it("пакет ops проигрывается по порядку, курсор = последний seq", async () => {
    const { vault, transport, cursor } = setup();
    const ops: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: "ops",
      deltas: [
        { seq: 5, delta: { op: "upsert", path: "a.md", content: "A", hlc: hlc(1) } },
        { seq: 6, delta: { op: "upsert", path: "b.md", content: "B", hlc: hlc(2) } },
        { seq: 7, delta: { op: "delete", path: "a.md", hlc: hlc(3) } },
      ],
    };
    transport.emit(ops);
    await new Promise((r) => setTimeout(r, 0));
    expect(await vault.read("b.md")).toBe("B");
    expect(await vault.read("a.md")).toBeNull(); // удаление из пакета применилось
    expect(cursor()).toBe(7);
  });

  it("живая delta с seq двигает курсор", async () => {
    const { transport, cursor } = setup();
    transport.emit({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "upsert", path: "x.md", content: "X", hlc: hlc(1) },
      seq: 99,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(cursor()).toBe(99);
  });

  it("курсор не откатывается назад", async () => {
    const { transport, cursor } = setup(100);
    transport.emit(snap(50)); // меньше текущего
    await new Promise((r) => setTimeout(r, 0));
    expect(cursor()).toBe(100);
  });
});
