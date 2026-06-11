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
  return { vault, engine };
};

describe("SyncEngine path safety", () => {
  it("test_apply_incoming_skips_unsafe_path", async () => {
    const { vault, engine } = setup();
    await engine.applyIncoming({ op: "upsert", path: "../evil.md", content: "x", hlc: hlc(1) });
    await engine.applyIncoming({ op: "upsert", path: ".obsidian/x.md", content: "y", hlc: hlc(2) });
    expect(vault.files.has("../evil.md")).toBe(false);
    expect(vault.files.has(".obsidian/x.md")).toBe(false);
  });

  it("test_apply_incoming_attach_into_obsidian_rejected", async () => {
    const { vault, engine } = setup();
    // ключевой RCE-вектор: бинарь в каталог плагина
    await engine.applyIncoming({
      op: "attach",
      path: ".obsidian/plugins/notabeam/main.js",
      hash: "h",
      size: 1,
      hlc: hlc(1),
    });
    expect(vault.binaries.has(".obsidian/plugins/notabeam/main.js")).toBe(false);
  });

  it("test_apply_snapshot_skips_unsafe_keeps_safe", async () => {
    const { vault, engine } = setup();
    await engine.applySnapshot({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      files: [
        { path: "good.md", content: "G", hlc: hlc(1) },
        { path: ".obsidian/plugins/notabeam/main.js", content: "EVIL", hlc: hlc(1) },
        { path: "../escape.md", content: "EVIL", hlc: hlc(1) },
      ],
      dirs: [],
      attachments: [],
      tombstones: [],
      vaultId: "",
      maxAttachmentBytes: 10 * 1024 * 1024,
    });
    expect(await vault.read("good.md")).toBe("G");
    expect(vault.files.has(".obsidian/plugins/notabeam/main.js")).toBe(false);
    expect(vault.files.has("../escape.md")).toBe(false);
  });
});
