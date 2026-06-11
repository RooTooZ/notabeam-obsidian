import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "@notabeam/shared";

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
  // Аутентифицировано в текущем соединении (пришёл первый серверный ответ на auth-сообщение).
  // До этого дельты не отправляем — сервер их всё равно отвергнет до auth (AUD-023/043).
  private authConfirmed = false;
  // Неподтверждённые дельты (ключ — hlc): и очередь оффлайна, и in-flight в ожидании ack.
  // Переотправляются после auth-ok (умирающий сокет мог проглотить отправку без ack). Сервер
  // идемпотентен (compareHlc), поэтому at-least-once безопасен.
  private unacked = new Map<string, ClientMessage>();

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
    this.authConfirmed = false;
    // AUD-023: токен НЕ в query (не утекает в логи/историю) — уходит auth-сообщением на open
    const target = `${this.url}/sync`;
    let ws: WebSocket;
    try {
      ws = this.wsFactory(target);
    } catch {
      // невалидный serverUrl (WebSocket-конструктор бросает синхронно) — терминальный
      // статус без реконнект-шторма; плагин при этом продолжает грузиться
      this.stopped = true;
      this.statusHandler("unauthorized");
      return;
    }
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
        // auth-сообщение первым; unacked зашлём после auth-ok (первого серверного ответа)
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "auth",
            token: this.token,
            device: this.deviceId,
            cursor: this.cursorProvider(),
          }),
        );
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
        if (!msg.success) return;
        // первый серверный ответ = auth-ok (snapshot/ops/delta); теперь можно слать unacked
        if (!this.authConfirmed) {
          this.authConfirmed = true;
          this.resendUnacked();
        }
        // ack снимает дельту с переотправки (транспорт) И доходит до движка: он отмечает
        // путь как подтверждённый сервером — baseline для конфликт-копий (AUD-004).
        if (msg.data.type === "ack") this.unacked.delete(msg.data.hlc);
        this.messageHandler(msg.data);
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
    if (msg.type === "delta") this.unacked.set(msg.delta.hlc, msg); // держим до ack
    // шлём только после auth-ok: до этого сервер отвергнет дельту (AUD-023). Не открыт или
    // не аутентифицирован — дельта останется в unacked и уйдёт на resendUnacked.
    if (this.ws && this.ws.readyState === WS_OPEN && this.authConfirmed) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private resendUnacked(): void {
    if (this.ws?.readyState !== WS_OPEN) return;
    for (const msg of this.unacked.values()) this.ws.send(JSON.stringify(msg));
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
