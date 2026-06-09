import {
  compareHlc,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  isTextSyncedPath,
  PROTOCOL_VERSION,
  sha256Hex,
  type Delta,
  type ServerMessage,
  type SnapshotMessage,
} from "@notabeam/shared";

import type { BlobClient } from "./blob-client";
import type { HlcGen } from "./hlc";
import type { Transport } from "./transport";
import type { VaultPort } from "./vault-port";

// shadow = последнее синхронизированное состояние файла. Служит и LWW-курсором,
// и механизмом гашения эха: локальное изменение шлётся только если отличается от shadow.
type ShadowEntry = { hlc: string; content: string | null };
// dirShadow — то же для папок-сущностей (exists=true создана, false удалена).
type DirEntry = { hlc: string; exists: boolean };
// attachShadow — то же для вложений; hash=null означает удалено (tombstone).
type AttachEntry = { hlc: string; hash: string | null };

// Имя конфликт-копии (REQ-02.8): «file (conflict <hlc>).md». Двоеточия HLC недопустимы
// в имени файла → заменяем на дефис. Тег вставляется перед расширением.
const conflictPath = (path: string, hlc: string): string => {
  const tag = ` (conflict ${hlc.replace(/[:.]/g, "-")})`;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) + tag + path.slice(dot) : path + tag;
};

// Зависимости синхронизации вложений (Spec-03). Если не переданы — вложения
// не синхронизируются (md-only режим, напр. e2e ядра).
export interface AttachmentDeps {
  blob: BlobClient;
  // Уведомление пользователю о пропуске вложения сверх лимита (REQ-03.3).
  onOversize?(path: string, size: number, maxBytes: number): void;
}

// Статус синхронизации отдельного файла — для пер-файловой индикации (Spec-09): значок
// в проводнике (как в Dropbox). pending — есть несохранённое/неотправленное изменение;
// synced — состояние совпадает с сервером; error — пропущено (напр. вложение сверх лимита).
export type FileSyncState = "pending" | "synced" | "error";
export type FileStatusSink = (path: string, state: FileSyncState) => void;

// Хранилище курсора устройства (Spec-02, REQ-02.2): max применённый seq, персист в data.json.
export interface CursorStore {
  load(): number;
  save(seq: number): void;
}

// Защита от смешивания vault (REQ-01.12): движок сверяет идентичность серверного
// vault с привязкой; решения о привязке/отказе/UX делегируются хосту (плагину).
export interface BindingHooks {
  getBound(): string; // "" если ещё не привязан
  bind(vaultId: string): void;
  allowMerge(): boolean; // пользователь явно подтвердил слияние непустых vault
  onRefuse(reason: "mismatch" | "needConfirm", serverVaultId: string, bound: string): void;
}

export class SyncEngine {
  private shadow = new Map<string, ShadowEntry>();
  private dirShadow = new Map<string, DirEntry>();
  private attachShadow = new Map<string, AttachEntry>();
  private halted = false; // при отказе по привязке: не применяем и не шлём ничего
  private maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES; // обновляется из snapshot

  private cursor = 0; // max применённый seq (Spec-02)

  constructor(
    private readonly port: VaultPort,
    private readonly transport: Transport,
    private readonly hlc: HlcGen,
    private readonly binding?: BindingHooks,
    private readonly attachments?: AttachmentDeps,
    private readonly statusSink?: FileStatusSink,
    private readonly cursorStore?: CursorStore,
  ) {}

  private setCursor(seq: number): void {
    if (seq <= this.cursor) return;
    this.cursor = seq;
    this.cursorStore?.save(seq);
  }

  private status(path: string, state: FileSyncState): void {
    this.statusSink?.(path, state);
  }

  // Помечает файл как «ожидает синхронизации» (вызывает watcher при дебаунсе) — Spec-09.
  markPending(path: string): void {
    if (this.halted) return;
    this.status(path, "pending");
  }

  start(): void {
    this.cursor = this.cursorStore?.load() ?? 0;
    this.transport.onMessage((msg) => void this.onServerMessage(msg));
    this.transport.connect();
  }

  stop(): void {
    this.transport.close();
  }

  private async onServerMessage(msg: ServerMessage): Promise<void> {
    if (msg.type === "snapshot") {
      await this.applySnapshot(msg);
      // курсор-база (REQ-02.4); не двигаем при отказе по привязке (halted)
      if (!this.halted && msg.cursor !== undefined) this.setCursor(msg.cursor);
      return;
    }
    if (this.halted) return;
    if (msg.type === "ops") {
      // Докачка операций после курсора по порядку (REQ-02.3).
      for (const e of msg.deltas) {
        await this.applyIncoming(e.delta);
        this.setCursor(e.seq);
      }
      return;
    }
    // живая дельта
    await this.applyIncoming(msg.delta);
    if (msg.seq !== undefined) this.setCursor(msg.seq);
  }

