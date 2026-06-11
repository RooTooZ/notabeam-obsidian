import { encodeHlc, PROTOCOL_VERSION, type ServerMessage } from "@notabeam/shared";
import { describe, expect, it } from "vitest";

import { createHlcGenerator } from "@/sync/hlc";
import { SyncEngine } from "@/sync/sync-engine";

import { FakeTransport } from "./helpers/fake-transport";
import { InMemoryVault } from "./helpers/in-memory-vault";

const hlc = (n: number) => encodeHlc({ millis: 1000 + n, counter: 0, node: "srv" });

// Старая версия пишется ДОЛЬШЕ новой: без сериализации входящих устаревшая запись
// завершилась бы последней и победила (реордер). FIFO-очередь это исключает.
class SlowVault extends InMemoryVault {
  override async write(path: string, content: string): Promise<void> {
    await new Promise((r) => setTimeout(r, content === "v1" ? 20 : 1));
    await super.write(path, content);
  }
}

const liveDelta = (path: string, content: string, n: number, seq: number): ServerMessage => ({
  v: PROTOCOL_VERSION,
  type: "delta",
  delta: { op: "upsert", path, content, hlc: hlc(n) },
  seq,
});

describe("SyncEngine incoming serialization (MS11-006)", () => {
  it("test_two_live_deltas_same_path_apply_in_order", async () => {
    const vault = new SlowVault();
    const transport = new FakeTransport();
    let last: string | null = null;
    let t = 0;
    const gen = createHlcGenerator({
      node: "dev",
      clock: { now: () => (t += 1) },
      load: () => last,
      save: (h) => (last = h),
    });
    let savedSeq = 0;
    const engine = new SyncEngine(vault, transport, gen, undefined, undefined, undefined, {
      load: () => 0,
      save: (seq) => {
        savedSeq = seq;
      },
    });
    engine.start();
    transport.emit(liveDelta("a.md", "v1", 1, 1));
    transport.emit(liveDelta("a.md", "v2", 2, 2));
    await engine.whenIdle();
    expect(await vault.read("a.md")).toBe("v2");
    expect(savedSeq).toBe(2);
  });
});
