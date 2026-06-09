// HTTP-клиент blob-хранилища вложений (Spec-03, REQ-03.2).
// HTTP-транспорт инъектируется (в рантайме — Obsidian requestUrl, в тестах — фейк),
// чтобы клиент не зависел от fetch/CORS и был юнит-тестируемым.
export type BlobHttp = (req: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
}) => Promise<{ status: number; arrayBuffer: ArrayBuffer }>;

export interface BlobClient {
  has(hash: string): Promise<boolean>; // HEAD — для дедупа (REQ-03.2)
  upload(hash: string, data: ArrayBuffer): Promise<{ ok: boolean; status: number }>;
  download(hash: string): Promise<ArrayBuffer | null>;
}

// serverUrl плагина — ws://|wss:// (тот же хост, что WebSocket). Blob идёт по http(s).
export const httpBaseFromWs = (wsUrl: string): string => {
  const base = wsUrl.replace(/^ws/, "http").replace(/\/+$/, "");
  return base;
};

export class HttpBlobClient implements BlobClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly http: BlobHttp,
  ) {}

  private url(hash: string): string {
    return `${this.baseUrl}/blob/${encodeURIComponent(hash)}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async has(hash: string): Promise<boolean> {
    const r = await this.http({ url: this.url(hash), method: "HEAD", headers: this.headers() });
    return r.status === 200;
  }

  async upload(hash: string, data: ArrayBuffer): Promise<{ ok: boolean; status: number }> {
    const r = await this.http({
      url: this.url(hash),
      method: "PUT",
      headers: this.headers(),
      body: data,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  }

  async download(hash: string): Promise<ArrayBuffer | null> {
    const r = await this.http({ url: this.url(hash), method: "GET", headers: this.headers() });
    return r.status === 200 ? r.arrayBuffer : null;
  }
}
