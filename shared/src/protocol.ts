import { z } from "zod";

// Версия конверта протокола. Конверт расширяемый: новые типы сообщений и операций
// добавляются как новые члены discriminated union без слома совместимости (MS01-003 закладка под Spec-03).
export const PROTOCOL_VERSION = 1;

export const HlcSchema = z.string().min(1);

// Текстовые форматы Obsidian, которые синкаются как текст (content в БД + история версий),
// а не как бинарные вложения. Предикат ОБЩИЙ для сервера и плагина — иначе один и тот же
// файл попадёт в files на одной стороне и в attachments на другой. Всё остальное (кроме
// .obsidian/) — бинарное вложение (Spec-03).
// .excalidraw — legacy-формат Excalidraw (чистый JSON); дефолтный .excalidraw.md уже
// покрыт суффиксом .md. Список — явный allowlist: новый текстовый формат = одна строка.
export const TEXT_SYNC_EXTENSIONS = [".md", ".canvas", ".excalidraw"] as const;
export const isTextSyncedPath = (path: string): boolean =>
  TEXT_SYNC_EXTENSIONS.some((ext) => path.endsWith(ext));

// Дельта изменения файла. deviceId на проводе НЕ передаётся — сервер проставляет его
// по идентификатору соединения (нужно для рассылки «всем кроме отправителя» и истории).
export const DeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), path: z.string().min(1), content: z.string(), hlc: HlcSchema }),
  z.object({ op: z.literal("delete"), path: z.string().min(1), hlc: HlcSchema }),
  z.object({
    op: z.literal("rename"),
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    hlc: HlcSchema,
  }),
  // Папки синкаются как сущности: пустая папка должна появиться/исчезнуть на всех
  // устройствах. mkdir — создание папки; rmdir — явное удаление папки (на сервере
  // каскадно удаляет файлы и подпапки под этим путём).
  z.object({ op: z.literal("mkdir"), path: z.string().min(1), hlc: HlcSchema }),
  z.object({ op: z.literal("rmdir"), path: z.string().min(1), hlc: HlcSchema }),
  // Переименование/перемещение папки: префиксный перенос (папка + всё содержимое).
  z.object({
    op: z.literal("renamedir"),
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    hlc: HlcSchema,
  }),
  // Вложение (не-`.md`): метадельта с контент-адресацией (Spec-03, REQ-03.1).
  // Контент (байты) идёт отдельно по HTTP /blob/:hash; здесь только метаданные.
  // Удаление/переименование вложения переиспользуют delete/rename по пути (REQ-03.4).
  z.object({
    op: z.literal("attach"),
    path: z.string().min(1),
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

// Tombstone — путь удалённого файла/вложения (REQ-01.13). Нужен при сверке, чтобы
// устройство не «воскресило» удалённый на другом устройстве файл, догружая локальную копию.
export const SnapshotTombstoneSchema = z.object({
  path: z.string().min(1),
  hlc: HlcSchema,
});
export type SnapshotTombstone = z.infer<typeof SnapshotTombstoneSchema>;

// Лимит размера вложения по умолчанию (Spec-03, REQ-03.3) — 10 МБ.
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Клиент → сервер
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("delta"), delta: DeltaSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Запись журнала операций для докачки (Spec-02): дельта + её позиция seq.
export const OpEntrySchema = z.object({ seq: z.number().int().nonnegative(), delta: DeltaSchema });
export type OpEntry = z.infer<typeof OpEntrySchema>;

// Сервер → клиент
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("snapshot"),
    files: z.array(SnapshotFileSchema),
    // Папки (в т.ч. пустые). default — совместимость со старым сервером без поля.
    dirs: z.array(SnapshotDirSchema).default([]),
    // Вложения (путь, хэш, размер) — REQ-03.5. default — старый сервер без вложений.
    attachments: z.array(SnapshotAttachmentSchema).default([]),
    // Tombstones удалённых файлов/вложений (REQ-01.13) — чтобы сверка не воскрешала их.
    tombstones: z.array(SnapshotTombstoneSchema).default([]),
    // Идентификатор vault — защита от смешивания (REQ-01.12). default — старый сервер.
    vaultId: z.string().default(""),
    // Серверный лимит вложения (REQ-03.3) — клиент сверяет до отправки. default — 10 МБ.
    maxAttachmentBytes: z.number().int().positive().default(DEFAULT_MAX_ATTACHMENT_BYTES),
    // Стартовый курсор = max seq базы (Spec-02, REQ-02.4). optional — старый сервер.
    cursor: z.number().int().nonnegative().optional(),
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("delta"),
    delta: DeltaSchema,
    // Позиция в журнале (REQ-02.5) — клиент двигает курсор. optional — старый сервер.
    seq: z.number().int().nonnegative().optional(),
  }),
  // Пакет докачки операций seq>курсора при подключении (Spec-02, REQ-02.3).
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("ops"),
    deltas: z.array(OpEntrySchema),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;
export type DeltaMessage = Extract<ServerMessage, { type: "delta" }>;
export type OpsMessage = Extract<ServerMessage, { type: "ops" }>;
