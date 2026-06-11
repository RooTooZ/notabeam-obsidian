import {
  compareHlc,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  isSyncablePath,
  isTextSyncedPath,
  MAX_ATTACHMENT_HARD_CAP,
  normalizePath,
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

// content хранится как sha256(content), а не сырой текст: компактно для персиста
// (data.json), и сравнения конфликт-копий идут по хэшу.
export type ShadowEntry = { hlc: string; hash: string | null };
type DirEntry = { hlc: string; exists: boolean };
type AttachEntry = { hlc: string; hash: string | null };

const textHash = (s: string): Promise<string> => sha256Hex(new TextEncoder().encode(s));

// Защита границы доверия: входящая дельта от сервера не должна писать вне vault
// или в `.obsidian/` (= RCE). Проверяем оба конца rename/renamedir.
const deltaPathSafe = (delta: Delta): boolean => {
  if (delta.op === "rename" || delta.op === "renamedir") {
    return isSyncablePath(delta.fromPath) && isSyncablePath(delta.toPath);
  }
  return isSyncablePath(delta.path);
};

const conflictPath = (path: string, hlc: string): string => {
  const tag = ` (conflict ${hlc.replace(/[:.]/g, "-")})`;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) + tag + path.slice(dot) : path + tag;
};

export interface AttachmentDeps {
  blob: BlobClient;
  onOversize?(path: string, size: number, maxBytes: number): void;
}

export type FileSyncState = "pending" | "synced" | "error";
export type FileStatusSink = (path: string, state: FileSyncState) => void;

export interface CursorStore {
  load(): number;
  save(seq: number): void;
}

// Персистентный shadow файлов (path → {hlc, hash}). Переживает рестарт, чтобы при
// старте не пере-апсертить весь vault со свежими HLC (AUD-003: клоббер чужих правок)
// и распознать офлайн-правки (AUD-009). Только файлы (текст) — носитель риска потери
// данных; вложения content-addressed, каталоги идемпотентны.
export interface ShadowStore {
  load(): Record<string, ShadowEntry> | undefined;
  setFile(path: string, entry: ShadowEntry): void;
  deleteFile(path: string): void;
}

export interface BindingHooks {
  getBound(): string;
  bind(vaultId: string): void;
  allowMerge(): boolean;
  onRefuse(reason: "mismatch" | "needConfirm" | "invalid", serverVaultId: string, bound: string): void;
}

export class SyncEngine {
  private shadow = new Map<string, ShadowEntry>();
  private dirShadow = new Map<string, DirEntry>();
  private attachShadow = new Map<string, AttachEntry>();
  private halted = false;
  private maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES;
  // Привязка vault подтверждена в рамках текущего соединения (через snapshot/ops с vaultId).
  // До подтверждения не применяем live-дельты (не несут vaultId) — защита от чужого сервера.
  private connectionVerified = false;
  // FIFO-очередь обработки входящих: гарантирует строгий порядок (без реордера записей
  // по одному пути) и непрерывное продвижение курсора.
  private chain: Promise<void> = Promise.resolve();
  // Стартовая сверка локального состояния с сервером выполняется один раз за соединение
  // (на snapshot- или ops-пути) — чтобы офлайн-правки залились, а неизменённое — нет.
  private startupReconcileDone = false;

  private cursor = 0;

  constructor(
    private readonly port: VaultPort,
    private readonly transport: Transport,
    private readonly hlc: HlcGen,
    private readonly binding?: BindingHooks,
    private readonly attachments?: AttachmentDeps,
    private readonly statusSink?: FileStatusSink,
    private readonly cursorStore?: CursorStore,
    private readonly shadowStore?: ShadowStore,
  ) {}

  // Единственная точка мутации файлового shadow: держит in-memory карту и персист
  // синхронными. Удаление не персистим (tombstone не нужен на рестарте: офлайн-возврат
  // файла даст cur=undefined → корректный апсерт), чтобы data.json не рос вечно.
  private setShadow(path: string, entry: ShadowEntry): void {
    this.shadow.set(path, entry);
    if (entry.hash === null) this.shadowStore?.deleteFile(path);
    else this.shadowStore?.setFile(path, entry);
  }

