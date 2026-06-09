import type { ClientMessage, ServerMessage } from "@notabeam/shared";

import type { Transport } from "@/sync/transport";

export class FakeTransport implements Transport {
  readonly sent: ClientMessage[] = [];
  connected = false;
  private messageHandler: (msg: ServerMessage) => void = () => undefined;

  connect(): void {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }

  send(msg: ClientMessage): void {
    this.sent.push(msg);
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
