// Узкий интерфейс доступа к vault. Реализуется поверх Obsidian Vault API (runtime)
// и поверх fs (e2e в MS01-007). Sync-ядро зависит только от него, а не от Obsidian.
export type VaultFile = { path: string; content: string };

export interface VaultPort {
  list(): Promise<VaultFile[]>; // только .md
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>; // create или modify
  remove(path: string): Promise<void>;
  // Удаление в корзину (обратимо) — для удалений, прилетевших из синка (Spec-02, REQ-02.7).
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  createDir(path: string): Promise<void>; // папка-сущность (в т.ч. пустая)
  removeDir(path: string): Promise<void>; // рекурсивно (папка + содержимое)
  moveDir(from: string, to: string): Promise<void>; // перенос папки + содержимого
  // Вложения (Spec-03): бинарный контент не-.md файлов.
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>; // create или modify
  // Пути всех не-.md файлов (кроме .obsidian/) — для сверки при подключении (REQ-01.13).
  listAttachments(): Promise<string[]>;
}
