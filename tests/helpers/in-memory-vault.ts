import { isTextSyncedPath } from "@notabeam/shared";

import type { VaultFile, VaultPort } from "@/sync/vault-port";

export class InMemoryVault implements VaultPort {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  async list(): Promise<VaultFile[]> {
    return [...this.files.entries()]
      .filter(([path]) => isTextSyncedPath(path))
      .map(([path, content]) => ({ path, content }));
  }

  async read(path: string): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.binaries.delete(path);
  }

  async trash(path: string): Promise<void> {
    await this.remove(path); // корзина не моделируется в тестах
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from) as string);
      this.files.delete(from);
    }
    if (this.binaries.has(from)) {
      this.binaries.set(to, this.binaries.get(from) as ArrayBuffer);
      this.binaries.delete(from);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaries.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.binaries.has(path) ? (this.binaries.get(path) as ArrayBuffer) : null;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaries.set(path, data);
  }

  async listAttachments(): Promise<string[]> {
    return [...this.binaries.keys()].filter((p) => !p.startsWith(".obsidian/"));
  }

  async createDir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async removeDir(path: string): Promise<void> {
    this.folders.delete(path);
    const prefix = `${path}/`;
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p);
    for (const d of [...this.folders]) if (d.startsWith(prefix)) this.folders.delete(d);
  }

  async moveDir(from: string, to: string): Promise<void> {
    this.folders.delete(from);
    this.folders.add(to);
    const prefix = `${from}/`;
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(prefix)) {
        this.files.set(to + p.slice(from.length), this.files.get(p) as string);
        this.files.delete(p);
      }
    }
    for (const d of [...this.folders]) {
      if (d.startsWith(prefix)) {
        this.folders.delete(d);
        this.folders.add(to + d.slice(from.length));
      }
    }
  }
}