  private setCursor(seq: number): void {
    if (seq <= this.cursor) return;
    this.cursor = seq;
    this.cursorStore?.save(seq);
  }

  // snapshot-путь: допускает понижение курсора (сервер восстановлен из бэкапа, AUD-015),
  // в отличие от монотонного ops-пути (владелец контракта setCursor — MS11-006).
  private setCursorFromSnapshot(seq: number): void {
    this.cursor = seq;
    this.cursorStore?.save(seq);
  }

  private status(path: string, state: FileSyncState): void {
    this.statusSink?.(path, state);
  }

  markPending(path: string): void {
    if (this.halted) return;
    this.status(path, "pending");
  }

  start(): void {
    this.cursor = this.cursorStore?.load() ?? 0;
    const persisted = this.shadowStore?.load();
    if (persisted) for (const [p, e] of Object.entries(persisted)) this.shadow.set(p, e);
    this.transport.onMessage((msg) => {
      this.chain = this.chain.then(() => this.onServerMessage(msg)).catch(() => undefined);
    });
    // connectionVerified стартует false у свежего движка (защита привязки при смене
    // сервера/токена через restartSync). Внутрисессионный ws-реконнект — к тому же
    // серверу, поэтому сбрасывать флаг на onOpen не нужно (и нельзя — onOpen у транспорта
    // единственный, его использует обвязка).
    this.transport.connect();
  }

  stop(): void {
    this.halted = true; // прекращаем применение in-flight сообщений старого движка
    this.transport.close();
  }

  // Тест-шов: резолвится, когда текущая FIFO-очередь входящих отработана.
  async whenIdle(): Promise<void> {
    await this.chain;
  }

  private async onServerMessage(msg: ServerMessage): Promise<void> {
    if (msg.type === "ack") return; // ack обрабатывается на уровне транспорта
    if (msg.type === "snapshot") {
      await this.applySnapshot(msg);
      if (!this.halted) {
        this.connectionVerified = true;
        if (msg.cursor !== undefined) this.setCursorFromSnapshot(msg.cursor);
      }
      return;
    }
    if (this.halted) return;
    if (msg.type === "ops") {
      if (!this.verifyVaultId(msg.vaultId)) return;
      this.connectionVerified = true;
      this.maxAttachmentBytes = Math.min(msg.maxAttachmentBytes, MAX_ATTACHMENT_HARD_CAP);
      for (const e of msg.deltas) {
        try {
          await this.applyIncoming(e.delta);
        } catch {
          return; // не продвигать курсор за упавший seq — докачается при reconnect
        }
        this.setCursor(e.seq);
      }
      if (!this.startupReconcileDone) await this.reconcileFiles();
      return;
    }
    // live-дельта не несёт vaultId — при сконфигурированном binding применяем
    // только после верификации привязки (snapshot/ops) в этом соединении
    if (this.binding && !this.connectionVerified) return;
    await this.applyIncoming(msg.delta);
    if (msg.seq !== undefined) this.setCursor(msg.seq);
  }

  // Проверка привязки для ops-пути (snapshot проверяется в checkBinding).
  private verifyVaultId(vaultId: string): boolean {
    if (!this.binding) return true;
    if (!vaultId) {
      this.halted = true;
      this.binding.onRefuse("invalid", "", this.binding.getBound());
      return false;
    }
    const bound = this.binding.getBound();
    if (bound && bound !== vaultId) {
      this.halted = true;
      this.binding.onRefuse("mismatch", vaultId, bound);
      return false;
    }
    if (!bound) this.binding.bind(vaultId);
    return true;
  }

