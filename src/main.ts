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
  type ShadowEntry,
  SyncEngine,
} from "./sync/sync-engine";
import { VaultWatcher } from "./sync/vault-watcher";
import { WsTransport } from "./sync/ws-transport";
import { FileBadges } from "./ui/file-badges";
import { handleSetupUri } from "./ui/setup-link";
import { STATUS_ICON, STATUS_KEY, transportToUi, type UiStatus } from "./ui/status";

const FILE_STATE_KEY: Record<FileSyncState, "file.synced" | "file.pending" | "file.error"> = {
  synced: "file.synced",
  pending: "file.pending",
  error: "file.error",
};

const MB = 1024 * 1024;

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

type ShadowMap = Record<string, ShadowEntry>;
type PluginData = {
  settings: SyncSettings;
  lastHlc: string | null;
  lastSeq: number;
  shadow: ShadowMap;
};

export default class NotabeamPlugin extends Plugin {
  override settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private lastHlc: string | null = null;
  private lastSeq = 0;
  private shadow: ShadowMap = {};
  private engine: SyncEngine | null = null;
  private watcher: VaultWatcher | null = null;
  private statusEl: HTMLElement | null = null;
  private badges: FileBadges | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();

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
    this.registerObsidianProtocolHandler("notabeam", (params) => handleSetupUri(this, params));
    if (Platform.isDesktop) {
      this.badges = new FileBadges((s) => t(FILE_STATE_KEY[s]));
      this.app.workspace.onLayoutReady(() => this.badges?.start());
    }
    try {
      this.restartSync();
    } catch {
      this.setStatus("error"); // битая конфигурация не должна блокировать загрузку плагина
    }
    // События регистрируем после готовности layout: при старте Obsidian эмитит `create`
    // для каждого уже существующего файла («create storm»). Поймав их на свежем движке,
    // мы пере-апсертили бы весь vault со свежими HLC и затёрли чужие правки (AUD-003).
    // После onLayoutReady стартовые события уже прошли; офлайн-правки подхватывает
    // reconcile (по persisted shadow), а не эти события.
    this.app.workspace.onLayoutReady(() => this.registerVaultEvents());
  }

  private setStatus(s: UiStatus): void {
    if (!this.statusEl) return;
    this.statusEl.setText(`${STATUS_ICON[s]} Notabeam`);
    const label = t(STATUS_KEY[s]);
    this.statusEl.setAttribute("aria-label", label);
    this.statusEl.title = label;
  }

  private openSettings(): void {
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
    void this.persist(); // best-effort флаш отложенной записи
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

    const port = new ObsidianVault(this.app.vault, this.app.workspace);
    const transport = new WsTransport(
      this.settings.serverUrl,
      this.settings.vaultToken,
      this.settings.deviceId,
      undefined,
      () => this.lastSeq,
    );
    transport.onStatus((s) => this.setStatus(transportToUi(s)));
    this.setStatus("connecting");
    const hlc = createHlcGenerator({
      node: this.settings.deviceId,
      clock: { now: () => Date.now() },
      load: () => this.lastHlc,
      save: (h) => {
        this.lastHlc = h;
        this.schedulePersist();
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
            : reason === "invalid"
              ? t("binding.invalid")
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
          this.schedulePersist();
        },
      },
      {
        load: () => this.shadow,
        setFile: (path, entry) => {
          this.shadow[path] = entry;
          this.schedulePersist();
        },
        deleteFile: (path) => {
          if (path in this.shadow) {
            delete this.shadow[path];
            this.schedulePersist();
          }
        },
      },
    );
    this.engine.start();

    // Обработчики событий регистрируются ОДИН раз в onload (registerVaultEvents) и
    // делегируют в текущий this.watcher — иначе повторный restartSync плодит «двойной движок».
    this.watcher = new VaultWatcher(this.engine);
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile) this.watcher?.onUpsert(f.path);
        else if (f instanceof TFolder) this.watcher?.onMkdir(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile) this.watcher?.onUpsert(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFolder) this.watcher?.onRmdir(f.path);
        else {
          this.watcher?.onDelete(f.path);
          this.badges?.clear(f.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile) {
          this.badges?.clear(oldPath);
          this.watcher?.onRename(oldPath, f.path);
        } else if (f instanceof TFolder) this.watcher?.onRenamedir(oldPath, f.path);
      }),
    );
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  // Смена сервера/токена: сбрасываем курсор (lastSeq=0), форсируя snapshot и
  // проверку привязки. Сбрасываем и persisted shadow — он описывал контент другого
  // сервера; иначе reconcile решил бы, что новый (пустой) сервер уже всё знает, и не
  // зальёт vault. boundVaultId НЕ трогаем — его меняет только явное действие.
  resetSyncCursor(): void {
    this.lastSeq = 0;
    this.shadow = {};
    void this.persist();
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    if (data?.settings) this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.lastHlc = data?.lastHlc ?? null;
    this.lastSeq = data?.lastSeq ?? 0;
    this.shadow = data?.shadow ?? {};
  }

  // Горячий путь (курсор/HLC на каждую дельту) дебаунсится, чтобы не переписывать
  // data.json тысячи раз при первичной синхронизации и не терять настройки на гонке.
  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 800);
  }

  private async persist(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // единая цепочка: записи data.json не выполняются параллельно (риск битого JSON)
    this.persistChain = this.persistChain.then(() =>
      this.saveData({
        settings: this.settings,
        lastHlc: this.lastHlc,
        lastSeq: this.lastSeq,
        shadow: this.shadow,
      } satisfies PluginData),
    );
    await this.persistChain;
  }
}