  // --- входящие ---

  async applySnapshot(msg: SnapshotMessage): Promise<void> {
    if (!(await this.checkBinding(msg))) return; // отказ по идентичности vault (REQ-01.12)
    this.maxAttachmentBytes = msg.maxAttachmentBytes; // лимит сервера (REQ-03.3)
    // Папки создаём до файлов (родители раньше детей: сортировка по длине пути).
    for (const d of [...msg.dirs].sort((a, b) => a.path.length - b.path.length)) {
      this.hlc.observe(d.hlc);
      const cur = this.dirShadow.get(d.path);
      if (cur && compareHlc(d.hlc, cur.hlc) <= 0) continue;
      this.dirShadow.set(d.path, { hlc: d.hlc, exists: true });
      await this.port.createDir(d.path);
    }
    for (const f of msg.files) {
      this.hlc.observe(f.hlc);
      const cur = this.shadow.get(f.path);
      if (cur && compareHlc(f.hlc, cur.hlc) <= 0) continue;
      this.shadow.set(f.path, { hlc: f.hlc, content: f.content });
      await this.port.write(f.path, f.content);
      this.status(f.path, "synced");
    }
    for (const a of msg.attachments) {
      this.hlc.observe(a.hlc);
      const cur = this.attachShadow.get(a.path);
      if (cur && compareHlc(a.hlc, cur.hlc) <= 0) continue;
      this.attachShadow.set(a.path, { hlc: a.hlc, hash: a.hash });
      await this.ensureLocalAttachment(a.path, a.hash); // докачка blob при отсутствии (REQ-03.5)
      this.status(a.path, "synced");
    }
    for (const t of msg.tombstones) this.hlc.observe(t.hlc);
    await this.reconcileLocal(new Set(msg.tombstones.map((t) => t.path))); // REQ-01.13
  }

  // Сверка при подключении (REQ-01.13): догрузить локальные файлы, которых нет на сервере.
  // Файлы, уже известные серверу (в shadow/attachShadow), и удалённые (tombstone) — пропускаем:
  // первые уже синхронизированы, вторые не воскрешаем. handleLocal* идемпотентны (эхо-защита).
  private async reconcileLocal(tombstoned: Set<string>): Promise<void> {
    if (this.halted) return;
    for (const f of await this.port.list()) {
      if (this.shadow.has(f.path) || tombstoned.has(f.path)) continue;
      await this.handleLocalUpsert(f.path);
    }
    if (this.attachments) {
      for (const p of await this.port.listAttachments()) {
        if (this.attachShadow.has(p) || tombstoned.has(p)) continue;
        await this.handleLocalAttach(p);
      }
    }
  }

  // Гарантирует, что локальный файл по пути содержит байты для hash; докачивает по HTTP,
  // если их нет (REQ-03.5). Если байты уже совпадают — не качает (дедуп при reconnect).
  private async ensureLocalAttachment(path: string, hash: string): Promise<void> {
    if (!this.attachments) return;
    const local = await this.port.readBinary(path);
    if (local && (await sha256Hex(local)) === hash) return;
    const data = await this.attachments.blob.download(hash);
    if (data) await this.port.writeBinary(path, data);
  }

  // Проверка идентичности vault (REQ-01.12). true — продолжать, false — отказ.
  private async checkBinding(msg: SnapshotMessage): Promise<boolean> {
    if (!this.binding || !msg.vaultId) return true; // нет хука/идентичности — старый сервер
    const bound = this.binding.getBound();
    if (bound) {
      if (bound !== msg.vaultId) {
        this.halted = true;
        this.binding.onRefuse("mismatch", msg.vaultId, bound);
        return false;
      }
      return true;
    }
    // привязки ещё нет
    const localEmpty = (await this.port.list()).length === 0;
    const serverEmpty =
      msg.files.length === 0 && msg.dirs.length === 0 && msg.attachments.length === 0;
    if (!localEmpty && !serverEmpty && !this.binding.allowMerge()) {
      this.halted = true;
      this.binding.onRefuse("needConfirm", msg.vaultId, "");
      return false;
    }
    this.binding.bind(msg.vaultId);
    return true;
  }