  async applySnapshot(msg: SnapshotMessage): Promise<void> {
    if (this.halted) return;
    if (!(await this.checkBinding(msg))) return;
    // эффективный лимит = min(серверный, жёсткий клиентский потолок) — защита от
    // злонамеренного сервера, объявляющего огромный лимит (AUD-039)
    this.maxAttachmentBytes = Math.min(msg.maxAttachmentBytes, MAX_ATTACHMENT_HARD_CAP);
    for (const d of [...msg.dirs].sort((a, b) => a.path.length - b.path.length)) {
      const path = normalizePath(d.path);
      if (!isSyncablePath(path)) continue; // поэлементно: один плохой путь не рушит весь снапшот
      this.hlc.observe(d.hlc);
      const cur = this.dirShadow.get(path);
      if (cur && compareHlc(d.hlc, cur.hlc) <= 0) continue;
      this.dirShadow.set(path, { hlc: d.hlc, exists: true });
      await this.port.createDir(path);
    }
    for (const f of msg.files) {
      const path = normalizePath(f.path);
      if (!isSyncablePath(path)) continue;
      this.hlc.observe(f.hlc);
      const cur = this.shadow.get(path);
      if (cur && compareHlc(f.hlc, cur.hlc) <= 0) continue;
      await this.port.flushOpenBuffer?.(path); // AUD-014: сбросить буфер редактора
      const incomingHash = await textHash(f.content);
      // AUD-011: на snapshot-пути локальная правка тоже не теряется молча
      await this.maybeConflictCopy(path, incomingHash, f.hlc, cur?.hash ?? null);
      await this.port.write(path, f.content);
      this.setShadow(path, { hlc: f.hlc, hash: incomingHash });
      this.status(path, "synced");
    }
    for (const a of msg.attachments) {
      const path = normalizePath(a.path);
      if (!isSyncablePath(path)) continue;
      this.hlc.observe(a.hlc);
      const cur = this.attachShadow.get(path);
      if (cur && compareHlc(a.hlc, cur.hlc) <= 0) continue;
      if (await this.ensureLocalAttachment(path, a.hash)) {
        this.attachShadow.set(path, { hlc: a.hlc, hash: a.hash });
        this.status(path, "synced");
      } else {
        this.status(path, "error");
      }
    }
    const tombstoned = new Set<string>();
    for (const t of msg.tombstones) {
      const path = normalizePath(t.path);
      if (!isSyncablePath(path)) continue;
      this.hlc.observe(t.hlc);
      tombstoned.add(path);
    }
    await this.reconcileLocal(tombstoned);
  }

  private async reconcileLocal(tombstoned: Set<string>): Promise<void> {
    if (this.halted) return;
    this.startupReconcileDone = true;
    // handleLocalUpsert сам сверяет hash — неизменённый файл не шлёт апсерт (AUD-003),
    // изменённый офлайн — заливает (AUD-009). Поэтому не пропускаем уже известные пути.
    for (const f of await this.port.list()) {
      if (tombstoned.has(f.path)) continue;
      await this.handleLocalUpsert(f.path);
    }
    if (this.attachments) {
      for (const p of await this.port.listAttachments()) {
        if (this.attachShadow.has(p) || tombstoned.has(p)) continue;
        await this.handleLocalAttach(p);
      }
    }
  }

  // ops-путь не несёт snapshot и не запускает полную сверку — но persisted shadow мог
  // разойтись с диском (офлайн-правки), поэтому одноразово сверяем файлы (AUD-009).
  private async reconcileFiles(): Promise<void> {
    if (this.halted) return;
    this.startupReconcileDone = true;
    for (const f of await this.port.list()) await this.handleLocalUpsert(f.path);
  }

  private async ensureLocalAttachment(path: string, hash: string): Promise<boolean> {
    if (!this.attachments) return true;
    const local = await this.port.readBinary(path);
    if (local && (await sha256Hex(local)) === hash) return true;
    const data = await this.attachments.blob.download(hash);
    if (!data) return false; // download/sha256 не прошёл — shadow не отравляем, повтор при следующем snapshot
    if (data.byteLength > this.maxAttachmentBytes) {
      this.attachments.onOversize?.(path, data.byteLength, this.maxAttachmentBytes);
      return false;
    }
    await this.port.writeBinary(path, data);
    return true;
  }

