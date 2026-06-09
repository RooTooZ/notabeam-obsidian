import { encodeHlc, PROTOCOL_VERSION, type SnapshotMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { type BindingHooks, SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

const makeBinding = (bound: string, allowMerge: boolean) => {
  let _bound = bound;
  const calls: string[] = [];
  const hooks: BindingHooks = {
    getBound: () => _bound,
    bind: (id) => {
      _bound = id;
      calls.push(`bind:${id}`);
    },
    allowMerge: () => allowMerge,
    onRefuse: (reason, server, b) => calls.push(`refuse:${reason}:${server}:${b}`),
  };
  return { hooks, calls, bound: () => _bound };
};

const snap = (vaultId: string, files: { path: string; content: string }[] = []): SnapshotMessage => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  files: files.map((f) => ({ ...f, hlc: hlc(1) })),
  dirs: [],
  attachments: [],
  tombstones: [],
  vaultId,
  maxAttachmentBytes: 10 * 1024 * 1024,
});

const setup = (binding: BindingHooks) => {
  const vault = new InMemoryVault();
  const transport = new FakeTransport();
  let last: string | null = null;
  let t = 0;
  const gen = createHlcGenerator({ node: "dev", clock: { now: () => (t += 1) }, load: () => last, save: (h) => (last = h) });
  const engine = new SyncEngine(vault, transport, gen, binding);
  return { vault, transport, engine };
};

describe("SyncEngine vault binding (REQ-01.12)", () => {
  it("первая синхронизация при пустом локальном vault — привязывается и применяет", async () => {
    const b = makeBinding("", false);
    const { vault, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-X", [{ path: "a.md", content: "A" }]));
    expect(b.bound()).toBe("vault-X");
    expect(await vault.read("a.md")).toBe("A");
  });

  it("обе стороны непустые без подтверждения — отказ, snapshot НЕ применён, исходящие заблокированы", async () => {
    const b = makeBinding("", false);
    const { vault, transport, engine } = setup(b.hooks);
    vault.files.set("local.md", "L"); // локальный непустой
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(b.calls.some((c) => c.startsWith("refuse:needConfirm"))).toBe(true);
    expect(await vault.read("srv.md")).toBeNull(); // не применили
    await engine.handleLocalUpsert("local.md"); // halted → не шлём
    expect(transport.sent).toHaveLength(0);
  });

  it("обе стороны непустые + подтверждение — привязывается и применяет", async () => {
    const b = makeBinding("", true);
    const { vault, engine } = setup(b.hooks);
    vault.files.set("local.md", "L");
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(b.bound()).toBe("vault-X");
    expect(await vault.read("srv.md")).toBe("S");
  });

  it("привязан к X, сервер прислал Y — отказ (mismatch), не применяем и не шлём", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, transport, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-Y", [{ path: "srv.md", content: "S" }]));
    expect(b.calls.some((c) => c.startsWith("refuse:mismatch"))).toBe(true);
    expect(await vault.read("srv.md")).toBeNull();
    vault.files.set("x.md", "X");
    await engine.handleLocalUpsert("x.md");
    expect(transport.sent).toHaveLength(0);
  });

  it("привязан к X, сервер прислал X — применяет нормально", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(await vault.read("srv.md")).toBe("S");
  });
});
