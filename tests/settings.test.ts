import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/types";

describe("settings migration", () => {
  it("preserves existing model settings and API key while migrating legacy naming", () => {
    const settings = normalizeSettings({
      rootDir: "DigitalSelf",
      digitalSelfName: "Little O",
      userAvatar: "F",
      odysseyAvatar: "O",
      modelProvider: "openai-compatible",
      apiBaseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      chatModel: "deepseek-v4-pro",
      summaryModel: "deepseek-v4-pro",
      extractionModel: "deepseek-v4-pro",
      extractionModelProbeStatus: "partial",
      extractionModelProbeMessage: "Valid JSON with unstable semantics.",
      extractionModelProbeUpdatedAt: "2026-05-16T12:00:00.000Z",
      autoExtractMemories: false,
      maxInputChars: 24000,
      maxOutputTokens: 8000,
      shadowIndexSecret: "secret",
      lockOnOpen: false,
      lockMemoryFilesByDefault: false,
      autoLockMinutes: 3,
      privacyLockPasscodeHash: "hash",
      hideDebugByDefault: false
    });

    expect(settings.apiKey).toBe("sk-test");
    expect(settings.rootDir).toBe("Odyssey");
    expect(settings.odysseyName).toBe("Little O");
    expect(settings.userAvatar).toBe("F");
    expect(settings.odysseyAvatar).toBe("O");
    expect(settings.modelProvider).toBe("openai-compatible");
    expect(settings.apiBaseUrl).toBe("https://api.deepseek.com");
    expect(settings.chatModel).toBe("deepseek-v4-pro");
    expect(settings.extractionModelProbeStatus).toBe("partial");
    expect(settings.extractionModelProbeMessage).toBe("Valid JSON with unstable semantics.");
    expect(settings.extractionModelProbeUpdatedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(settings.autoExtractMemories).toBe(false);
    expect(settings.maxInputChars).toBe(24000);
    expect(settings.maxOutputTokens).toBe(8000);
    expect(settings.maxContinuationTurns).toBe(DEFAULT_SETTINGS.maxContinuationTurns);
    expect(settings.shadowIndexSecret).toBe("secret");
    expect(settings.lockOnOpen).toBe(false);
    expect(settings.lockMemoryFilesByDefault).toBe(false);
    expect(settings.autoLockMinutes).toBe(3);
    expect(settings.privacyLockPasscodeHash).toBe("hash");
    expect(settings.hideDebugByDefault).toBe(false);
  });

  it("falls back only for invalid or missing values", () => {
    const settings = normalizeSettings({
      modelProvider: "unknown",
      extractionModelProbeStatus: "weird",
      apiKey: "",
      maxOutputTokens: "8000"
    });

    expect(settings.modelProvider).toBe(DEFAULT_SETTINGS.modelProvider);
    expect(settings.extractionModelProbeStatus).toBe(DEFAULT_SETTINGS.extractionModelProbeStatus);
    expect(settings.userAvatar).toBe(DEFAULT_SETTINGS.userAvatar);
    expect(settings.odysseyAvatar).toBe(DEFAULT_SETTINGS.odysseyAvatar);
    expect(settings.apiKey).toBe("");
    expect(settings.maxOutputTokens).toBe(DEFAULT_SETTINGS.maxOutputTokens);
  });

  it("preserves native Anthropic provider settings", () => {
    const settings = normalizeSettings({
      modelProvider: "anthropic",
      apiBaseUrl: "https://api.anthropic.com/v1",
      chatModel: "claude-sonnet-4-5",
      summaryModel: "claude-sonnet-4-5",
      extractionModel: "claude-sonnet-4-5"
    });

    expect(settings.modelProvider).toBe("anthropic");
    expect(settings.apiBaseUrl).toBe("https://api.anthropic.com/v1");
    expect(settings.chatModel).toBe("claude-sonnet-4-5");
  });
});