  async applyIncoming(delta: Delta): Promise<void> {
    if (this.halted) return;
    this.hlc.observe(delta.hlc);

    if (delta.op === "mkdir") {
      const cur = this.dirShadow.get(delta.path);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      this.dirShadow.set(delta.path, { hlc: delta.hlc, exists: true });
      await this.port.createDir(delta.path);
      return;
    }
    if (delta.op === "rmdir") {
      const cur = this.dirShadow.get(delta.path);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      this.dirShadow.set(delta.path, { hlc: delta.hlc, exists: false });
      await this.port.removeDir(delta.path);
      return;
    }
    if (delta.op === "renamedir") {
      const cur = this.dirShadow.get(delta.fromPath);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      this.dirShadow.set(delta.fromPath, { hlc: delta.hlc, exists: false });
      this.dirShadow.set(delta.toPath, { hlc: delta.hlc, exists: true });
      await this.port.moveDir(delta.fromPath, delta.toPath);
      return;
    }
    if (delta.op === "attach") {
      const cur = this.attachShadow.get(delta.path);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return; // LWW (REQ-03.6)
      this.attachShadow.set(delta.path, { hlc: delta.hlc, hash: delta.hash });
      await this.ensureLocalAttachment(delta.path, delta.hash); // докачка (REQ-03.5)
      this.status(delta.path, "synced");
      return;
    }

    // delete/rename для не-.md пути — вложение (его shadow-карта отдельная).
    const isAttachmentTarget =
      (delta.op === "delete" && !isTextSyncedPath(delta.path)) ||
      (delta.op === "rename" && !isTextSyncedPath(delta.fromPath));
    if (isAttachmentTarget) {
      const fromPath = delta.op === "rename" ? delta.fromPath : delta.path;
      const cur = this.attachShadow.get(fromPath);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      if (delta.op === "delete") {
        this.attachShadow.set(delta.path, { hlc: delta.hlc, hash: null });
        await this.port.trash(delta.path); // обратимо (REQ-02.7)
      } else if (delta.op === "rename") {
        this.attachShadow.set(delta.toPath, { hlc: delta.hlc, hash: cur?.hash ?? null });
        this.attachShadow.set(delta.fromPath, { hlc: delta.hlc, hash: null });
        await this.port.rename(delta.fromPath, delta.toPath);
      }
      return;
    }

    const targetPath = delta.op === "rename" ? delta.fromPath : delta.path;
    const cur = this.shadow.get(targetPath);
    if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return; // клиентский LWW

    if (delta.op === "upsert") {
      // Конфликт-копия (REQ-02.8): если локальный файл разошёлся И с last-synced (shadow),
      // И с входящим — это несинхронизированная локальная правка. Не теряем её: кладём
      // рядом как «(conflict …)», затем применяем входящую (LWW-победитель).
      const local = await this.port.read(delta.path);
      if (local !== null && local !== delta.content && local !== (cur?.content ?? null)) {
        await this.port.write(conflictPath(delta.path, delta.hlc), local);
      }
      this.shadow.set(delta.path, { hlc: delta.hlc, content: delta.content });
      await this.port.write(delta.path, delta.content);
      this.status(delta.path, "synced");
    } else if (delta.op === "delete") {
      this.shadow.set(delta.path, { hlc: delta.hlc, content: null });
      await this.port.trash(delta.path); // обратимо (REQ-02.7)
    } else {
      this.shadow.set(delta.toPath, { hlc: delta.hlc, content: cur?.content ?? null });
      this.shadow.set(delta.fromPath, { hlc: delta.hlc, content: null });
      await this.port.rename(delta.fromPath, delta.toPath);
      this.status(delta.toPath, "synced");
    }
  }

  // --- исходящие ---

