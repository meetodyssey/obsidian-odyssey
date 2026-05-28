import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/context/context-builder";
import { DEFAULT_SETTINGS, IndexedMemory } from "../src/types";

function makeStore(conversationResult: any = null) {
  return {
    anchorFor: (path: string) => `[[${path}]]`,
    path: (child: string) => `Odyssey/${child}`,
    readFile: async (_path: string) => "",
    readL1ConversationTurnsForDate: async () => conversationResult
  };
}

function makeRetrieval(searchResults: any[] = [], dateSummaries: any[] = []) {
  return {
    search: () => searchResults,
    searchTargetDateSummaries: () => dateSummaries
  };
}

describe("context builder source-of-truth rules", () => {
  it("establishes Odyssey as a companion with a clear role", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder(DEFAULT_SETTINGS, store as any, retrieval as any);

    const context = await builder.build("Tell me about yourself", [], {
      mode: "normal_chat",
      keywords: ["Odyssey"],
      hasExplicitTimeHint: false
    });
    const system = context.messages[0].content;

    expect(system).toContain("digital companion");
    expect(system).toContain("Rules:");
    expect(system).toContain("Answer only from the provided context");
  });

  it("tells the model not to claim remembering things just said", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder(DEFAULT_SETTINGS, store as any, retrieval as any);

    const context = await builder.build("Do you remember me?", [], {
      mode: "recall",
      keywords: ["remember"],
      hasExplicitTimeHint: false
    });
    const system = context.messages[0].content;

    expect(system).toContain("current message");
    expect(system).toContain("remember from before");
  });

  it("instructs the model to acknowledge errors directly", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder(DEFAULT_SETTINGS, store as any, retrieval as any);

    const context = await builder.build("I broke my leg in high school and took a year off", [], {
      mode: "normal_chat",
      keywords: ["high school", "injury"],
      hasExplicitTimeHint: false
    });
    const system = context.messages[0].content;

    expect(system).toContain("When corrected, acknowledge the error");
    expect(system).toContain("fix it without defending");
  });

  it("uses a constrained prompt for local small models", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder(DEFAULT_SETTINGS, store as any, retrieval as any);

    const context = await builder.build("Hey, how are you?", [], {
      mode: "normal_chat",
      keywords: ["hey"],
      hasExplicitTimeHint: false
    });
    const system = context.messages[0].content;

    expect(system).toContain("Rules:");
    expect(system).toContain("say so directly");
    expect(system).toContain("CRITICAL");
  });

  it("puts an explicit no-visible-document warning when no references are attached", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build("What are the three steps in the methodology section?", [], {
      mode: "normal_chat",
      keywords: ["methodology", "steps"],
      hasExplicitTimeHint: false,
      wantsReference: true
    });
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("Evidence Boundary");
    expect(rendered).toContain("Visible attached sources:");
    expect(rendered).toContain("- none");
    expect(rendered).toContain("say you cannot see the original text");
  });

  it("tells the model to surface conflicts between new facts and recalled memory", async () => {
    const recalledMajor: IndexedMemory = {
      id: "sum_major",
      path: "Odyssey/L1_Recent_Memory/2026/05/sum_major.md",
      title: "Major record",
      type: "memory_summary",
      level: "L1",
      created: "2026-05-13T08:10:00.000Z",
      updated: "2026-05-13T08:10:00.000Z",
      tags: ["major"],
      summary: "User previously said their school major was electrical engineering, later shifted to software architecture.",
      status: "active",
      source: [],
      anchors: ["[[Odyssey/L1_Recent_Memory/2026/05/mem_test001.md]]"],
      correctionLinks: [],
      entities: [],
      confidence: "medium"
    };
    const store = makeStore();
    const retrieval = makeRetrieval([{ memory: recalledMajor, score: 60, reason: "test", activatedAsL0: false }]);
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build("My major is computer science", [], {
      mode: "normal_chat",
      keywords: ["major", "computer", "science"],
      hasExplicitTimeHint: false
    });
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("electrical engineering");
    expect(rendered).toContain("computer science");
  });

  it("prevents remembered topics from being promoted into provided documents", async () => {
    const recalledTopic: IndexedMemory = {
      id: "sum_conf_topic",
      path: "Odyssey/L1_Recent_Memory/2026/05/sum_conf_topic.md",
      title: "Conference direction",
      type: "memory_summary",
      level: "L1",
      created: "2026-05-13T08:10:00.000Z",
      updated: "2026-05-13T08:10:00.000Z",
      tags: ["conference", "Horizon"],
      summary: "User mentioned a conference talk direction and that Horizon may relate to distributed systems.",
      status: "active",
      source: [],
      anchors: ["[[Odyssey/L1_Recent_Memory/2026/05/mem_test001.md]]"],
      correctionLinks: [],
      entities: ["user"],
      confidence: "medium"
    };
    const attachedPrd = {
      id: "ref_horizon_prd",
      title: "Horizon_PRD_v2.0.md",
      path: "Odyssey/References/ref_horizon_prd.md",
      summary: "Horizon PRD document.",
      excerpt: "Horizon product requirements and MVP scope."
    };
    const store = makeStore();
    const retrieval = makeRetrieval([{ memory: recalledTopic, score: 60, reason: "test", activatedAsL0: false }]);
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build(
      "Check the Horizon PRD I just gave you",
      [],
      { mode: "normal_chat", keywords: ["Horizon", "PRD", "conference"], hasExplicitTimeHint: false, wantsReference: true },
      [attachedPrd]
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("conference talk direction");
    expect(rendered).toContain("Horizon_PRD_v2.0.md");
  });

  it("uses target-date summaries and user source text without injecting old assistant hallucinations", async () => {
    const datedSummary: IndexedMemory = {
      id: "sum_20260513",
      path: "Odyssey/L1_Recent_Memory/2026/05/sum_20260513.md",
      title: "May 13 status summary",
      type: "memory_summary",
      level: "L1",
      created: "2026-05-13T08:10:00.000Z",
      updated: "2026-05-13T08:10:00.000Z",
      tags: [],
      summary: "User was both excited and frustrated - excited about a new project idea, frustrated by limited team resources.",
      status: "active",
      source: [],
      anchors: ["[[Odyssey/L1_Recent_Memory/2026/05/mem_test001.md]]"],
      correctionLinks: [],
      entities: [],
      confidence: "medium"
    };
    const store = makeStore({
      path: "Odyssey/L1_Recent_Memory/2026/05/mem_test001.md",
      messages: [
        {
          role: "user" as const,
          created: "2026-05-13T08:00:00.000Z",
          content: "I'm feeling both excited and frustrated. Excited because the new project is progressing, frustrated because the team is under-resourced."
        },
        {
          role: "assistant" as const,
          created: "2026-05-13T08:01:00.000Z",
          content: "You mentioned having an extreme personality and complained about your previous employer."
        }
      ]
    });
    const retrieval = makeRetrieval([], [{ memory: datedSummary, score: 90, reason: "test", activatedAsL0: false }]);
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build("Recall how I felt on May 13, 2026 when we first chatted", [], {
      mode: "recall",
      keywords: [],
      hasExplicitTimeHint: true,
      targetDates: ["2026-05-13"]
    });
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("excited and frustrated");
    expect(rendered).toContain("Target Date Summaries");
    expect(rendered).toContain("source of truth");
    expect(rendered).not.toContain("previous employer");
    expect(rendered).not.toContain("extreme personality");
  });

  it("omits recent assistant messages from L0 when recalling user facts", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build(
      "What was my state on May 13?",
      [
        {
          role: "assistant",
          created: "2026-05-15T10:00:00.000Z",
          content: "You mentioned having an extreme personality and complained about your previous employer."
        },
        {
          role: "user",
          created: "2026-05-15T10:01:00.000Z",
          content: "No, I was only asking about May 13."
        }
      ],
      {
        mode: "recall",
        keywords: [],
        hasExplicitTimeHint: true,
        targetDates: ["2026-05-13"]
      }
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("user_source_of_truth");
    expect(rendered).toContain("No, I was only asking about May 13.");
    expect(rendered).not.toContain("previous employer");
    expect(rendered).not.toContain("extreme personality");
  });

  it("injects attached references as L0 working references", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build(
      "Check the release recommendations in this architecture review",
      [],
      { mode: "normal_chat", keywords: ["review", "release"], hasExplicitTimeHint: false, wantsReference: true },
      [{
        id: "ref_release_notes",
        title: "Architecture_Release_Review.md",
        path: "Odyssey/References/ref_release_notes.md",
        summary: "The review discusses a staged release plan.",
        excerpt: "Release the stable core first, then evaluate optional modules after feedback."
      }]
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("L0 Attached References");
    expect(rendered).toContain("Architecture_Release_Review.md");
    expect(rendered).toContain("Release the stable core first");
    expect(context.referencedMemoryIds).toContain("ref_release_notes");
    expect(context.report.sections.attachedReferences).toBeGreaterThan(0);
  });

  it("keeps later attached references visible when the first attachment is long", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);
    const longText = "first attachment background ".repeat(500);

    const context = await builder.build(
      "Compare these three attachments",
      [],
      { mode: "normal_chat", keywords: ["attachments"], hasExplicitTimeHint: false, wantsReference: true },
      [
        { id: "ref_first", title: "first-long.md", path: "Odyssey/References/ref_first.md", summary: longText, excerpt: longText },
        { id: "ref_second", title: "second.md", path: "Odyssey/References/ref_second.md", summary: "second summary", excerpt: "second unique excerpt" },
        { id: "ref_third", title: "third.md", path: "Odyssey/References/ref_third.md", summary: "third summary", excerpt: "third unique excerpt" }
      ]
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("first-long.md");
    expect(rendered).toContain("second.md");
    expect(rendered).toContain("second unique excerpt");
    expect(rendered).toContain("third.md");
    expect(rendered).toContain("third unique excerpt");
    expect(context.referencedMemoryIds).toEqual(expect.arrayContaining(["ref_first", "ref_second", "ref_third"]));
  });

  it("selects the attached document section relevant to the user's question", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);
    const document = [
      "# Reading Notes: Effective Learning",
      "## Introduction",
      "Background material. ".repeat(700),
      "## Methodology",
      "The author argues that effective learning is a layered process.",
      "**Input** - acquire new knowledge through reading and listening, forming initial impressions.",
      "**Digest** - convert knowledge into personal understanding through notes and discussion.",
      "**Output** - verify and consolidate learning through writing and teaching others."
    ].join("\n\n");

    const context = await builder.build(
      "What are the three steps in the methodology section?",
      [],
      { mode: "normal_chat", keywords: ["methodology", "steps"], hasExplicitTimeHint: false, wantsReference: true },
      [{
        id: "att_learning",
        title: "reading-notes-learning.md",
        path: "/Users/test/reading-notes-learning.md",
        summary: document.slice(0, 1200),
        excerpt: document
      }]
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("Relevant excerpts");
    expect(rendered).toContain("## Methodology");
    expect(rendered).toContain("**Input**");
    expect(rendered).toContain("**Output**");
  });

  it("makes document visibility explicit when the user asks about an unattached paper", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);

    const context = await builder.build(
      "The methodology section I just mentioned, can you see it?",
      [{ role: "user", content: "The paper's methodology section describes three steps.", created: "2026-05-22T07:39:00.000Z" }],
      { mode: "normal_chat", keywords: ["methodology", "section", "steps"], hasExplicitTimeHint: false, wantsReference: true }
    );
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("No L0 attached reference content is visible");
    expect(rendered).toContain("The paper's methodology section describes three steps.");
  });

  it("keeps relevant recent user facts in L0 even when they are not in the last few turns", async () => {
    const store = makeStore();
    const retrieval = makeRetrieval();
    const builder = new ContextBuilder({ ...DEFAULT_SETTINGS, modelTier: "frontier" }, store as any, retrieval as any);
    const messages = [
      {
        role: "user" as const,
        created: "2026-05-16T12:00:00.000Z",
        content: "I went to State University, majoring in communications engineering."
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: (index % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
        created: `2026-05-16T12:${String(index + 1).padStart(2, "0")}:00.000Z`,
        content: index % 2 === 0 ? "Let's continue talking about Odyssey." : `Follow-up question ${index}.`
      })),
      {
        role: "user" as const,
        created: "2026-05-16T12:30:00.000Z",
        content: "Do you know which university I attended?"
      }
    ];

    const context = await builder.build("Do you know which university I attended?", messages, {
      mode: "recall",
      keywords: ["university"],
      hasExplicitTimeHint: false
    });
    const rendered = context.messages.map(message => message.content).join("\n\n");

    expect(rendered).toContain("I went to State University, majoring in communications engineering.");
  });
});
