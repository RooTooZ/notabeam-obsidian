import type { TKey } from "../i18n/en";
import type { TransportStatus } from "../sync/transport";

// Состояние для статус-бара (Spec-09).
export type UiStatus = "disabled" | "connecting" | "synced" | "offline" | "error";

// Маппинг состояния транспорта → UI (чистая функция, юнит-тестируется).
// `open` трактуем как «синхронизировано» (после open сервер шлёт snapshot,
// поэлементных ack в протоколе нет).
export const transportToUi = (s: TransportStatus): UiStatus =>
  ({ connecting: "connecting", open: "synced", offline: "offline", unauthorized: "error" } as const)[s];

export const STATUS_ICON: Record<UiStatus, string> = {
  disabled: "○",
  connecting: "⟳",
  synced: "✓",
  offline: "⚠",
  error: "⛔",
};

export const STATUS_KEY: Record<UiStatus, TKey> = {
  disabled: "status.disabled",
  connecting: "status.connecting",
  synced: "status.synced",
  offline: "status.offline",
  error: "status.error",
};
