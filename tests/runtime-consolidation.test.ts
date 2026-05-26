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
