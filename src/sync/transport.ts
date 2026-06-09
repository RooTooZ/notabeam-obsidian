import type { ClientMessage, ServerMessage } from "@notabeam/shared";

export type TransportStatus = "connecting" | "open" | "offline" | "unauthorized";

export interface Transport {
  connect(): void;
  close(): void;
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onOpen(handler: () => void): void;
  onStatus?(handler: (status: TransportStatus) => void): void;
}
