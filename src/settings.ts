import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";

import { t } from "./i18n";

export type SyncSettings = {
  serverUrl: string;
  vaultToken: string;
  deviceId: string;
  boundVaultId: string;
  confirmMerge: boolean;
};

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "ws://localhost:3000",
  vaultToken: "",
  deviceId: "",
  boundVaultId: "",
  confirmMerge: false,
};

export interface SyncPluginLike extends Plugin {
  settings: SyncSettings;
  saveSettings(): Promise<void>;
  restartSync(): void;
}

export class SyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SyncPluginLike,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settings.serverUrl.name"))
      .setDesc(t("settings.serverUrl.desc"))
      .addText((c) =>
        c.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t("settings.vaultToken.name")).addText((c) =>
      c.setValue(this.plugin.settings.vaultToken).onChange(async (v) => {
        this.plugin.settings.vaultToken = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName(t("settings.confirmMerge.name"))
      .setDesc(t("settings.confirmMerge.desc"))
      .addToggle((c) =>
        c.setValue(this.plugin.settings.confirmMerge).onChange(async (v) => {
          this.plugin.settings.confirmMerge = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText(t("settings.reconnect.button")).onClick(() => this.plugin.restartSync()),
    );
  }
}
