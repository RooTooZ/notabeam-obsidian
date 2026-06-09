import { encodeHlc, PROTOCOL_VERSION, type SnapshotMessage } from "@notabeam/shared";
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
  return { vault, engine };
};

const snap = (files: { path: string; content: string; hlc: string }[]): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files,
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId: "",
  maxAttachmentBytes: 10 * 1024 * 1024,
});

describe("SyncEngine conflict copies (REQ-02.8)", () => {
  it("дивергентная локальная правка сохраняется как (conflict …), входящая применяется", async () => {
    const { vault, engine } = setup();
    // базовая синхронизированная версия
    await engine.applySnapshot(snap([{ path: "note.md", content: "base", hlc: hlc(1) }]));
    expect(await vault.read("note.md")).toBe("base");

    // локальная несинхронизированная правка «за спиной» движка (shadow остаётся "base")
    await vault.write("note.md", "local-edit");

    // входящая правка с бóльшим HLC
    await engine.applyIncoming({ op: "upsert", path: "note.md", content: "remote-edit", hlc: hlc(5) });

    expect(await vault.read("note.md")).toBe("remote-edit"); // победитель по LWW
    // локальная правка не потеряна — лежит рядом конфликт-копией
    const conflict = [...vault.files.keys()].find((p) => p.includes("(conflict"));
    expect(conflict).toBeTruthy();
    expect(conflict?.endsWith(".md")).toBe(true);
    expect(await vault.read(conflict!)).toBe("local-edit");
  });

  it("нет дивергенции (локальное == last-synced) → без конфликт-копии", async () => {
    const { vault, engine } = setup();
    await engine.applySnapshot(snap([{ path: "n.md", content: "base", hlc: hlc(1) }]));
    // локальное совпадает с shadow → обычный LWW
    await engine.applyIncoming({ op: "upsert", path: "n.md", content: "v2", hlc: hlc(2) });
    expect(await vault.read("n.md")).toBe("v2");
    expect([...vault.files.keys()].some((p) => p.includes("(conflict"))).toBe(false);
  });

  it("работает для .canvas", async () => {
    const { vault, engine } = setup();
    await engine.applySnapshot(snap([{ path: "b.canvas", content: "{}", hlc: hlc(1) }]));
    await vault.write("b.canvas", '{"local":1}');
    await engine.applyIncoming({ op: "upsert", path: "b.canvas", content: '{"remote":1}', hlc: hlc(5) });
    expect(await vault.read("b.canvas")).toBe('{"remote":1}');
    const conflict = [...vault.files.keys()].find((p) => p.includes("(conflict"));
    expect(conflict?.endsWith(".canvas")).toBe(true);
  });
});
