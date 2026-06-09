import { isTextSyncedPath } from "@notabeam/shared";

import type { SyncEngine } from "./sync-engine";

const isExcluded = (path: string): boolean => path === ".obsidian" || path.startsWith(".obsidian/");

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
    this.engine.markPending(path);
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
    if (isExcluded(to)) return;
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
