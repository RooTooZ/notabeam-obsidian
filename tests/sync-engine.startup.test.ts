import {
  type Delta,
  encodeHlc,
  PROTOCOL_VERSION,
  sha256Hex,
  type ServerMessage,
} from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { type CursorStore, type ShadowEntry, type ShadowStore, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });
const textHash = (s: string) => sha256Hex(new TextEncoder().encode(s));

const setup = (persisted: Record<string, ShadowEntry> = {}, initialCursor = 0) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  const shadow: Record<string, ShadowEntry> = { ...persisted };
  const shadowStore: ShadowStore = {
    load: () => shadow,
    setFile: (p, e) => {
      shadow[p] = e;
    },
    deleteFile: (p) => {
      delete shadow[p];
    },
  };
  let savedCursor = initialCursor;
  const cursorStore: CursorStore = {
    load: () => savedCursor,
    save: (s) => {
      savedCursor = s;
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
  const engine = new SyncEngine(
    vault,
    transport,
    gen,
    undefined,
    undefined,
    undefined,
    cursorStore,
    shadowStore,
  );
  return { vault, transport, engine, shadow };
};

const ops = (deltas: { seq: number; delta: Delta }[]): ServerMessage => ({
  v: PROTOCOL_VERSION,
  type: "ops",
  vaultId: "v1",
  maxAttachmentBytes: 10 * 1024 * 1024,
  deltas,
});

describe("SyncEngine startup reconcile (AUD-003/009)", () => {
  it("does not re-upsert an unchanged file present in persisted shadow", async () => {
    const { vault, transport, engine } = setup({ "note.md": { hlc: hlc(1), hash: await textHash("same") } });
    vault.files.set("note.md", "same");
    engine.start();
    // эмулируем стартовый create-storm: событие по уже существующему файлу
    await engine.handleLocalUpsert("note.md");
    expect(transport.sent).toHaveLength(0);
  });

  it("uploads an offline-edited file (hash diverges from persisted shadow)", async () => {
    const { vault, transport, engine } = setup({ "note.md": { hlc: hlc(1), hash: await textHash("old") } });
    vault.files.set("note.md", "edited offline");
    engine.start();
    await engine.handleLocalUpsert("note.md");
    expect(transport.sent.map((m) => m.delta)).toContainEqual(
      expect.objectContaining({ op: "upsert", path: "note.md", content: "edited offline" }),
    );
  });

  it("ops path runs a one-time file reconcile and uploads offline edits", async () => {
    const { vault, transport, engine } = setup({ "note.md": { hlc: hlc(1), hash: await textHash("old") } });
    vault.files.set("note.md", "edited offline");
    engine.start();
    transport.emit(ops([{ seq: 5, delta: { op: "upsert", path: "other.md", content: "O", hlc: hlc(2) } }]));
    await engine.whenIdle();
    const sent = transport.sent.map((m) => m.delta);
    expect(sent).toContainEqual(
      expect.objectContaining({ op: "upsert", path: "note.md", content: "edited offline" }),
    );
    // только что пришедший по ops файл не пере-отправляется
    expect(sent).not.toContainEqual(expect.objectContaining({ path: "other.md" }));
  });

  it("ops path does not re-upsert unchanged files", async () => {
    const { vault, transport, engine } = setup({ "note.md": { hlc: hlc(1), hash: await textHash("same") } });
    vault.files.set("note.md", "same");
    engine.start();
    transport.emit(ops([]));
    await engine.whenIdle();
    expect(transport.sent).toHaveLength(0);
  });

  it("reconcile runs once per connection (second ops batch does not re-scan)", async () => {
    const { vault, transport, engine } = setup({ "x.md": { hlc: hlc(1), hash: await textHash("old") } });
    vault.files.set("x.md", "changed");
    engine.start();
    transport.emit(ops([]));
    await engine.whenIdle();
    const afterFirst = transport.sent.length;
    expect(afterFirst).toBe(1); // x.md uploaded once
    transport.emit(ops([]));
    await engine.whenIdle();
    expect(transport.sent).toHaveLength(afterFirst); // no second scan
  });

  it("persists shadow across upsert and clears it on delete", async () => {
    const { vault, engine, shadow } = setup();
    vault.files.set("a.md", "A");
    engine.start();
    await engine.handleLocalUpsert("a.md");
    expect(shadow["a.md"]?.hash).toBe(await textHash("A"));
    await engine.handleLocalDelete("a.md");
    expect("a.md" in shadow).toBe(false);
  });
});
