import { encodeHlc, PROTOCOL_VERSION, type ServerMessage, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

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
  const engine = new SyncEngine(vault, transport, gen);
  engine.start();
  return { vault, transport, engine };
};

const snapMsg = (files: { path: string; content: string; hlc: string }[]): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files,
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes: 10 * 1024 * 1024,
});

const liveDelta = (path: string, content: string, n: number): ServerMessage => ({
  v: PROTOCOL_VERSION,
  type: "delta",
  delta: { op: "upsert", path, content, hlc: hlc(n) },
});

const sentHlc = (transport: FakeTransport, path: string): string => {
  const m = transport.sent.find(
    (x) => x.type === "delta" && x.delta.op === "upsert" && x.delta.path === path,
  );
  if (!m || m.type !== "delta") throw new Error("no upsert sent");
  return m.delta.hlc;
};

describe("SyncEngine confirmed-baseline conflict copies (REQ-02.8 / AUD-004)", () => {
  it("a sent-but-unconfirmed edit becomes a conflict copy when overwritten by a newer remote", async () => {
    const { vault, transport, engine } = setup();
    transport.emit(snapMsg([{ path: "note.md", content: "base", hlc: hlc(1) }]));
    await engine.whenIdle();
    expect(await vault.read("note.md")).toBe("base");

    // локальная правка ушла на сервер, но ack так и не пришёл (потеряна в сети)
    await vault.write("note.md", "local");
    await engine.handleLocalUpsert("note.md");

    // конкурентная более новая правка с другого устройства
    transport.emit(liveDelta("note.md", "remote", 5));
    await engine.whenIdle();

    expect(await vault.read("note.md")).toBe("remote"); // LWW winner
    const conflict = [...vault.files.keys()].find((p) => p.includes("(conflict"));
    expect(conflict).toBeTruthy();
    expect(await vault.read(conflict!)).toBe("local"); // потерянная правка сохранена
  });

  it("an acked edit superseded by a newer remote does not create a spurious conflict copy", async () => {
    const { vault, transport, engine } = setup();
    transport.emit(snapMsg([{ path: "note.md", content: "base", hlc: hlc(1) }]));
    await engine.whenIdle();

    await vault.write("note.md", "local");
    await engine.handleLocalUpsert("note.md");
    // сервер подтвердил нашу правку
    transport.emit({ v: PROTOCOL_VERSION, type: "ack", hlc: sentHlc(transport, "note.md") });
    await engine.whenIdle();

    // более новая удалённая правка; на диске всё ещё подтверждённый "local"
    transport.emit(liveDelta("note.md", "remote", 5));
    await engine.whenIdle();

    expect(await vault.read("note.md")).toBe("remote");
    expect([...vault.files.keys()].some((p) => p.includes("(conflict"))).toBe(false);
  });

  it("after ack, a further unsynced local edit is still preserved as a conflict copy", async () => {
    const { vault, transport, engine } = setup();
    transport.emit(snapMsg([{ path: "note.md", content: "base", hlc: hlc(1) }]));
    await engine.whenIdle();

    await vault.write("note.md", "local");
    await engine.handleLocalUpsert("note.md");
    transport.emit({ v: PROTOCOL_VERSION, type: "ack", hlc: sentHlc(transport, "note.md") });
    await engine.whenIdle();

    // пользователь правит снова, ещё не синхронизировано
    await vault.write("note.md", "local2-unsynced");

    transport.emit(liveDelta("note.md", "remote", 5));
    await engine.whenIdle();

    expect(await vault.read("note.md")).toBe("remote");
    const conflict = [...vault.files.keys()].find((p) => p.includes("(conflict"));
    expect(conflict).toBeTruthy();
    expect(await vault.read(conflict!)).toBe("local2-unsynced");
  });
});
