import { z } from "zod";

export const MAX_PATH_LENGTH = 1024;

const hasControlChar = (path: string): boolean => {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true; // NUL / control / DEL
  }
  return false;
};

// Единый предикат «безопасный синхронизируемый путь внутри vault».
// Применяется и к исходящим (фильтр), и к входящим (ПЕРЕД любой записью) путям —
// плагин не доверяет серверу: запись в `.obsidian/` или выход за пределы vault = RCE.
export const isSyncablePath = (path: string): boolean => {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (hasControlChar(path)) return false;
  if (path.includes("\\")) return false; // backslash (Windows-сепаратор / экранирование)
  if (path.startsWith("/")) return false; // абсолютный POSIX-путь
  if (/^[A-Za-z]:/.test(path)) return false; // диск-литерал C:
  if (path === ".obsidian" || path.startsWith(".obsidian/")) return false; // каталог конфигов/плагинов
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false; // traversal / пустые сегменты
  }
  return true;
};

export const normalizePath = (path: string): string => path.normalize("NFC");

export const PathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .transform(normalizePath)
  .refine(isSyncablePath, { message: "unsafe or non-syncable path" });
