export const en = {
  "settings.serverUrl.name": "Server address",
  "settings.serverUrl.desc": "ws:// or wss://",
  "settings.vaultToken.name": "Vault token",
  "settings.reconnect.button": "Reconnect",
  "settings.confirmMerge.name": "Confirm merge",
  "settings.confirmMerge.desc":
    "Allow merging this non-empty vault with a non-empty server vault — only if it is the same vault.",
  "binding.mismatch":
    "Notabeam: sync stopped. This vault is bound to {bound}…, but the server reported {server}…. Looks like the wrong server/token.",
  "binding.needConfirm":
    "Notabeam: both this vault and the server have content. To merge them, enable “Confirm merge” in Notabeam settings — only if it is the same vault.",
  "attachment.tooLarge":
    "Notabeam: “{path}” ({size} MB) exceeds the {max} MB limit and was not synced.",
  "file.synced": "Synced",
  "file.pending": "Syncing…",
  "file.error": "Not synced — error",
  "status.disabled": "Notabeam: not configured",
  "status.connecting": "Notabeam: connecting…",
  "status.synced": "Notabeam: synced",
  "status.offline": "Notabeam: offline, reconnecting…",
  "status.error": "Notabeam: error — check settings",
} as const;

export type TKey = keyof typeof en;
