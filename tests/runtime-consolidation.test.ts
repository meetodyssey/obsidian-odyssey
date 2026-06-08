import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types";
import { PluginLocalRuntime } from "../src/runtime/plugin-local-runtime";

function makeRuntime(): PluginLocalRuntime {
  return new PluginLocalRuntime(
    () => DEFAULT_SETTINGS,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

function makeRuntimeWithSettings(settings: Partial<typeof DEFAULT_SETTINGS>): PluginLocalRuntime {
  return new PluginLocalRuntime(
    () => ({ ...DEFAULT_SETTINGS, ...settings }),
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe("runtime L0 consolidation triggers", () => {
  it("does not consolidate a full L0 window made only of low-information short chats", () => {
    const runtime = makeRuntime() as any;
    runtime.turnsSinceConsolidation = 6;
    runtime.charsSinceConsolidation = 2600;
    runtime.recentMessages = [
      { role: "user", content: "hm" },
      { role: "assistant", content: "Here." },
      { role: "user", content: "haha" },
      { role: "assistant", content: "I see." },
      { role: "user", content: "okay" }
    ];

    expect(runtime.l0WindowIsFull("okay", false)).toBe(false);
  });

  it("still allows short but meaningful facts to trigger L0 consolidation", () => {
    const runtime = makeRuntime() as any;
    runtime.turnsSinceConsolidation = 6;
    runtime.charsSinceConsolidation = 2600;
    runtime.recentMessages = [
      { role: "user", content: "hm" },
      { role: "assistant", content: "Here." },
      { role: "user", content: "My major is software engineering." },
      { role: "assistant", content: "I noted that fact." },
      { role: "user", content: "okay" }
    ];

    expect(runtime.l0WindowIsFull("okay", false)).toBe(true);
  });

  it("does not trigger consolidation from a single explicit memory request", () => {
    const runtime = makeRuntime() as any;
    runtime.turnsSinceConsolidation = 0;
    runtime.charsSinceConsolidation = 0;

    expect(runtime.shouldConsolidateMemory("Remember that my university major is communications engineering.")).toBe(false);
  });

  it("does not trigger consolidation from one long message before the L0 window is full", () => {
    const runtime = makeRuntime() as any;
    runtime.turnsSinceConsolidation = 1;
    runtime.charsSinceConsolidation = 900;

    expect(runtime.shouldConsolidateMemory("This is a long personal description. ".repeat(80))).toBe(false);
  });
});

describe("runtime auto continuation", () => {
  it("does not auto-continue ordinary deep chat", () => {
    const runtime = makeRuntime() as any;

    expect(runtime.shouldAllowAutoContinuation("What makes a conversation feel continuous?")).toBe(false);
  });

  it("allows auto-continuation for explicit long-form requests", () => {
    const runtime = makeRuntime() as any;

    expect(runtime.shouldAllowAutoContinuation("Expand fully and write a complete document.")).toBe(true);
  });

  it("respects explicit brevity requests", () => {
    const runtime = makeRuntime() as any;

    expect(runtime.shouldAllowAutoContinuation("Summarize this briefly and keep it short.")).toBe(false);
  });
});

describe("runtime context construction", () => {
  function makeRuntimeCapturingContext(capture: (recentMessages: any[]) => void): PluginLocalRuntime {
    const contextBuilder = {
      build: async (_message: string, recentMessages: any[]) => {
        capture(recentMessages);
        return {
          messages: [
            { role: "system", content: "system" },
            { role: "user", content: "question" }
          ],
          referencedMemoryIds: [],
          retrievedMemories: [],
          report: {
            modelContextLimit: 1000,
            estimatedInputChars: 0,
            reservedOutputTokens: 0,
            sections: {},
            droppedSections: []
          },
          warnings: []
        };
      }
    };
    return new PluginLocalRuntime(
      () => ({ ...DEFAULT_SETTINGS, autoExtractMemories: false }),
      {} as any,
      { refreshPaths: async () => undefined } as any,
      { analyze: () => ({ mode: "recall", keywords: ["remember"], hasExplicitTimeHint: false }) } as any,
      contextBuilder as any,
      { complete: async () => ({ content: "Answer.", outputLimited: false }) } as any,
      {} as any,
      {
        maybeWritePendingCorrection: async () => [],
        holdCorrectionIntent: () => undefined
      } as any
    );
  }

  it("excludes the current live session for last-conversation questions", async () => {
    let capturedRecentMessages: any[] = [];
    const runtime = makeRuntimeCapturingContext(messages => { capturedRecentMessages = messages; });
    runtime.hydrateRecentMessages([
      { role: "user", content: "Earlier saved question", created: "2026-06-05T10:00:00.000Z" },
      { role: "assistant", content: "Earlier saved answer", created: "2026-06-05T10:00:05.000Z" }
    ]);
    await runtime.sendMessage({ message: "Start of this live session." });

    await runtime.sendMessage({ message: "Do you remember when we chat last time?" });

    expect(capturedRecentMessages.map(message => message.content)).toEqual([
      "Earlier saved question",
      "Earlier saved answer"
    ]);
  });

  it("uses only current live-session history for just-said questions", async () => {
    let capturedRecentMessages: any[] = [];
    const runtime = makeRuntimeCapturingContext(messages => { capturedRecentMessages = messages; });
    runtime.hydrateRecentMessages([
      { role: "user", content: "Older saved question", created: "2026-06-05T10:00:00.000Z" },
      { role: "assistant", content: "Older saved answer", created: "2026-06-05T10:00:05.000Z" }
    ]);
    await runtime.sendMessage({ message: "This live-session topic is model presets." });

    await runtime.sendMessage({ message: "What did I just say?" });

    expect(capturedRecentMessages.map(message => message.content)).toEqual([
      "This live-session topic is model presets.",
      "Answer."
    ]);
  });
});

describe("runtime memory extraction status", () => {
  it("uses rule fallback when the extraction probe has not passed", () => {
    const runtime = makeRuntimeWithSettings({ extractionModelProbeStatus: "failed" }) as any;

    const status = runtime.describeMemoryExtractionStatus(true, "l0_window");

    expect(status.mode).toBe("rule_fallback");
    expect(status.backgroundJobQueued).toBe(true);
  });

  it("surfaces degraded AI extraction for partial probe results", () => {
    const runtime = makeRuntimeWithSettings({ extractionModelProbeStatus: "partial" }) as any;

    const status = runtime.describeMemoryExtractionStatus(true, "turn");

    expect(status.mode).toBe("degraded_ai_extraction");
    expect(status.consolidationMode).toBe("turn");
  });

  it("does not claim extraction work when consolidation is not triggered", () => {
    const runtime = makeRuntimeWithSettings({ extractionModelProbeStatus: "passed" }) as any;

    const status = runtime.describeMemoryExtractionStatus(false, "turn");

    expect(status.mode).toBe("not_triggered");
    expect(status.backgroundJobQueued).toBe(false);
  });
});
