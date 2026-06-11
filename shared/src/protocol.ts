import { z } from "zod";

import { PathSchema } from "./path";

export const PROTOCOL_VERSION = 1;

export const HlcSchema = z.string().min(1);

export const TEXT_SYNC_EXTENSIONS = [".md", ".canvas", ".excalidraw"] as const;
export const isTextSyncedPath = (path: string): boolean =>
  TEXT_SYNC_EXTENSIONS.some((ext) => path.endsWith(ext));

export const DeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), path: PathSchema, content: z.string(), hlc: HlcSchema }),
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

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("delta"), delta: DeltaSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

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
    deltas: z.array(OpEntrySchema),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;
export type DeltaMessage = Extract<ServerMessage, { type: "delta" }>;
export type OpsMessage = Extract<ServerMessage, { type: "ops" }>;