  async handleLocalUpsert(path: string): Promise<void> {
    if (this.halted) return;
    if (!isTextSyncedPath(path)) return; // REQ-01.9
    const content = await this.port.read(path);
    if (content === null) return;
    const cur = this.shadow.get(path);
    if (cur && cur.content === content) {
      this.status(path, "synced"); // эхо / нет изменений (REQ-01.7) — уже синхронизировано
      return;
    }
    const hlc = this.hlc.next();
    this.shadow.set(path, { hlc, content });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "upsert", path, content, hlc } });
    this.status(path, "synced");
  }

  async handleLocalDelete(path: string): Promise<void> {
    if (this.halted) return;
    if (!isTextSyncedPath(path)) {
      await this.handleLocalAttachDelete(path); // вложение
      return;
    }
    const cur = this.shadow.get(path);
    if (!cur || cur.content === null) return; // уже удалено / неизвестно
    const hlc = this.hlc.next();
    this.shadow.set(path, { hlc, content: null });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path, hlc } });
  }

  async handleLocalRename(from: string, to: string): Promise<void> {
    if (this.halted) return;
    const fromText = isTextSyncedPath(from);
    const toText = isTextSyncedPath(to);
    // текст ↔ вложение: меняется тип сущности — раскладываем на delete старого + создание нового.
    if (fromText && !toText) {
      await this.handleLocalDelete(from); // текст → вложение
      await this.handleLocalAttach(to);
      return;
    }
    if (!fromText && !toText) {
      await this.handleLocalAttachRename(from, to); // вложение → вложение
      return;
    }
    if (!fromText && toText) {
      await this.handleLocalAttachDelete(from); // вложение → текст
      await this.handleLocalUpsert(to);
      return;
    }
    // текст → текст (.md/.canvas)
    const cur = this.shadow.get(from);
    const hlc = this.hlc.next();
    // Сервер знает исходный путь → обычный rename.
    if (cur && cur.content !== null) {
      this.shadow.set(to, { hlc, content: cur.content });
      this.shadow.set(from, { hlc, content: null });
      this.transport.send({
        v: PROTOCOL_VERSION,
        type: "delta",
        delta: { op: "rename", fromPath: from, toPath: to, hlc },
      });
      return;
    }
    // Сервер не знает исходный путь (файл не был засинкан — напр. быстрый
    // create+move в пределах дебаунса, отменивший отложенный upsert): rename
    // применять не к чему, шлём upsert нового пути, иначе файл потеряется.
    const content = await this.port.read(to);
    if (content === null) return;
    this.shadow.set(to, { hlc, content });
    this.transport.send({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "upsert", path: to, content, hlc },
    });
  }

  // --- исходящие: вложения (Spec-03) ---

  async handleLocalAttach(path: string): Promise<void> {
    if (this.halted || !this.attachments || isTextSyncedPath(path)) return;
    const data = await this.port.readBinary(path);
    if (data === null) return;
    const size = data.byteLength;
    // Проверка размера ДО отправки (REQ-03.3): сверх лимита — не шлём, уведомляем.
    if (size > this.maxAttachmentBytes) {
      this.attachments.onOversize?.(path, size, this.maxAttachmentBytes);
      this.status(path, "error");
      return;
    }
    const hash = await sha256Hex(data);
    const cur = this.attachShadow.get(path);
    if (cur && cur.hash === hash) {
      this.status(path, "synced"); // эхо / без изменений (REQ-03.6)
      return;
    }
    // Дедуп (REQ-03.2): заливаем blob только если сервер его ещё не имеет.
    if (!(await this.attachments.blob.has(hash))) {
      const res = await this.attachments.blob.upload(hash, data);
      if (!res.ok) {
        // Сервер отклонил (напр. 413 при рассинхроне лимитов) — не шлём метадельту.
        if (res.status === 413) this.attachments.onOversize?.(path, size, this.maxAttachmentBytes);
        this.status(path, "error");
        return;
      }
    }
    const hlc = this.hlc.next();
    this.attachShadow.set(path, { hlc, hash });
    this.transport.send({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "attach", path, hash, size, hlc },
    });
    this.status(path, "synced");
  }

  async handleLocalAttachDelete(path: string): Promise<void> {
    if (this.halted || !this.attachments) return;
    const cur = this.attachShadow.get(path);
    if (!cur || cur.hash === null) return; // уже удалено / неизвестно
    const hlc = this.hlc.next();
    this.attachShadow.set(path, { hlc, hash: null });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path, hlc } });
  }

  async handleLocalAttachRename(from: string, to: string): Promise<void> {
    if (this.halted || !this.attachments) return;
    const cur = this.attachShadow.get(from);
    if (cur && cur.hash !== null) {
      const hlc = this.hlc.next();
      this.attachShadow.set(to, { hlc, hash: cur.hash });
      this.attachShadow.set(from, { hlc, hash: null });
      this.transport.send({
        v: PROTOCOL_VERSION,
        type: "delta",
        delta: { op: "rename", fromPath: from, toPath: to, hlc },
      });
      return;
    }
    // Сервер не знает исходный путь (вложение не было засинкано) — шлём как новое.
    await this.handleLocalAttach(to);
  }

  // --- исходящие: папки ---

  async handleLocalMkdir(path: string): Promise<void> {
    if (this.halted) return;
    const cur = this.dirShadow.get(path);
    if (cur?.exists) return; // уже существует / эхо применённого mkdir
    const hlc = this.hlc.next();
    this.dirShadow.set(path, { hlc, exists: true });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "mkdir", path, hlc } });
  }

  async handleLocalRmdir(path: string): Promise<void> {
    if (this.halted) return;
    const cur = this.dirShadow.get(path);
    if (cur && !cur.exists) return; // уже удалена / эхо применённого rmdir
    const hlc = this.hlc.next();
    this.dirShadow.set(path, { hlc, exists: false });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "rmdir", path, hlc } });
  }

  async handleLocalRenamedir(from: string, to: string): Promise<void> {
    if (this.halted) return;
    const f = this.dirShadow.get(from);
    const t = this.dirShadow.get(to);
    if (f && !f.exists && t?.exists) return; // эхо применённого renamedir
    const hlc = this.hlc.next();
    this.dirShadow.set(from, { hlc, exists: false });
    this.dirShadow.set(to, { hlc, exists: true });
    this.transport.send({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "renamedir", fromPath: from, toPath: to, hlc },
    });
  }
}
