import { isTextSyncedPath } from "@notabeam/shared";

import type { SyncEngine } from "./sync-engine";

// Каталог конфигурации Obsidian не синхронизируется (Spec-03, REQ-03.1).
const isExcluded = (path: string): boolean => path === ".obsidian" || path.startsWith(".obsidian/");

// Наблюдатель локальных изменений vault. Дебаунсит upsert (коалесцирует всплеск
// сохранений), delete/rename отправляет сразу, отменяя ожидающий upsert по пути.
// .md → текст (handleLocalUpsert), прочее → вложение (handleLocalAttach); маршрутизацию
// delete/rename выполняет сам движок по расширению пути.
export class VaultWatcher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(
    private readonly engine: SyncEngine,
    options: { debounceMs?: number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1500;
  }

  onUpsert(path: string): void {
    if (isExcluded(path)) return;
    this.cancel(path);
    this.engine.markPending(path); // мгновенный индикатор «ожидает» (Spec-09)
    const timer = setTimeout(() => {
      this.timers.delete(path);
      if (isTextSyncedPath(path)) void this.engine.handleLocalUpsert(path);
      else void this.engine.handleLocalAttach(path);
    }, this.debounceMs);
    this.timers.set(path, timer);
  }

  onDelete(path: string): void {
    if (isExcluded(path)) return;
    this.cancel(path);
    void this.engine.handleLocalDelete(path);
  }

  onRename(from: string, to: string): void {
    if (isExcluded(to)) return; // цель в .obsidian — не синкаем
    this.cancel(from);
    void this.engine.handleLocalRename(from, to);
  }

  onMkdir(path: string): void {
    void this.engine.handleLocalMkdir(path);
  }

  onRmdir(path: string): void {
    this.cancel(path);
    void this.engine.handleLocalRmdir(path);
  }

  onRenamedir(from: string, to: string): void {
    void this.engine.handleLocalRenamedir(from, to);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private cancel(path: string): void {
    const timer = this.timers.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(path);
    }
  }
}
