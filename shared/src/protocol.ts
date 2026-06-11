import { z } from "zod";

import { PathSchema } from "./path";

export const PROTOCOL_VERSION = 1;

// Верхняя граница текстовой заметки (защита от гигабайтной дельты в SQLite/broadcast).
export const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

// Формат HLC: millis(15):counter(6):node — фиксированная ширина для лексикографического
// сравнения. Regex отсекает poison-HLC (напр. "~"), ломающий LWW и генератор часов.
export const HlcSchema = z.string().regex(/^\d{15}:\d{6}:[A-Za-z0-9_-]{1,64}$/);

export const TEXT_SYNC_EXTENSIONS = [".md", ".canvas", ".excalidraw"] as const;
export const isTextSyncedPath = (path: string): boolean =>
  TEXT_SYNC_EXTENSIONS.some((ext) => path.endsWith(ext));

export const DeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), path: PathSchema, content: z.string().max(MAX_CONTENT_LENGTH), hlc: HlcSchema }),
  z.object({ op: z.literal("delete"), path: PathSchema, hlc: HlcSchema }),
  z.object({
    op: z.literal("rename"),
    fromPath: PathSchema,
    toPath: PathSchema,
    hlc: HlcSchema,
  }),
  z.object({ op: z.literal("mkdir"), path: PathSchema, hlc: HlcSchema }),
  z.object({ op: z.literal("rmdir"), path: PathSchema, hlc: HlcSchema }),
  z.object({
    op: z.literal("renamedir"),
    fromPath: PathSchema,
    toPath: PathSchema,
    hlc: HlcSchema,
  }),
  z.object({
    op: z.literal("attach"),
    path: PathSchema,
    hash: z.string().min(1),
    size: z.number().int().nonnegative(),
    hlc: HlcSchema,
  }),
]);
export type Delta = z.infer<typeof DeltaSchema>;

export const SnapshotFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  hlc: HlcSchema,
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotDirSchema = z.object({
  path: z.string().min(1),
  hlc: HlcSchema,
});
export type SnapshotDir = z.infer<typeof SnapshotDirSchema>;

export const SnapshotAttachmentSchema = z.object({
  path: z.string().min(1),
  hash: z.string().min(1),
  size: z.number().int().nonnegative(),
  hlc: HlcSchema,
});
export type SnapshotAttachment = z.infer<typeof SnapshotAttachmentSchema>;

export const SnapshotTombstoneSchema = z.object({
  path: z.string().min(1),
  hlc: HlcSchema,
});
export type SnapshotTombstone = z.infer<typeof SnapshotTombstoneSchema>;

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Жёсткий клиентский потолок: серверный maxAttachmentBytes приходит от того же
// (возможно злонамеренного) сервера, поэтому эффективный лимит = min(server, HARD_CAP).
export const MAX_ATTACHMENT_HARD_CAP = 100 * 1024 * 1024;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("delta"), delta: DeltaSchema }),
  // AUD-023: токен — первым auth-сообщением на чистый /sync, не в query (не утекает в
  // логи прокси/истории URL). До успешной auth сервер не шлёт snapshot/ops и не принимает
  // delta. Браузерный WS не может слать заголовки на upgrade → auth ранним сообщением.
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("auth"),
    token: z.string().min(1).max(512),
    device: z.string().min(1).max(256),
    cursor: z.number().int().nonnegative().default(0),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type AuthMessage = Extract<ClientMessage, { type: "auth" }>;

export const OpEntrySchema = z.object({ seq: z.number().int().nonnegative(), delta: DeltaSchema });
export type OpEntry = z.infer<typeof OpEntrySchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("snapshot"),
    files: z.array(SnapshotFileSchema),
    dirs: z.array(SnapshotDirSchema).default([]),
    attachments: z.array(SnapshotAttachmentSchema).default([]),
    tombstones: z.array(SnapshotTombstoneSchema).default([]),
    vaultId: z.string().min(1),
    maxAttachmentBytes: z.number().int().positive().default(DEFAULT_MAX_ATTACHMENT_BYTES),
    cursor: z.number().int().nonnegative().optional(),
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("delta"),
    delta: DeltaSchema,
    seq: z.number().int().nonnegative().optional(),
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("ops"),
    vaultId: z.string().min(1),
    maxAttachmentBytes: z.number().int().positive().default(DEFAULT_MAX_ATTACHMENT_BYTES),
    deltas: z.array(OpEntrySchema),
  }),
  // Подтверждение применённой/идемпотентно-отклонённой дельты отправителю (ключ — hlc):
  // позволяет переотправить неподтверждённые дельты при reconnect (умирающий сокет).
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("ack"),
    hlc: HlcSchema,
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;
export type DeltaMessage = Extract<ServerMessage, { type: "delta" }>;
export type OpsMessage = Extract<ServerMessage, { type: "ops" }>;
