import { encodeHlc, type ClientMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { SyncEngine } from "@/sync/sync-engine";
import { VaultWatcher } from "@/sync/vault-watcher";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  const watcher = new VaultWatcher(engine, { debounceMs: 5 });
  return { vault, transport, engine, watcher };
};

const deltas = (transport: FakeTransport) =>
  transport.sent.map((m: ClientMessage) => m.delta);

describe("VaultWatcher outgoing", () => {
  it("test_create_md_sends_upsert", async () => {
    const { vault, transport, watcher } = setup();
    await vault.write("a.md", "hello");
    watcher.onUpsert("a.md");
    await sleep(25);
    expect(deltas(transport)).toEqual([{ op: "upsert", path: "a.md", content: "hello", hlc: expect.any(String) }]);
  });

  it("test_modify_debounced_single_upsert", async () => {
    const { vault, transport, watcher } = setup();
    await vault.write("a.md", "v3");
    watcher.onUpsert("a.md");
    watcher.onUpsert("a.md");
    watcher.onUpsert("a.md");
    await sleep(25);
    expect(transport.sent).toHaveLength(1);
    expect(deltas(transport)[0]?.op).toBe("upsert");
  });

  it("test_delete_md_sends_delete", async () => {
    const { engine, transport, watcher } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "x", hlc: hlc(1) });
    watcher.onDelete("a.md");
    await sleep(5);
    expect(deltas(transport)).toEqual([{ op: "delete", path: "a.md", hlc: expect.any(String) }]);
  });

  it("test_rename_md_sends_rename", async () => {
    const { engine, transport, watcher } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "x", hlc: hlc(1) });
    watcher.onRename("a.md", "b.md");
    await sleep(5);
    expect(deltas(transport)).toEqual([
      { op: "rename", fromPath: "a.md", toPath: "b.md", hlc: expect.any(String) },
    ]);
  });

  it("test_non_md_ignored", async () => {
    const { vault, transport, watcher } = setup();
    await vault.write("a.txt", "x");
    watcher.onUpsert("a.txt");
    await sleep(25);
    expect(transport.sent).toHaveLength(0);
  });

  it("test_remote_applied_change_not_resent", async () => {
    const { transport, engine, watcher } = setup();
    await engine.applyIncoming({ op: "upsert", path: "a.md", content: "remote", hlc: hlc(1) });
    // echo: applying the incoming change would trigger a local modify of the same file
    watcher.onUpsert("a.md");
    await sleep(25);
    expect(transport.sent).toHaveLength(0);
  });
});
