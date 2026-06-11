export type VaultFile = { path: string; content: string };

export interface VaultPort {
  list(): Promise<VaultFile[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  createDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  moveDir(from: string, to: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  listAttachments(): Promise<string[]>;
  // Слить несохранённый буфер открытого редактора на диск перед перезаписью (AUD-014).
  // Опционально: в тестах/окружениях без редактора не реализуется.
  flushOpenBuffer?(path: string): Promise<void>;
}