  private async checkBinding(msg: SnapshotMessage): Promise<boolean> {
    if (!this.binding) return true;
    if (!msg.vaultId) {
      this.halted = true;
      this.binding.onRefuse("invalid", "", this.binding.getBound());
      return false;
    }
    const bound = this.binding.getBound();
    if (bound) {
      if (bound !== msg.vaultId) {
        this.halted = true;
        this.binding.onRefuse("mismatch", msg.vaultId, bound);
        return false;
      }
      return true;
    }
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

  // Сохраняет расходящееся локальное содержимое рядом как конфликт-копию ПЕРЕД
  // перезаписью (REQ-02.8). Общий метод для applyIncoming и applySnapshot.
  // Сравнение по хэшу: локальное расходится и с входящим, и с последним известным.
  private async maybeConflictCopy(
    path: string,
    incomingHash: string,
    hlc: string,
    knownHash: string | null,
  ): Promise<void> {
    const local = await this.port.read(path);
    if (local === null) return;
    const localHash = await textHash(local);
    if (localHash !== incomingHash && localHash !== knownHash) {
      await this.port.write(conflictPath(path, hlc), local);
    }
  }

  async applyIncoming(delta: Delta): Promise<void> {
    if (this.halted) return;
    if (!deltaPathSafe(delta)) return; // defense-in-depth: не доверяем серверу/чужому клиенту
    if (delta.op === "upsert" && !isTextSyncedPath(delta.path)) return; // бинарный путь — не текст
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
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      if (await this.ensureLocalAttachment(delta.path, delta.hash)) {
        this.attachShadow.set(delta.path, { hlc: delta.hlc, hash: delta.hash });
        this.status(delta.path, "synced");
      } else {
        this.status(delta.path, "error");
      }
      return;
    }

    const isAttachmentTarget =
      (delta.op === "delete" && !isTextSyncedPath(delta.path)) ||
      (delta.op === "rename" && !isTextSyncedPath(delta.fromPath));
    if (isAttachmentTarget) {
      const fromPath = delta.op === "rename" ? delta.fromPath : delta.path;
      const cur = this.attachShadow.get(fromPath);
      if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;
      if (delta.op === "delete") {
        this.attachShadow.set(delta.path, { hlc: delta.hlc, hash: null });
        await this.port.trash(delta.path);
      } else if (delta.op === "rename") {
        this.attachShadow.set(delta.toPath, { hlc: delta.hlc, hash: cur?.hash ?? null });
        this.attachShadow.set(delta.fromPath, { hlc: delta.hlc, hash: null });
        await this.port.rename(delta.fromPath, delta.toPath);
      }
      return;
    }

    const targetPath = delta.op === "rename" ? delta.fromPath : delta.path;
    const cur = this.shadow.get(targetPath);
    if (cur && compareHlc(delta.hlc, cur.hlc) <= 0) return;

    if (delta.op === "upsert") {
      // AUD-014: слить несохранённый буфер открытого редактора на диск ДО перезаписи —
      // тогда maybeConflictCopy увидит правку пользователя и сохранит её конфликт-копией.
      await this.port.flushOpenBuffer?.(delta.path);
      const incomingHash = await textHash(delta.content);
      await this.maybeConflictCopy(delta.path, incomingHash, delta.hlc, cur?.hash ?? null);
      await this.port.write(delta.path, delta.content);
      this.setShadow(delta.path, { hlc: delta.hlc, hash: incomingHash });
      this.status(delta.path, "synced");
    } else if (delta.op === "delete") {
      await this.port.trash(delta.path);
      this.setShadow(delta.path, { hlc: delta.hlc, hash: null });
    } else {
      await this.port.rename(delta.fromPath, delta.toPath);
      this.setShadow(delta.toPath, { hlc: delta.hlc, hash: cur?.hash ?? null });
      this.setShadow(delta.fromPath, { hlc: delta.hlc, hash: null });
      this.status(delta.toPath, "synced");
    }
  }

