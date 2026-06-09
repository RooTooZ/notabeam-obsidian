import { Notice, Platform, Plugin, requestUrl, TFile, TFolder } from "obsidian";

import { detectLocale, setLocale, t } from "./i18n";
import { DEFAULT_SETTINGS, SyncSettingTab, type SyncSettings } from "./settings";
import { type BlobHttp, HttpBlobClient, httpBaseFromWs } from "./sync/blob-client";
import { createHlcGenerator } from "./sync/hlc";
import { ObsidianVault } from "./sync/obsidian-vault";
import {
  type AttachmentDeps,
  type BindingHooks,
  type FileSyncState,
  SyncEngine,
} from "./sync/sync-engine";
import { VaultWatcher } from "./sync/vault-watcher";
import { WsTransport } from "./sync/ws-transport";
import { FileBadges } from "./ui/file-badges";
import { STATUS_ICON, STATUS_KEY, transportToUi, type UiStatus } from "./ui/status";

const FILE_STATE_KEY: Record<FileSyncState, "file.synced" | "file.pending" | "file.error"> = {
  synced: "file.synced",
  pending: "file.pending",
  error: "file.error",
};

const MB = 1024 * 1024;

// HTTP-транспорт blob через Obsidian requestUrl (без CORS, кроссплатформенно).
const obsidianHttp: BlobHttp = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return { status: res.status, arrayBuffer: res.arrayBuffer };
};

type PluginData = { settings: SyncSettings; lastHlc: string | null; lastSeq: number };

export default class NotabeamPlugin extends Plugin {
  override settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private lastHlc: string | null = null;
  private lastSeq = 0; // курсор устройства (Spec-02)
  private engine: SyncEngine | null = null;
  private watcher: VaultWatcher | null = null;
  private statusEl: HTMLElement | null = null;
  private badges: FileBadges | null = null;

  override async onload(): Promise<void> {
    setLocale(detectLocale());
    await this.loadPluginData();
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => this.openSettings());
    this.addSettingTab(new SyncSettingTab(this.app, this));
    // Пер-файловые значки в проводнике (Spec-09) — desktop-only поверхность
    // (DOM file-explorer); на mobile не включаем (REQ-10.4).
    if (Platform.isDesktop) {
      this.badges = new FileBadges((s) => t(FILE_STATE_KEY[s]));
      this.app.workspace.onLayoutReady(() => this.badges?.start());
    }
    this.restartSync();
  }

  private setStatus(s: UiStatus): void {
    if (!this.statusEl) return;
    this.statusEl.setText(`${STATUS_ICON[s]} Notabeam`);
    const label = t(STATUS_KEY[s]);
    this.statusEl.setAttribute("aria-label", label);
    this.statusEl.title = label;
  }

  private openSettings(): void {
    // app.setting — desktop-only API; на mobile не трогаем (REQ-10.4).
    if (!Platform.isDesktop) return;
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } })
      .setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  override onunload(): void {
    this.watcher?.dispose();
    this.engine?.stop();
    this.badges?.dispose();
  }

  restartSync(): void {
    this.watcher?.dispose();
    this.watcher = null;
    this.engine?.stop();
    this.engine = null;
    if (!this.settings.vaultToken) {
      this.setStatus("disabled");
      return;
    }

    const port = new ObsidianVault(this.app.vault);
    const transport = new WsTransport(
      this.settings.serverUrl,
      this.settings.vaultToken,
      this.settings.deviceId,
      undefined,
      () => this.lastSeq, // курсор при (пере)подключении (Spec-02)
    );
    transport.onStatus((s) => this.setStatus(transportToUi(s)));
    this.setStatus("connecting");
    const hlc = createHlcGenerator({
      node: this.settings.deviceId,
      clock: { now: () => Date.now() },
      load: () => this.lastHlc,
      save: (h) => {
        this.lastHlc = h;
        void this.persist();
      },
    });

    const binding: BindingHooks = {
      getBound: () => this.settings.boundVaultId,
      bind: (id) => {
        this.settings.boundVaultId = id;
        void this.saveSettings();
      },
      allowMerge: () => this.settings.confirmMerge,
      onRefuse: (reason, serverVaultId, bound) => {
        const msg =
          reason === "mismatch"
            ? t("binding.mismatch", { bound: bound.slice(0, 8), server: serverVaultId.slice(0, 8) })
            : t("binding.needConfirm");
        new Notice(msg, 0);
        this.setStatus("error");
      },
    };

    const blob = new HttpBlobClient(
      httpBaseFromWs(this.settings.serverUrl),
      this.settings.vaultToken,
      obsidianHttp,
    );
    const attachments: AttachmentDeps = {
      blob,
      onOversize: (path, size, maxBytes) => {
        new Notice(
          t("attachment.tooLarge", {
            path,
            size: (size / MB).toFixed(1),
            max: Math.floor(maxBytes / MB),
          }),
          0,
        );
      },
    };

    this.engine = new SyncEngine(
      port,
      transport,
      hlc,
      binding,
      attachments,
      (path, state) => this.badges?.setState(path, state),
      {
        load: () => this.lastSeq,
        save: (seq) => {
          this.lastSeq = seq;
          void this.persist();
        },
      },
    );
    this.engine.start();

    const watcher = new VaultWatcher(this.engine);
    this.watcher = watcher;
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile) watcher.onUpsert(f.path);
        else if (f instanceof TFolder) watcher.onMkdir(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile) watcher.onUpsert(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFolder) watcher.onRmdir(f.path);
        else {
          watcher.onDelete(f.path);
          this.badges?.clear(f.path); // убрать значок удалённого файла
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile) {
          this.badges?.clear(oldPath); // значок переедет на новый путь после синка
          watcher.onRename(oldPath, f.path);
        }
        // Папку переносим как сущность (renamedir): атомарный префиксный перенос
        // папки + содержимого, без гонок с file-rename событиями детей.
        else if (f instanceof TFolder) watcher.onRenamedir(oldPath, f.path);
      }),
    );
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    if (data?.settings) this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.lastHlc = data?.lastHlc ?? null;
    this.lastSeq = data?.lastSeq ?? 0;
  }

  private async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      lastHlc: this.lastHlc,
      lastSeq: this.lastSeq,
    } satisfies PluginData);
  }
}
