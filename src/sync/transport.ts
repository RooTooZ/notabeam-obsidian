import type { ClientMessage, ServerMessage } from "@notabeam/shared";

// Состояние канала — для индикации в UI (Spec-09, REQ-09.3).
export type TransportStatus = "connecting" | "open" | "offline" | "unauthorized";

// Абстракция канала к серверу. Реализуется поверх WebSocket (runtime) и фейком (тесты).
export interface Transport {
  connect(): void;
  close(): void;
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onOpen(handler: () => void): void;
  onStatus?(handler: (status: TransportStatus) => void): void;
}
