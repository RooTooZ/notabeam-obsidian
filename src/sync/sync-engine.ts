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

type ShadowEntry = { hlc: string; content: string | null };
type DirEntry = { hlc: string; exists: boolean };
type AttachEntry = { hlc: string; hash: string | null };

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

  private cursor = 0;

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

  private async onServerMessage(msg: ServerMessage): Promise<void> {
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
      for (const e of msg.deltas) {
        try {
          await this.applyIncoming(e.delta);
        } catch {
          return; // не продвигать курсор за упавший seq — докачается при reconnect
        }
        this.setCursor(e.seq);
      }
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
      this.shadow.set(path, { hlc: f.hlc, content: f.content });
      await this.port.write(path, f.content);
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

  async applyIncoming(delta: Delta): Promise<void> {
    if (this.halted) return;
    if (!deltaPathSafe(delta)) return; // defense-in-depth: не доверяем серверу/чужому клиенту
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
      const local = await this.port.read(delta.path);
      if (local !== null && local !== delta.content && local !== (cur?.content ?? null)) {
        await this.port.write(conflictPath(delta.path, delta.hlc), local);
      }
      await this.port.write(delta.path, delta.content);
      this.shadow.set(delta.path, { hlc: delta.hlc, content: delta.content });
      this.status(delta.path, "synced");
    } else if (delta.op === "delete") {
      await this.port.trash(delta.path);
      this.shadow.set(delta.path, { hlc: delta.hlc, content: null });
    } else {
      await this.port.rename(delta.fromPath, delta.toPath);
      this.shadow.set(delta.toPath, { hlc: delta.hlc, content: cur?.content ?? null });
      this.shadow.set(delta.fromPath, { hlc: delta.hlc, content: null });
      this.status(delta.toPath, "synced");
    }
  }

  async handleLocalUpsert(path: string): Promise<void> {
    if (this.halted) return;
    if (!isTextSyncedPath(path)) return;
    const content = await this.port.read(path);
    if (content === null) return;
    const cur = this.shadow.get(path);
    if (cur && cur.content === content) {
      this.status(path, "synced");
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
      await this.handleLocalAttachDelete(path);
      return;
    }
    const cur = this.shadow.get(path);
    if (!cur || cur.content === null) return;
    const hlc = this.hlc.next();
    this.shadow.set(path, { hlc, content: null });
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
    const content = await this.port.read(to);
    if (content === null) return;
    this.shadow.set(to, { hlc, content });
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
