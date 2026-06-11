import { isSyncablePath, isTextSyncedPath } from "@notabeam/shared";
import { TFile, TFolder, type Vault } from "obsidian";

import type { VaultFile, VaultPort } from "./vault-port";

// Минимальная структурная форма того, что нужно для сброса буфера редактора (AUD-014) —
// чтобы не тянуть и не мокать весь Workspace/MarkdownView. view сужаем в рантайме.
type WorkspaceLike = { getLeavesOfType(type: string): { view: unknown }[] };
type FlushableView = { file?: { path: string } | null; save?: () => Promise<void> };

export class ObsidianVault implements VaultPort {
  constructor(
    private readonly vault: Vault,
    private readonly workspace?: WorkspaceLike,
  ) {}

  // Перед перезаписью входящей дельтой принудительно сохраняем открытый редактор этого
  // файла: иначе vault.modify затрёт несохранённый буфер пользователя без следа (AUD-014).
  // Best-effort: ошибки сохранения не должны срывать применение дельты.
  async flushOpenBuffer(path: string): Promise<void> {
    if (!this.workspace) return;
    for (const leaf of this.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as FlushableView;
      if (view?.file?.path === path && typeof view.save === "function") {
        await view.save().catch(() => undefined);
      }
    }
  }

  async list(): Promise<VaultFile[]> {
    const files = this.vault
      .getFiles()
      .filter((f) => isTextSyncedPath(f.path) && isSyncablePath(f.path));
    const out: VaultFile[] = [];
    for (const f of files) {
      out.push({ path: f.path, content: await this.vault.read(f) });
    }
    return out;
  }

  async read(path: string): Promise<string | null> {
    const f = this.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? this.vault.read(f) : null;
  }

  async write(path: string, content: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, content);
      return;
    }
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && this.vault.getAbstractFileByPath(dir) === null) {
      await this.vault.createFolder(dir).catch(() => undefined);
    }
    await this.vault.create(path, content);
  }

  async remove(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(path);
    if (f !== null) await this.vault.delete(f);
  }

  async trash(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(path);
    if (f !== null) await this.vault.trash(f, false);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(from);
    if (f === null) return;
    const dir = to.split("/").slice(0, -1).join("/");
    if (dir && this.vault.getAbstractFileByPath(dir) === null) {
      await this.vault.createFolder(dir).catch(() => undefined);
    }
    // Целевой путь может быть локально занят: не роняем процесс (полноценная
    // конфликт-копия для занятого пути — MS11-009).
    await this.vault.rename(f, to).catch(() => undefined);
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(path) !== null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const f = this.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? this.vault.readBinary(f) : null;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, data);
      return;
    }
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && this.vault.getAbstractFileByPath(dir) === null) {
      await this.vault.createFolder(dir).catch(() => undefined);
    }
    await this.vault.createBinary(path, data);
  }

  async listAttachments(): Promise<string[]> {
    return this.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => !isTextSyncedPath(p) && isSyncablePath(p));
  }

  async createDir(path: string): Promise<void> {
    if (this.vault.getAbstractFileByPath(path) === null) {
      await this.vault.createFolder(path).catch(() => undefined);
    }
  }

  async removeDir(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(path);
    if (f === null) return;
    // в корзину (.trash) одним вызовом — обратимо (REQ-02.7), а не vault.delete(force) навсегда
    await this.vault.trash(f, false);
  }

  async moveDir(from: string, to: string): Promise<void> {
    const src = this.vault.getAbstractFileByPath(from);
    if (!(src instanceof TFolder)) return;
    const dst = this.vault.getAbstractFileByPath(to);
    if (dst instanceof TFolder) {
      for (const child of [...src.children]) {
        const target = `${to}/${child.name}`;
        if (child instanceof TFolder) await this.moveDir(child.path, target);
        else await this.vault.rename(child, target).catch(() => undefined);
      }
      const left = this.vault.getAbstractFileByPath(from);
      // удаляем исходную папку ТОЛЬКО если пуста — непереносимые (коллизия имён) дети
      // остаются на месте, не теряются; удаление — в корзину, не навсегда
      if (left instanceof TFolder && left.children.length === 0) {
        await this.vault.trash(left, false).catch(() => undefined);
      }
      return;
    }
    const parent = to.split("/").slice(0, -1).join("/");
    if (parent && this.vault.getAbstractFileByPath(parent) === null) {
      await this.vault.createFolder(parent).catch(() => undefined);
    }
    await this.vault.rename(src, to).catch(() => undefined);
  }
}
