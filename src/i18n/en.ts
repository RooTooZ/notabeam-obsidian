export const en = {
  "settings.serverUrl.name": "Server address",
  "settings.serverUrl.desc": "ws:// or wss://",
  "settings.vaultToken.name": "Vault token",
  "settings.reconnect.button": "Reconnect",
  "settings.confirmMerge.name": "Confirm merge",
  "settings.confirmMerge.desc":
    "Allow merging this non-empty vault with a non-empty server vault — only if it is the same vault.",
  "setup.title": "Connect to sync server?",
  "setup.message":
    "This will set the sync server for this vault to {server} and replace the current token. Continue only if you opened this link or QR code from your own server setup.",
  "setup.confirm": "Connect",
  "setup.cancel": "Cancel",
  "setup.applied": "Notabeam: connected to {server}.",
  "setup.invalid": "Notabeam: invalid setup link.",
  "setup.insecureWarning":
    "⚠ Unencrypted connection (ws://): the token and your notes travel in cleartext. Use only on a trusted local network.",
  "onboarding.title": "Get started",
  "onboarding.intro":
    "This vault is not connected yet. Run your own sync server with one command on any Linux server:",
  "onboarding.link":
    "The setup wizard prints a setup link and a QR code — click the link on desktop, or scan the QR from your phone, and the plugin configures itself. You can also enter the server address and token below manually.",
  "onboarding.guide": "Full self-hosting guide (Docker, Kubernetes, LAN) →",
  "binding.mismatch":
    "Notabeam: sync stopped. This vault is bound to {bound}…, but the server reported {server}…. Looks like the wrong server/token.",
  "binding.needConfirm":
    "Notabeam: both this vault and the server have content. To merge them, enable “Confirm merge” in Notabeam settings — only if it is the same vault.",
  "binding.invalid":
    "Notabeam: sync stopped. The server did not identify the vault. The connection is rejected for safety — check the server address and token.",
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
