// Контент-адресация вложений (Spec-03): sha256 в hex.
// Один алгоритм на клиенте (плагин) и сервере — иначе хэши не сойдутся и дедуп сломается.
// Web Crypto доступен и в Bun, и в Electron/мобильном Obsidian. Тип берём узким
// ambient-объявлением, чтобы не тянуть в shared весь DOM/Node lib (пакет — только протокол).
type SubtleLike = { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
const webcrypto = (globalThis as unknown as { crypto: { subtle: SubtleLike } }).crypto;

export const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await webcrypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Проверка формата хэша из URL `:hash` (64 hex-символа) до обращения к хранилищу.
export const isSha256Hex = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);
