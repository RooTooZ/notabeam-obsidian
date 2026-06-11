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
  it("first sync with an empty local vault — binds and applies", async () => {
    const b = makeBinding("", false);
    const { vault, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-X", [{ path: "a.md", content: "A" }]));
    expect(b.bound()).toBe("vault-X");
    expect(await vault.read("a.md")).toBe("A");
  });

  it("both sides non-empty without confirmation — refuses, snapshot NOT applied, outgoing blocked", async () => {
    const b = makeBinding("", false);
    const { vault, transport, engine } = setup(b.hooks);
    vault.files.set("local.md", "L"); // local is non-empty
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(b.calls.some((c) => c.startsWith("refuse:needConfirm"))).toBe(true);
    expect(await vault.read("srv.md")).toBeNull(); // not applied
    await engine.handleLocalUpsert("local.md"); // halted → don't send
    expect(transport.sent).toHaveLength(0);
  });

  it("both sides non-empty + confirmation — binds and applies", async () => {
    const b = makeBinding("", true);
    const { vault, engine } = setup(b.hooks);
    vault.files.set("local.md", "L");
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(b.bound()).toBe("vault-X");
    expect(await vault.read("srv.md")).toBe("S");
  });

  it("bound to X, server sent Y — refuses (mismatch), does not apply or send", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, transport, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-Y", [{ path: "srv.md", content: "S" }]));
    expect(b.calls.some((c) => c.startsWith("refuse:mismatch"))).toBe(true);
    expect(await vault.read("srv.md")).toBeNull();
    vault.files.set("x.md", "X");
    await engine.handleLocalUpsert("x.md");
    expect(transport.sent).toHaveLength(0);
  });

  it("bound to X, server sent X — applies normally", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("vault-X", [{ path: "srv.md", content: "S" }]));
    expect(await vault.read("srv.md")).toBe("S");
  });

  // MS11-005 / AUD-006: пустой vaultId в snapshot — невалиден, не применяем
  it("test_snapshot_empty_vaultid_refused_invalid", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, engine } = setup(b.hooks);
    await engine.applySnapshot(snap("", [{ path: "srv.md", content: "S" }]));
    expect(b.calls.some((c) => c.startsWith("refuse:invalid"))).toBe(true);
    expect(await vault.read("srv.md")).toBeNull();
  });

  // MS11-005 / AUD-005: ops чужого vault отклоняется (mismatch), не применяется
  it("test_ops_from_mismatched_vault_refused", async () => {
    const b = makeBinding("vault-X", false);
    const { vault, transport, engine } = setup(b.hooks);
    engine.start();
    transport.emit({
      v: PROTOCOL_VERSION,
      type: "ops",
      vaultId: "vault-Y",
      maxAttachmentBytes: 10 * 1024 * 1024,
      deltas: [{ seq: 1, delta: { op: "upsert", path: "y.md", content: "Y", hlc: hlc(1) } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(b.calls.some((c) => c.startsWith("refuse:mismatch"))).toBe(true);
    expect(await vault.read("y.md")).toBeNull();
  });
});