  async handleLocalUpsert(path: string): Promise<void> {
    if (this.halted) return;
    if (!isTextSyncedPath(path)) return;
    const content = await this.port.read(path);
    if (content === null) return;
    const hash = await textHash(content);
    const cur = this.shadow.get(path);
    if (cur && cur.hash === hash) {
      this.status(path, "synced");
      return;
    }
    const hlc = this.hlc.next();
    this.setShadow(path, { hlc, hash });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "upsert", path, content, hlc } });
    this.status(path, "synced");
  }

  async handleLocalDelete(path: string): Promise<void> {
    if (this.halted) return;
    if (!isTextSyncedPath(path)) {
      await this.handleLocalAttachDelete(path);
      return;
    }
    const cur = this.shadow.get(path);
    if (!cur || cur.hash === null) return;
    const hlc = this.hlc.next();
    this.setShadow(path, { hlc, hash: null });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "delete", path, hlc } });
  }

  async handleLocalRename(from: string, to: string): Promise<void> {
    if (this.halted) return;
    const fromText = isTextSyncedPath(from);
    const toText = isTextSyncedPath(to);
    if (fromText && !toText) {
      await this.handleLocalDelete(from);
      await this.handleLocalAttach(to);
      return;
    }
    if (!fromText && !toText) {
      await this.handleLocalAttachRename(from, to);
      return;
    }
    if (!fromText && toText) {
      await this.handleLocalAttachDelete(from);
      await this.handleLocalUpsert(to);
      return;
    }
    const cur = this.shadow.get(from);
    const hlc = this.hlc.next();
    if (cur && cur.hash !== null) {
      this.setShadow(to, { hlc, hash: cur.hash });
      this.setShadow(from, { hlc, hash: null });
      this.transport.send({
        v: PROTOCOL_VERSION,
        type: "delta",
        delta: { op: "rename", fromPath: from, toPath: to, hlc },
      });
      return;
    }
    const content = await this.port.read(to);
    if (content === null) return;
    this.setShadow(to, { hlc, hash: await textHash(content) });
    this.transport.send({
      v: PROTOCOL_VERSION,
      type: "delta",
      delta: { op: "upsert", path: to, content, hlc },
    });
  }

  async handleLocalAttach(path: string): Promise<void> {
    if (this.halted || !this.attachments || isTextSyncedPath(path)) return;
    const data = await this.port.readBinary(path);
    if (data === null) return;
    const size = data.byteLength;
    if (size > this.maxAttachmentBytes) {
      this.attachments.onOversize?.(path, size, this.maxAttachmentBytes);
      this.status(path, "error");
      return;
    }
    const hash = await sha256Hex(data);
    const cur = this.attachShadow.get(path);
    if (cur && cur.hash === hash) {
      this.status(path, "synced");
      return;
    }
    try {
      if (!(await this.attachments.blob.has(hash))) {
        const res = await this.attachments.blob.upload(hash, data);
        if (!res.ok) {
          if (res.status === 413) this.attachments.onOversize?.(path, size, this.maxAttachmentBytes);
          this.status(path, "error");
          return;
        }
      }
    } catch {
      this.status(path, "error"); // офлайн/сеть — не роняем процесс; повтор при следующем редактировании
      return;
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
    if (!cur || cur.hash === null) return;
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
    await this.handleLocalAttach(to);
  }

  async handleLocalMkdir(path: string): Promise<void> {
    if (this.halted) return;
    const cur = this.dirShadow.get(path);
    if (cur?.exists) return;
    const hlc = this.hlc.next();
    this.dirShadow.set(path, { hlc, exists: true });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "mkdir", path, hlc } });
  }

  async handleLocalRmdir(path: string): Promise<void> {
    if (this.halted) return;
    const cur = this.dirShadow.get(path);
    if (cur && !cur.exists) return;
    const hlc = this.hlc.next();
    this.dirShadow.set(path, { hlc, exists: false });
    this.transport.send({ v: PROTOCOL_VERSION, type: "delta", delta: { op: "rmdir", path, hlc } });
  }

  async handleLocalRenamedir(from: string, to: string): Promise<void> {
    if (this.halted) return;
    const f = this.dirShadow.get(from);
    const t = this.dirShadow.get(to);
    if (f && !f.exists && t?.exists) return;
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
