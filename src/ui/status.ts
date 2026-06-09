import type { TKey } from "../i18n/en";
import type { TransportStatus } from "../sync/transport";

export type UiStatus = "disabled" | "connecting" | "synced" | "offline" | "error";

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
