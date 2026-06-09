import { ServerMessageSchema, type ClientMessage, type ServerMessage } from "@notabeam/shared";

import type { Transport, TransportStatus } from "./transport";

export type WsFactory = (url: string) => WebSocket;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const WS_OPEN = 1;

export const nextBackoffDelay = (
  attempt: number,
  base = BASE_DELAY_MS,
  max = MAX_DELAY_MS,
): number => Math.min(base * 2 ** attempt, max);

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private messageHandler: (msg: ServerMessage) => void = () => undefined;
  private openHandler: () => void = () => undefined;
  private statusHandler: (status: TransportStatus) => void = () => undefined;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersAbort: AbortController | null = null;
  private outbox: ClientMessage[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly deviceId: string,
    private readonly wsFactory: WsFactory = (u) => new WebSocket(u),
    private readonly cursorProvider: () => number = () => 0,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    this.teardownSocket();
    this.statusHandler("connecting");
    const cursor = this.cursorProvider();
    const target = `${this.url}/sync?token=${encodeURIComponent(this.token)}&device=${encodeURIComponent(this.deviceId)}&cursor=${cursor}`;
    const ws = this.wsFactory(target);
    this.ws = ws;
    const ac = new AbortController();
    this.listenersAbort = ac;
    const opts = { signal: ac.signal };

    ws.addEventListener(
      "open",
      () => {
        this.attempt = 0;
        this.statusHandler("open");
        this.openHandler();
        this.flushOutbox();
      },
      opts,
    );
    ws.addEventListener(
      "message",
      (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String((ev as MessageEvent).data));
        } catch {
          return;
        }
        const msg = ServerMessageSchema.safeParse(parsed);
        if (msg.success) this.messageHandler(msg.data);
      },
      opts,
    );
    ws.addEventListener(
      "close",
      (ev) => {
        if ((ev as CloseEvent | undefined)?.code === 4401) {
          this.stopped = true;
          this.statusHandler("unauthorized");
          return;
        }
        this.statusHandler("offline");
        this.scheduleReconnect();
      },
      opts,
    );
    ws.addEventListener(
      "error",
      () => {
        this.statusHandler("offline");
        this.scheduleReconnect();
      },
      opts,
    );
  }

  private teardownSocket(): void {
    this.listenersAbort?.abort();
    this.listenersAbort = null;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = nextBackoffDelay(this.attempt);
    const jitter = delay * 0.2 * Math.random();
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay + jitter);
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const msg of pending) this.ws?.send(JSON.stringify(msg));
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onStatus(handler: (status: TransportStatus) => void): void {
    this.statusHandler = handler;
  }
}
