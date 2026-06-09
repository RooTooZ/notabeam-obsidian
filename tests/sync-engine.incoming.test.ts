import { encodeHlc, PROTOCOL_VERSION } from "@notabeam/shared";
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

describe("SyncEngine incoming", () => {
  it("test_apply_snapshot_writes_files", async () => {
    const { vault, engine } = setup();
    await engine.applySnapshot({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      files: [
        { path: "a.md", content: "A", hlc: hlc(1) },
        { path: "b.md", content: "B", hlc: hlc(1) },
      ],
      dirs: [],
      attachments: [],
      tombstones: [],
      vaultId: "",
      maxAttachmentBytes: 10 * 1024 * 1024,
    });
    expect(await vault.read("a.md")).toBe("A");
    expect(await vault.read("b.md")).toBe("B");
  });

  it("test_apply_incoming_upsert_writes_file", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "hello", hlc: hlc(1) });
    expect(await vault.read("a.md")).toBe("hello");
  });

  it("test_apply_incoming_delete_removes_file", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "x", hlc: hlc(1) });
    await engine.applyIncoming({ op: "delete", path: "a.md", hlc: hlc(2) });
    expect(await vault.read("a.md")).toBeNull();
  });

  it("test_apply_incoming_rename_moves_file", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "x", hlc: hlc(1) });
    await engine.applyIncoming({ op: "rename", fromPath: "a.md", toPath: "b.md", hlc: hlc(2) });
    expect(await vault.read("a.md")).toBeNull();
    expect(await vault.read("b.md")).toBe("x");
  });

  it("test_incoming_hlc_not_newer_ignored", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "new", hlc: hlc(5) });
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "stale", hlc: hlc(3) });
    expect(await vault.read("a.md")).toBe("new");
  });

  it("mkdir creates a folder; rmdir recursively deletes the folder with its contents", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "mkdir", path: "Folder", hlc: hlc(1) });
    expect(vault.folders.has("Folder")).toBe(true);
    await engine.applyIncoming({ op: "upsert", path: "Folder/a.md", content: "A", hlc: hlc(2) });
    await engine.applyIncoming({ op: "rmdir", path: "Folder", hlc: hlc(3) });
    expect(vault.folders.has("Folder")).toBe(false);
    expect(await vault.read("Folder/a.md")).toBeNull();
  });

  it("renamedir moves the folder with its contents (moveDir)", async () => {
    const { vault, engine } = setup();
    vault.folders.add("Old");
    vault.files.set("Old/a.md", "A");
    await engine.applyIncoming({ op: "renamedir", fromPath: "Old", toPath: "New", hlc: hlc(1) });
    expect(vault.folders.has("New")).toBe(true);
    expect(vault.folders.has("Old")).toBe(false);
    expect(await vault.read("New/a.md")).toBe("A");
    expect(await vault.read("Old/a.md")).toBeNull();
  });

  it("snapshot creates empty folders from dirs", async () => {
    const { vault, engine } = setup();
    await engine.applySnapshot({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      files: [],
      dirs: [{ path: "Empty", hlc: hlc(1) }],
      attachments: [],
      tombstones: [],
      vaultId: "",
      maxAttachmentBytes: 10 * 1024 * 1024,
    });
    expect(vault.folders.has("Empty")).toBe(true);
  });

  it("test_remote_apply_suppresses_echo", async () => {
    const { transport, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "remote", hlc: hlc(1) });
    // local modify event for the same file with the same content is an echo and should not be sent
    await engine.handleLocalUpsert("a.md");
    expect(transport.sent).toHaveLength(0);
  });
});
