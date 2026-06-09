// Рантайм-стаб пакета `obsidian` для тестов: реальный пакет — types-only
// (нет main), значения (TFile и пр.) существуют только внутри приложения Obsidian.
// Подключается через resolve.alias в vitest.config.ts.

export class TFile {
  path = "";
}
export class TFolder {
  path = "";
}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
