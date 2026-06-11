import { Modal, Notice, Setting, type App } from "obsidian";

import { t } from "../i18n";
import type { SyncPluginLike } from "../settings";

export type SetupParams = { serverUrl: string; token: string };

export function parseSetupParams(params: Record<string, string | undefined>): SetupParams | null {
  const serverUrl = (params.server ?? "").trim();
  const token = (params.token ?? "").trim();
  if (!/^wss?:\/\/.+/.test(serverUrl)) return null;
  if (!token) return null;
  return { serverUrl, token };
}

export async function applySetup(plugin: SyncPluginLike, setup: SetupParams): Promise<void> {
  plugin.settings.serverUrl = setup.serverUrl;
  plugin.settings.vaultToken = setup.token;
  plugin.resetSyncCursor(); // новый сервер/токен → форсировать snapshot + проверку привязки
  await plugin.saveSettings();
  plugin.restartSync();
}

export class SetupConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly setup: SetupParams,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t("setup.title"));
    this.contentEl.createEl("p", { text: t("setup.message", { server: this.setup.serverUrl }) });
    if (this.setup.serverUrl.startsWith("ws://")) {
      const warn = this.contentEl.createEl("p", { text: t("setup.insecureWarning") });
      warn.style.color = "var(--color-orange, #e0823d)";
    }
    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText(t("setup.confirm"))
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      )
      .addButton((b) => b.setButtonText(t("setup.cancel")).onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export function handleSetupUri(
  plugin: SyncPluginLike & { app: App },
  params: Record<string, string | undefined>,
): void {
  const setup = parseSetupParams(params);
  if (setup === null) {
    new Notice(t("setup.invalid"));
    return;
  }
  new SetupConfirmModal(plugin.app, setup, () => {
    void applySetup(plugin, setup).then(
      () => new Notice(t("setup.applied", { server: setup.serverUrl })),
    );
  }).open();
}
