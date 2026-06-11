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
  resetSyncCursor(): void;
}

export function shouldShowOnboarding(settings: SyncSettings): boolean {
  return !settings.vaultToken;
}

const INSTALL_COMMAND = "curl -fsSL https://notabeam.app/install.sh | bash";
const GUIDE_URL = "https://notabeam.app/self-host";

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

    if (shouldShowOnboarding(this.plugin.settings)) {
      const box = containerEl.createDiv();
      box.createEl("h3", { text: t("onboarding.title") });
      box.createEl("p", { text: t("onboarding.intro") });
      box.createEl("pre").createEl("code", { text: INSTALL_COMMAND });
      box.createEl("p", { text: t("onboarding.link") });
      box.createEl("p").createEl("a", { text: t("onboarding.guide"), href: GUIDE_URL });
    }

    new Setting(containerEl)
      .setName(t("settings.serverUrl.name"))
      .setDesc(t("settings.serverUrl.desc"))
      .addText((c) =>
        c.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
          this.plugin.settings.serverUrl = v.trim();
          this.plugin.resetSyncCursor(); // смена адреса → форсировать snapshot + проверку привязки
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t("settings.vaultToken.name")).addText((c) => {
      c.inputEl.type = "password"; // токен = полный доступ к vault — маскируем от подглядывания
      c.inputEl.autocomplete = "off";
      c.setValue(this.plugin.settings.vaultToken).onChange(async (v) => {
        this.plugin.settings.vaultToken = v.trim();
        this.plugin.resetSyncCursor(); // смена токена → форсировать snapshot + проверку привязки
        await this.plugin.saveSettings();
      });
    });

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
