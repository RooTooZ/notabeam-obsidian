import { isTextSyncedPath } from "@notabeam/shared";
import { TFile, TFolder, type Vault } from "obsidian";

import type { VaultFile, VaultPort } from "./vault-port";

// Реализация VaultPort поверх Obsidian Vault API (только кроссплатформенные методы).
export class ObsidianVault implements VaultPort {
  constructor(private readonly vault: Vault) {}

  // Текстовые файлы (.md/.canvas), кроме .obsidian/ — синкаются как текст.
  async list(): Promise<VaultFile[]> {
    const files = this.vault
      .getFiles()
      .filter((f) => isTextSyncedPath(f.path) && !f.path.startsWith(".obsidian/"));
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

  // Удаление в корзину Obsidian (.trash) — обратимо (REQ-02.7). system=false → vault .trash.
  async trash(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(path);
    if (f !== null) await this.vault.trash(f, false);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(from);
    if (f === null) return;
    // целевой папки может не быть на этом устройстве (пустые папки не синкаются) —
    // создаём, иначе vault.rename упадёт и файл «застрянет» на старом пути.
    const dir = to.split("/").slice(0, -1).join("/");
    if (dir && this.vault.getAbstractFileByPath(dir) === null) {
      await this.vault.createFolder(dir).catch(() => undefined);
    }
    await this.vault.rename(f, to);
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
    // Все файлы vault, кроме текстовых (.md/.canvas) и каталога конфигурации .obsidian/.
    return this.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => !isTextSyncedPath(p) && p !== ".obsidian" && !p.startsWith(".obsidian/"));
  }

  async createDir(path: string): Promise<void> {
    if (this.vault.getAbstractFileByPath(path) === null) {
      await this.vault.createFolder(path).catch(() => undefined);
    }
  }

  async removeDir(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(path);
    if (f === null) return;
    if (!(f instanceof TFolder)) {
      await this.vault.delete(f, true);
      return;
    }
    // Рекурсивно: сначала содержимое, потом саму папку (vault.delete не каскадит
    // непустую папку надёжно на всех платформах).
    for (const child of [...f.children]) {
      if (child instanceof TFolder) await this.removeDir(child.path);
      else await this.vault.delete(child, true);
    }
    await this.vault.delete(f, true);
  }

  async moveDir(from: string, to: string): Promise<void> {
    const src = this.vault.getAbstractFileByPath(from);
    if (!(src instanceof TFolder)) return; // уже переехала (через детские rename) или нет
    const dst = this.vault.getAbstractFileByPath(to);
    if (dst instanceof TFolder) {
      // Целевая уже есть (гонка с file-rename детей) — сливаем: переносим детей и
      // удаляем опустевшую исходную папку.
      for (const child of [...src.children]) {
        const target = `${to}/${child.name}`;
        if (child instanceof TFolder) await this.moveDir(child.path, target);
        else await this.vault.rename(child, target).catch(() => undefined);
      }
      const left = this.vault.getAbstractFileByPath(from);
      if (left !== null) await this.vault.delete(left, true).catch(() => undefined);
      return;
    }
    const parent = to.split("/").slice(0, -1).join("/");
    if (parent && this.vault.getAbstractFileByPath(parent) === null) {
      await this.vault.createFolder(parent).catch(() => undefined);
    }
    await this.vault.rename(src, to);
  }
}
