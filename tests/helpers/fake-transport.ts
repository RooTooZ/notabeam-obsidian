import type { ClientMessage, ServerMessage } from "@notabeam/shared";

import type { Transport } from "@/sync/transport";

// Движок отправляет только delta-сообщения (auth — внутреннее дело WsTransport),
// поэтому sent типизирован как массив дельт — тесты обращаются к .delta напрямую.
type SentDelta = Extract<ClientMessage, { type: "delta" }>;

export class FakeTransport implements Transport {
  readonly sent: SentDelta[] = [];
  connected = false;
  private messageHandler: (msg: ServerMessage) => void = () => undefined;

  connect(): void {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }

  send(msg: ClientMessage): void {
    if (msg.type === "delta") this.sent.push(msg);
  }

  onMessage(handler: (msg: ServerMessage) => void): void {
    this.messageHandler = handler;
  }

  onOpen(): void {
    // not needed in tests
  }

  // test helper: emulate an incoming server message
  emit(msg: ServerMessage): void {
    this.messageHandler(msg);
  }
}
