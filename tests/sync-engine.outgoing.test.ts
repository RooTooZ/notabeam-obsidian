import { PROTOCOL_VERSION } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const setup = () => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({
    node: "dev-x",
    clock: { now: () => (t += 1) },
    load: () => last,
    save: (h) => {
      last = h;
    },
  });
  const engine = new SyncEngine(vault, transport, gen);
  return { vault, transport, engine };
};

describe("SyncEngine outgoing rename/move", () => {
  it("server-known file -> rename delta", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("a.md", "A");
    await engine.handleLocalUpsert("a.md"); // upsert -> shadow knows a.md
    transport.sent.length = 0;
    // move on disk
    vault.files.set("dir/a.md", "A");
    vault.files.delete("a.md");
    await engine.handleLocalRename("a.md", "dir/a.md");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "rename", fromPath: "a.md", toPath: "dir/a.md" },
    });
  });

  it("unsynced file (fast create+move) -> upsert of the new path, no loss", async () => {
    const { vault, transport, engine } = setup();
    // file already sits in the folder (move happened), but shadow knows nothing about a.md
    vault.files.set("dir/a.md", "A");
    await engine.handleLocalRename("a.md", "dir/a.md");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "upsert", path: "dir/a.md", content: "A" },
    });
  });

  it("move .md -> non-.md is treated as a delete of the source", async () => {
    const { vault, transport, engine } = setup();
    vault.files.set("a.md", "A");
    await engine.handleLocalUpsert("a.md");
    transport.sent.length = 0;
    await engine.handleLocalRename("a.md", "a.txt");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ delta: { op: "delete", path: "a.md" } });
  });
});

describe("SyncEngine folders outgoing", () => {
  it("mkdir -> mkdir delta; a repeat (echo) is not sent", async () => {
    const { transport, engine } = setup();
    await engine.handleLocalMkdir("Folder");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ delta: { op: "mkdir", path: "Folder" } });
    transport.sent.length = 0;
    await engine.handleLocalMkdir("Folder"); // already exists
    expect(transport.sent).toHaveLength(0);
  });

  it("rmdir -> rmdir delta; a repeat (echo) is not sent", async () => {
    const { transport, engine } = setup();
    await engine.handleLocalMkdir("Folder");
    transport.sent.length = 0;
    await engine.handleLocalRmdir("Folder");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ delta: { op: "rmdir", path: "Folder" } });
    transport.sent.length = 0;
    await engine.handleLocalRmdir("Folder"); // already removed
    expect(transport.sent).toHaveLength(0);
  });

  it("applyIncoming mkdir suppresses the echo of a subsequent local mkdir", async () => {
    const { engine, transport } = setup();
    await engine.applyIncoming({ op: "mkdir", path: "F", hlc: "000000000001000:000000:srv" });
    await engine.handleLocalMkdir("F"); // echo of the applied mkdir
    expect(transport.sent).toHaveLength(0);
  });

  it("renamedir -> renamedir delta; the echo of the applied one is suppressed", async () => {
    const { engine, transport } = setup();
    await engine.handleLocalRenamedir("Old", "New");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ delta: { op: "renamedir", fromPath: "Old", toPath: "New" } });
    transport.sent.length = 0;
    await engine.applyIncoming({ op: "renamedir", fromPath: "A", toPath: "B", hlc: "000000000009000:000000:srv" });
    await engine.handleLocalRenamedir("A", "B"); // echo
    expect(transport.sent).toHaveLength(0);
  });
});
