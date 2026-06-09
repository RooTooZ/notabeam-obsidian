import { PROTOCOL_VERSION, type ServerMessage } from "@notabeam/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextBackoffDelay, WsTransport } from "@/sync/ws-transport";

class FakeWS {
  static instances: FakeWS[] = [];
  readonly listeners: Record<string, Array<(ev: unknown) => void>> = {};
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  addEventListener(
    type: string,
    cb: (ev: unknown) => void,
    opts?: { signal?: AbortSignal },
  ): void {
    (this.listeners[type] ??= []).push(cb);
    // как настоящий EventTarget: signal.abort() снимает слушатель
    opts?.signal?.addEventListener("abort", () => {
      const arr = this.listeners[type];
      if (arr) this.listeners[type] = arr.filter((f) => f !== cb);
    });
  }
  emit(type: string, ev?: unknown): void {
    if (type === "open") this.readyState = 1; // OPEN
    (this.listeners[type] ?? []).forEach((cb) => cb(ev));
  }
  close(): void {
    this.readyState = 3; // CLOSED
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

const factory = (u: string) => new FakeWS(u) as unknown as WebSocket;

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("nextBackoffDelay", () => {
  it("test_backoff_grows_and_caps", () => {
    expect(nextBackoffDelay(0)).toBe(1000);
    expect(nextBackoffDelay(1)).toBe(2000);
    expect(nextBackoffDelay(2)).toBe(4000);
    expect(nextBackoffDelay(10)).toBe(30000); // верхняя граница
  });
});

describe("WsTransport reconnect", () => {
  it("test_reconnects_after_close", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    expect(FakeWS.instances).toHaveLength(1);
    FakeWS.instances[0]!.emit("close");
    vi.advanceTimersByTime(1500); // base 1000 + jitter
    expect(FakeWS.instances).toHaveLength(2);
  });

  it("test_stop_cancels_reconnect", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    FakeWS.instances[0]!.emit("close");
    t.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("test_offline_send_is_queued_and_flushed_on_open", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    // сокет ещё не open (readyState=0) → send должен попасть в очередь, не потеряться
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "off.md", hlc: "h" } });
    expect(ws.sent).toHaveLength(0);
    // соединение открылось → очередь досылается
    ws.emit("open");
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).delta.path).toBe("off.md");
  });

  it("test_send_when_open_goes_immediately", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit("open");
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "x.md", hlc: "h" } });
    expect(ws.sent).toHaveLength(1);
  });

  it("test_no_listener_leak_on_reconnect", () => {
    // REQ-10.3: слушатели прошлого сокета снимаются при переподключении —
    // позднее событие на старом сокете не плодит лишний reconnect.
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.emit("close"); // планируем reconnect
    vi.advanceTimersByTime(1500); // open() -> teardown ws1 + создаёт ws2
    expect(FakeWS.instances).toHaveLength(2);
    // у ws1 слушатели должны быть сняты
    expect((ws1.listeners["error"] ?? []).length).toBe(0);
    // позднее событие на ws1 ничего не триггерит
    ws1.emit("error");
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(2); // ws3 не появился
  });

  it("test_close_removes_listeners", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit("open");
    t.close();
    expect((ws.listeners["message"] ?? []).length).toBe(0);
  });

  it("test_resync_snapshot_on_reconnect", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    const received: ServerMessage[] = [];
    t.onMessage((m) => received.push(m));
    t.connect();
    FakeWS.instances[0]!.emit("close");
    vi.advanceTimersByTime(1500);
    FakeWS.instances[1]!.emit("message", {
      data: JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", files: [] }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("snapshot");
  });
});
