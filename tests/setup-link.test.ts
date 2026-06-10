import { beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice } from "obsidian";

import { setLocale } from "@/i18n";
import { applySetup, handleSetupUri, parseSetupParams } from "@/ui/setup-link";
import { DEFAULT_SETTINGS, type SyncPluginLike } from "@/settings";

const noticeStub = Notice as unknown as { messages: string[] };
const modalStub = Modal as unknown as { openedCount: number };

const makePlugin = () => {
  const plugin = {
    app: {},
    settings: { ...DEFAULT_SETTINGS, boundVaultId: "vault-1", vaultToken: "old-token" },
    saveSettings: vi.fn(async () => {}),
    restartSync: vi.fn(),
  };
  return plugin as unknown as SyncPluginLike & { app: never } & typeof plugin;
};

beforeEach(() => {
  setLocale("en");
  noticeStub.messages.length = 0;
  modalStub.openedCount = 0;
});

describe("parseSetupParams", () => {
  it("accepts wss server and token", () => {
    expect(parseSetupParams({ server: "wss://sync.example.com", token: "nb_abc" })).toEqual({
      serverUrl: "wss://sync.example.com",
      token: "nb_abc",
    });
  });

  it("accepts ws server (lan mode)", () => {
    expect(parseSetupParams({ server: "ws://192.168.1.42:3000", token: "nb_abc" })).toEqual({
      serverUrl: "ws://192.168.1.42:3000",
      token: "nb_abc",
    });
  });

  it.each([
    [{ server: "https://evil.example.com", token: "nb_abc" }],
    [{ server: "wss://sync.example.com", token: "" }],
    [{ server: "", token: "nb_abc" }],
    [{}],
    [{ server: "wss://", token: "nb_abc" }],
  ])("rejects invalid params %j", (params) => {
    expect(parseSetupParams(params as Record<string, string>)).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseSetupParams({ server: " wss://s.example.com ", token: " nb_x " })).toEqual({
      serverUrl: "wss://s.example.com",
      token: "nb_x",
    });
  });
});

describe("applySetup", () => {
  it("saves server and token, restarts sync, keeps binding", async () => {
    const plugin = makePlugin();
    await applySetup(plugin, { serverUrl: "wss://new.example.com", token: "nb_new" });
    expect(plugin.settings.serverUrl).toBe("wss://new.example.com");
    expect(plugin.settings.vaultToken).toBe("nb_new");
    expect(plugin.settings.boundVaultId).toBe("vault-1");
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.restartSync).toHaveBeenCalled();
  });
});

describe("handleSetupUri", () => {
  it("invalid params: shows notice, does not open modal, does not change settings", () => {
    const plugin = makePlugin();
    handleSetupUri(plugin, { server: "https://evil.example.com", token: "x" });
    expect(noticeStub.messages.length).toBe(1);
    expect(modalStub.openedCount).toBe(0);
    expect(plugin.settings.vaultToken).toBe("old-token");
  });

  it("valid params: opens confirmation modal without applying yet", () => {
    const plugin = makePlugin();
    handleSetupUri(plugin, { server: "wss://sync.example.com", token: "nb_new" });
    expect(modalStub.openedCount).toBe(1);
    expect(plugin.settings.vaultToken).toBe("old-token");
    expect(plugin.restartSync).not.toHaveBeenCalled();
  });
});
