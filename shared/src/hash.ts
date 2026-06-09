type SubtleLike = { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
const webcrypto = (globalThis as unknown as { crypto: { subtle: SubtleLike } }).crypto;

export const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await webcrypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const isSha256Hex = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);
