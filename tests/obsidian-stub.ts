// Runtime stub of the `obsidian` package for tests: the real package is types-only
// (no main), values (TFile and the like) exist only inside the Obsidian app.
// Wired in via resolve.alias in vitest.config.ts.

export class TFile {
  path = "";
}
export class TFolder {
  path = "";
}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {
  static openedCount = 0;
  constructor(public app: unknown) {}
  open(): void {
    Modal.openedCount += 1;
  }
  close(): void {}
}
export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}
