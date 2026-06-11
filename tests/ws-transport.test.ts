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
    // like a real EventTarget: signal.abort() removes the listener
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
    expect(nextBackoffDelay(10)).toBe(30000); // upper bound
  });
});

// MS11-016 / AUD-033: невалидный URL (конструктор WebSocket бросает) не роняет плагин
describe("WsTransport invalid URL", () => {
  it("test_invalid_url_terminal_no_reconnect", () => {
    const statuses: string[] = [];
    const throwingFactory = () => {
      throw new SyntaxError("invalid url");
    };
    const t = new WsTransport("not a url", "tok", "dev", throwingFactory);
    t.onStatus((s) => statuses.push(s));
    expect(() => t.connect()).not.toThrow();
    vi.advanceTimersByTime(60000);
    expect(statuses).toContain("unauthorized"); // терминальный статус, без реконнект-шторма
  });
});

// первый серверный ответ = подтверждение auth → транспорт начинает слать дельты
const authOk = (ws: FakeWS): void =>
  ws.emit("message", {
    data: JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", files: [], vaultId: "v1" }),
  });
// исходящие дельты, без auth-сообщения
const deltasOf = (ws: FakeWS): unknown[] =>
  ws.sent.map((s) => JSON.parse(s)).filter((m: { type: string }) => m.type === "delta");

describe("WsTransport reconnect", () => {
  it("test_reconnects_after_close", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    expect(FakeWS.instances).toHaveLength(1);
    FakeWS.instances[0]!.emit("close");
    vi.advanceTimersByTime(1500); // base 1000 + jitter
    expect(FakeWS.instances).toHaveLength(2);
  });

  // AUD-023: токена нет в URL; первым на open уходит auth-сообщение.
  it("test_auth_message_first_no_token_in_url", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toBe("ws://x/sync"); // без ?token=
    ws.emit("open");
    const first = JSON.parse(ws.sent[0]!);
    expect(first).toMatchObject({ type: "auth", token: "tok", device: "dev" });
  });

  // MS11-008 / AUD-010: дельта, отправленная но не подтверждённая (умирающий сокет),
  // переотправляется на reconnect; подтверждённая (ack) — нет.
  it("test_unacked_delta_resent_on_reconnect", () => {
    const hlc = "000000000000001:000000:x";
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.emit("open");
    authOk(ws1);
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "x.md", hlc } });
    expect(deltasOf(ws1)).toHaveLength(1);
    ws1.emit("close");
    vi.advanceTimersByTime(1500);
    const ws2 = FakeWS.instances[1]!;
    ws2.emit("open");
    authOk(ws2);
    expect(deltasOf(ws2)).toHaveLength(1); // переотправлено (ack не приходил)
  });

  it("test_acked_delta_not_resent_on_reconnect", () => {
    const hlc = "000000000000001:000000:x";
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.emit("open");
    authOk(ws1);
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "x.md", hlc } });
    ws1.emit("message", { data: JSON.stringify({ v: PROTOCOL_VERSION, type: "ack", hlc }) });
    ws1.emit("close");
    vi.advanceTimersByTime(1500);
    const ws2 = FakeWS.instances[1]!;
    ws2.emit("open");
    authOk(ws2);
    expect(deltasOf(ws2)).toHaveLength(0); // acked → не переотправлено
  });

  it("test_stop_cancels_reconnect", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    FakeWS.instances[0]!.emit("close");
    t.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("test_offline_send_is_queued_then_flushed_after_auth", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    // socket not open yet (readyState=0) → send should be queued, not lost
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "off.md", hlc: "h" } });
    expect(deltasOf(ws)).toHaveLength(0);
    // open → уходит только auth-сообщение; дельта ждёт auth-ok
    ws.emit("open");
    expect(deltasOf(ws)).toHaveLength(0);
    // первый серверный ответ (auth-ok) → очередь дельт сбрасывается
    authOk(ws);
    const sent = deltasOf(ws) as { delta: { path: string } }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.delta.path).toBe("off.md");
  });

  it("test_send_after_auth_goes_immediately", () => {
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws = FakeWS.instances[0]!;
    ws.emit("open");
    authOk(ws);
    t.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path: "x.md", hlc: "h" } });
    expect(deltasOf(ws)).toHaveLength(1);
  });

  it("test_no_listener_leak_on_reconnect", () => {
    // REQ-10.3: the previous socket's listeners are removed on reconnect —
    // a late event on the old socket does not spawn an extra reconnect.
    const t = new WsTransport("ws://x", "tok", "dev", factory);
    t.connect();
    const ws1 = FakeWS.instances[0]!;
    ws1.emit("close"); // schedule reconnect
    vi.advanceTimersByTime(1500); // open() -> teardown ws1 + creates ws2
    expect(FakeWS.instances).toHaveLength(2);
    // ws1 listeners should be removed
    expect((ws1.listeners["error"] ?? []).length).toBe(0);
    // a late event on ws1 triggers nothing
    ws1.emit("error");
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(2); // ws3 did not appear
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
      data: JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", files: [], vaultId: "v1" }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("snapshot");
  });
});
