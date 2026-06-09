import { TFile, type Vault } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import { ObsidianVault } from "@/sync/obsidian-vault";

// `obsidian` in tests resolves to tests/obsidian-stub.ts (see vitest.config.ts).
// Obsidian's TFile is constructed without arguments — create an instance via the prototype.
const mkFile = (path: string): TFile => Object.assign(Object.create(TFile.prototype), { path }) as TFile;

class FakeVault {
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, ArrayBuffer>();
  readonly folders = new Set<string>();

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map(mkFile);
  }
  getFiles(): TFile[] {
    return [...this.files.keys(), ...this.binaries.keys()].map(mkFile);
  }
  getAbstractFileByPath(path: string): unknown {
    if (this.files.has(path) || this.binaries.has(path)) return mkFile(path);
    if (this.folders.has(path)) return { path }; // folder — not a TFile
    return null;
  }
  async readBinary(file: { path: string }): Promise<ArrayBuffer> {
    return this.binaries.get(file.path) ?? new ArrayBuffer(0);
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaries.set(path, data);
  }
  async modifyBinary(file: { path: string }, data: ArrayBuffer): Promise<void> {
    this.binaries.set(file.path, data);
  }
  async read(file: { path: string }): Promise<string> {
    return this.files.get(file.path) ?? "";
  }
  async modify(file: { path: string }, content: string): Promise<void> {
    this.files.set(file.path, content);
  }
  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async createFolder(dir: string): Promise<void> {
    this.folders.add(dir);
  }
  trashed: string[] = [];
  async trash(f: { path: string }, _system: boolean): Promise<void> {
    this.trashed.push(f.path);
    await this.delete(f);
  }
  async delete(f: { path: string }): Promise<void> {
    if (this.files.has(f.path)) {
      this.files.delete(f.path);
      return;
    }
    // folder: recursively delete the folder itself + its contents
    this.folders.delete(f.path);
    const prefix = `${f.path}/`;
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p);
    for (const d of [...this.folders]) if (d.startsWith(prefix)) this.folders.delete(d);
  }
  async rename(file: { path: string }, to: string): Promise<void> {
    // like real Obsidian: cannot move into a non-existent folder
    const dir = to.split("/").slice(0, -1).join("/");
    if (dir && !this.folders.has(dir)) throw new Error(`ENOENT: no such folder ${dir}`);
    const content = this.files.get(file.path) ?? "";
    this.files.delete(file.path);
    this.files.set(to, content);
  }
}

describe("ObsidianVault (VaultPort adapter over the Obsidian Vault API)", () => {
  let vault: FakeVault;
  let port: ObsidianVault;

  beforeEach(() => {
    vault = new FakeVault();
    port = new ObsidianVault(vault as unknown as Vault);
  });

  it("list returns only .md files with their content", async () => {
    vault.files.set("a.md", "A");
    vault.files.set("b.md", "B");
    vault.files.set("c.txt", "C");
    const list = await port.list();
    expect(list.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
    expect(list.find((f) => f.path === "a.md")?.content).toBe("A");
  });

  it("read: content for .md, null for a missing file/folder", async () => {
    vault.files.set("a.md", "A");
    vault.folders.add("dir");
    expect(await port.read("a.md")).toBe("A");
    expect(await port.read("missing.md")).toBeNull();
    expect(await port.read("dir")).toBeNull();
  });

  it("write creates a new file", async () => {
    await port.write("n.md", "X");
    expect(vault.files.get("n.md")).toBe("X");
  });

  it("write modifies an existing file", async () => {
    vault.files.set("a.md", "A");
    await port.write("a.md", "A2");
    expect(vault.files.get("a.md")).toBe("A2");
  });

  it("write creates the parent folder for a nested path", async () => {
    await port.write("dir/sub/n.md", "X");
    expect(vault.folders.has("dir/sub")).toBe(true);
    expect(vault.files.get("dir/sub/n.md")).toBe("X");
  });

  it("remove deletes a file", async () => {
    vault.files.set("a.md", "A");
    await port.remove("a.md");
    expect(vault.files.has("a.md")).toBe(false);
  });

  it("trash moves a file to the trash (reversible)", async () => {
    vault.files.set("a.md", "A");
    await port.trash("a.md");
    expect(vault.files.has("a.md")).toBe(false);
    expect(vault.trashed).toContain("a.md"); // via vault.trash, not a permanent delete
  });

  it("rename moves a file", async () => {
    vault.files.set("a.md", "A");
    await port.rename("a.md", "b.md");
    expect(vault.files.has("a.md")).toBe(false);
    expect(vault.files.get("b.md")).toBe("A");
  });

  it("rename creates the parent folder when moving into a new folder", async () => {
    vault.files.set("a.md", "A");
    await port.rename("a.md", "sub/dir/a.md");
    expect(vault.folders.has("sub/dir")).toBe(true);
    expect(vault.files.get("sub/dir/a.md")).toBe("A");
    expect(vault.files.has("a.md")).toBe(false);
  });

  it("exists", async () => {
    vault.files.set("a.md", "A");
    expect(await port.exists("a.md")).toBe(true);
    expect(await port.exists("x.md")).toBe(false);
  });

  it("createDir creates a folder (including an empty one)", async () => {
    await port.createDir("Empty");
    expect(vault.folders.has("Empty")).toBe(true);
  });

  it("removeDir recursively deletes a folder with its contents", async () => {
    vault.folders.add("F");
    vault.folders.add("F/sub");
    vault.files.set("F/a.md", "A");
    vault.files.set("F/sub/b.md", "B");
    await port.removeDir("F");
    expect(vault.folders.has("F")).toBe(false);
    expect(vault.files.has("F/a.md")).toBe(false);
    expect(vault.files.has("F/sub/b.md")).toBe(false);
  });

  // --- Binary attachments (Spec-03, REQ-03.3 adapter) ---

  it("readBinary: bytes for a file, null for a missing one", async () => {
    vault.binaries.set("img.png", new Uint8Array([1, 2, 3]).buffer);
    expect([...new Uint8Array((await port.readBinary("img.png"))!)]).toEqual([1, 2, 3]);
    expect(await port.readBinary("missing.png")).toBeNull();
  });

  it("writeBinary creates a new binary file and its parent folder", async () => {
    await port.writeBinary("attach/pic.png", new Uint8Array([9, 8, 7]).buffer);
    expect(vault.folders.has("attach")).toBe(true);
    expect([...new Uint8Array(vault.binaries.get("attach/pic.png")!)]).toEqual([9, 8, 7]);
  });

  it("writeBinary modifies an existing binary file", async () => {
    vault.binaries.set("img.png", new Uint8Array([1]).buffer);
    await port.writeBinary("img.png", new Uint8Array([2, 2]).buffer);
    expect([...new Uint8Array(vault.binaries.get("img.png")!)]).toEqual([2, 2]);
  });

  it("listAttachments: non-.md files, excluding .md and .obsidian/", async () => {
    vault.files.set("note.md", "N");
    vault.binaries.set("img.png", new Uint8Array([1]).buffer);
    vault.binaries.set("doc.pdf", new Uint8Array([2]).buffer);
    vault.binaries.set(".obsidian/workspace.json", new Uint8Array([3]).buffer);
    const list = (await port.listAttachments()).sort();
    expect(list).toEqual(["doc.pdf", "img.png"]);
  });
});
