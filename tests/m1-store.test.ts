import { beforeEach, describe, expect, it } from "vitest";
import { TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/types";

class FakeVault {
  files = new Map<string, { file: any; content: string }>();
  folders = new Set<string>();
  adapter = {
    exists: async (path: string) => this.files.has(normalizePath(path)) || this.folders.has(normalizePath(path)),
    read: async (path: string) => this.files.get(normalizePath(path))?.content ?? "",
    write: async (path: string, content: string) => {
      const normalized = normalizePath(path);
      const existing = this.files.get(normalized);
      if (existing) {
        existing.content = content;
        return;
      }
      const file = new TFile(normalized);
      this.files.set(normalized, { file, content });
    }
  };

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async create(path: string, content: string): Promise<any> {
    const normalized = normalizePath(path);
    const file = new TFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async modify(file: any, content: string): Promise<void> {
    const normalized = normalizePath(file.path);
    const existing = this.files.get(normalized);
    if (!existing) throw new Error(`missing file ${normalized}`);
    existing.content = content;
    file.stat.mtime = Date.now();
  }

  async read(file: any): Promise<string> {
    return this.files.get(normalizePath(file.path))?.content ?? "";
  }

  getAbstractFileByPath(path: string): any {
    return this.files.get(normalizePath(path))?.file ?? null;
  }

  getMarkdownFiles(): any[] {
    return Array.from(this.files.values())
      .filter(entry => entry.file.path.endsWith(".md"))
      .map(entry => entry.file);
  }

  getFiles(): any[] {
    return Array.from(this.files.values()).map(entry => entry.file);
  }
}

describe("M1 local fact source", () => {
  let vault: FakeVault;

  beforeEach(() => {
    vault = new FakeVault();
  });

  it("initializes the Odyssey directory structure", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);

    await store.ensureInitialized();

    expect(vault.folders.has("Odyssey")).toBe(true);
    expect(vault.folders.has("Odyssey/Conversations")).toBe(true);
    expect(Array.from(vault.folders).some(path => path.startsWith("Odyssey/L1_"))).toBe(true);
    expect(vault.folders.has("Odyssey/Corrections")).toBe(true);
    expect(vault.folders.has("Odyssey/References")).toBe(true);
    expect(vault.folders.has("Odyssey/Exports")).toBe(true);
    expect(vault.folders.has("Odyssey/Feedback")).toBe(true);
    expect(vault.folders.has("Odyssey/Index")).toBe(true);
  });

  it("appends user messages to the dated conversation file", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    const path = await store.appendConversationMessage({
      role: "user",
      content: "Today I want to record an important event.",
      created: "2026-05-13T12:00:00.000Z"
    });

    expect(path).toMatch(/^Odyssey\/Conversations\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/);
    const content = vault.files.get(path)?.content ?? "";
    expect(content).toContain("## 2026-05-13T12:00:00.000Z");
    expect(content).toContain("Today I want to record an important event.");
  });

  it("serializes concurrent appends to the dated conversation file", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    const paths = await Promise.all([
      store.appendConversationMessage({ role: "user", content: "First message", created: "2026-05-14T10:00:00.000Z" }),
      store.appendConversationMessage({ role: "assistant", content: "Second message", created: "2026-05-14T10:00:01.000Z" }),
      store.appendConversationMessage({ role: "user", content: "Third message", created: "2026-05-14T10:00:02.000Z" })
    ]);

    const content = vault.files.get(paths[0])?.content ?? "";
    expect(content).toContain("First message");
    expect(content).toContain("Second message");
    expect(content).toContain("Third message");
  });

  it("loads recent conversation messages from markdown history", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    await store.writeTextFile("Odyssey/Conversations/2026/05/2026-05-14.md", [
      "# 2026-05-14",
      "",
      "## 2026-05-14T10:00:00.000Z user",
      "",
      "Yesterday's topic",
      "",
      "## 2026-05-14T10:01:00.000Z Odyssey",
      "",
      "Yesterday's response"
    ].join("\n"));
    await store.writeTextFile("Odyssey/Conversations/2026/05/2026-05-15.md", [
      "# 2026-05-15",
      "",
      "## 2026-05-15T11:00:00.000Z user",
      "",
      "Continue today",
      "",
      "## 2026-05-15T11:01:00.000Z Odyssey",
      "",
      "Continued response"
    ].join("\n"));

    const messages = await store.readRecentConversationMessages(3);

    expect(messages).toEqual([
      { role: "assistant", content: "Yesterday's response", created: "2026-05-14T10:01:00.000Z" },
      { role: "user", content: "Continue today", created: "2026-05-15T11:00:00.000Z" },
      { role: "assistant", content: "Continued response", created: "2026-05-15T11:01:00.000Z" }
    ]);
  });

  it("loads conversation messages for an exact date", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    await store.writeTextFile("Odyssey/Conversations/2026/05/2026-05-13.md", [
      "# 2026-05-13",
      "",
      "## 2026-05-13T08:00:00.000Z user",
      "",
      "How I felt in our first conversation",
      "",
      "## 2026-05-13T08:01:00.000Z Odyssey",
      "",
      "I will answer only from the source text."
    ].join("\n"));

    const result = await store.readConversationMessagesForDate("2026-05-13");

    expect(result?.path).toBe("Odyssey/Conversations/2026/05/2026-05-13.md");
    expect(result?.messages).toEqual([
      { role: "user", content: "How I felt in our first conversation", created: "2026-05-13T08:00:00.000Z" },
      { role: "assistant", content: "I will answer only from the source text.", created: "2026-05-13T08:01:00.000Z" }
    ]);
  });

  it("writes raw_memory and memory_summary with source/anchor frontmatter", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { parseMarkdown } = await import("../src/utils/frontmatter");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nThe user recorded an event.", ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["record"]);
    const summaryId = await store.writeMemorySummary("L1", "The user recorded an important event.", [store.recordAnchor("L1", rawId)], ["record"], "high");

    const rawEntry = Array.from(vault.files.values()).find(entry => entry.file.path.includes(rawId));
    const summaryEntry = Array.from(vault.files.values()).find(entry => entry.file.path.includes(summaryId));
    expect(rawEntry).toBeTruthy();
    expect(summaryEntry).toBeTruthy();

    const raw = parseMarkdown(rawEntry!.content);
    const summary = parseMarkdown(summaryEntry!.content);
    expect(raw.frontmatter.type).toBe("raw_memory");
    expect(raw.frontmatter.level).toBe("L1");
    expect(raw.frontmatter.source).toEqual(["[[Odyssey/Conversations/2026/05/2026-05-13]]"]);
    expect(summary.frontmatter.type).toBe("memory_summary");
    expect(summary.frontmatter.anchors).toEqual([store.recordAnchor("L1", rawId)]);
    expect(summary.frontmatter.priority).toBeUndefined();
  });

  it("rejects memory summaries without source anchors", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    await expect(store.writeMemorySummary("L1", "Summary without a source", [])).rejects.toThrow(/requires at least one/i);
  });

  it("can rebuild indexes from markdown while preserving raw memory files", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nThe user recorded an event.", ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["record"]);
    await store.writeMemorySummary("L1", "The user recorded an important event.", [store.recordAnchor("L1", rawId)], ["record"], "high");

    vault.files.delete("Odyssey/Index/memory-index.json");
    vault.files.delete("Odyssey/Index/document-index.json");

    const index = new LocalIndex(store);
    const result = await index.rebuild();

    expect(result.documentCount).toBeGreaterThanOrEqual(2);
    expect(result.memoryCount).toBeGreaterThanOrEqual(2);
    expect(Array.from(vault.files.keys()).some(path => path.includes(rawId))).toBe(true);
    expect(vault.files.has("Odyssey/Index/memory-index.json")).toBe(true);
  });

  it("can rebuild indexes when getMarkdownFiles is temporarily empty", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    await store.writeRawMemory("L1", "## Raw Memory\n\nThe user studied computer science at Sample University.", ["[[Odyssey/Conversations/2026/05/2026-05-18]]"], ["university"]);
    vault.getMarkdownFiles = () => [];

    const index = new LocalIndex(store);
    const result = await index.rebuild();

    expect(result.memoryCount).toBeGreaterThanOrEqual(1);
    expect(index.memories.some(memory => memory.summary.includes("Sample University"))).toBe(true);
  });

  it("can refresh the index from changed paths without a full markdown scan", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const index = new LocalIndex(store);
    await index.load();

    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nThe user likes refining core experiences.", ["[[Odyssey/Conversations/2026/05/2026-05-19]]"], ["experience"]);
    await index.refreshPaths([store.rawMemoryPath("L1", rawId)]);

    expect(index.memories.some(memory => memory.id === rawId)).toBe(true);
    const publicIndex = vault.files.get("Odyssey/Index/memory-index.json")?.content ?? "";
    expect(publicIndex).toContain(rawId);
    expect(publicIndex).toContain("The user likes refining core experiences.");
  });

  it("indexes English Summary sections as summary text", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nThe user recorded an event.", ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["record"]);
    const summaryId = await store.writeMemorySummary("L1", "The user recorded an important event.", [store.recordAnchor("L1", rawId)], ["record"], "high");

    const index = new LocalIndex(store);
    await index.rebuild();

    const summary = index.memories.find(memory => memory.id === summaryId);
    expect(summary?.summary).toBe("The user recorded an important event.");
    expect(summary?.summary).not.toContain("Memory Anchors");
  });

  it("applies append-only corrections to supersede old memories during rebuild", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nI live in Harbor City.", ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["residence"]);
    await store.writeCorrection([store.recordAnchor("L1", rawId)], "I now live in River City.", "The user corrected an outdated fact.", "Not Harbor City; River City.");

    const index = new LocalIndex(store);
    await index.rebuild();

    const oldMemory = index.memories.find(memory => memory.id === rawId);
    expect(oldMemory?.status).toBe("superseded");
    const publicIndex = vault.files.get("Odyssey/Index/memory-index.json")?.content ?? "";
    expect(publicIndex).not.toContain("correctionLinks");
  });

  it("writes sensitive ranking metadata only to encrypted Shadow Index", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const { ShadowIndexStore } = await import("../src/index/shadow-index-store");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const shadow = new ShadowIndexStore({ vault } as any, ".odyssey", "test-secret");
    await shadow.ensureInitialized();

    const rawId = await store.writeRawMemory("L1", "## Raw Memory\n\nThe user recorded an event.", ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["record"]);
    await store.writeMemorySummary("L1", "The user recorded an important event.", [store.recordAnchor("L1", rawId)], ["record"], "high");

    const index = new LocalIndex(store, shadow);
    await index.rebuild();

    const summaryEntry = Array.from(vault.files.values()).find(entry => entry.file.path.includes("sum_"));
    expect(summaryEntry?.content).not.toContain("priority:");
    expect(summaryEntry?.content).not.toContain("retrievalWeight");
    const publicIndex = vault.files.get("Odyssey/Index/memory-index.json")?.content ?? "";
    expect(publicIndex).not.toContain("retrievalWeight");
    expect(publicIndex).not.toContain("\"priority\"");

    const encrypted = vault.files.get(".odyssey/index.enc")?.content ?? "";
    expect(encrypted).toContain("ciphertext");
    expect(encrypted).not.toContain("retrievalWeight");
    expect(encrypted).not.toContain("The user recorded an important event.");

    await shadow.load();
    expect(shadow.entryCount).toBeGreaterThanOrEqual(2);
  });

  it("indexes imported references without promoting them to memory summaries", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    await vault.create("notes/project.md", "# Project\n\nThis is an imported note.");

    const candidates = await store.listReferenceCandidateFiles();
    expect(candidates.map(file => file.path)).toEqual(["notes/project.md"]);
    const refId = await store.writeReference("notes/project.md", "Project", "This is an imported note.");

    const index = new LocalIndex(store);
    await index.rebuild();
    const reference = index.memories.find(memory => memory.id === refId);
    expect(reference?.type).toBe("reference");
    expect(reference?.priority).toBe("low");
  });

  it("keeps references low priority unless the user explicitly asks for notes or docs", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { LocalIndex } = await import("../src/index/local-index");
    const { RetrievalService } = await import("../src/retrieval/retrieval-service");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    for (const text of ["Odyssey product plan", "Odyssey memory design", "Odyssey context budget"]) {
      const rawId = await store.writeRawMemory("L1", `## Raw Memory\n\n${text}`, ["[[Odyssey/Conversations/2026/05/2026-05-13]]"], ["Odyssey"]);
      await store.writeMemorySummary("L1", text, [store.recordAnchor("L1", rawId)], ["Odyssey"], "high");
    }
    await store.writeReference("notes/project.md", "Old Odyssey note", "Old Odyssey note material.");

    const index = new LocalIndex(store);
    await index.rebuild();
    const retrieval = new RetrievalService(index);

    expect(retrieval.search("How is Odyssey designed?").some(item => item.memory.type === "reference")).toBe(false);
    expect(retrieval.search("Find Odyssey in my Obsidian notes.").some(item => item.memory.type === "reference")).toBe(true);
  });

  it("extracts conservative memories after an explicit memory request", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { MemoryExtractor } = await import("../src/memory/memory-extractor");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const extractor = new MemoryExtractor(store);

    const rejected = await extractor.extract({
      conversationPath: "Odyssey/Conversations/2026/05/2026-05-13.md",
      userMessage: "Diagnose whether I have a personality disorder."
    });
    expect(rejected.rawMemoryIds).toEqual([]);

    const result = await extractor.extract({
      conversationPath: "Odyssey/Conversations/2026/05/2026-05-13.md",
      userMessage: "Remember: during my second year of college, I first wanted to build an open-source project."
    });
    expect(result.rawMemoryIds.length).toBe(1);
    expect(result.summaryIds.length).toBe(1);
    const raw = Array.from(vault.files.values()).find(entry => entry.file.path.includes(result.rawMemoryIds[0]));
    expect(raw?.content).toContain("explicit_memory_request");
    expect(raw?.content).toContain("user_marked_important");
  });

  it("extracts short education facts without requiring an explicit remember command", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { MemoryExtractor } = await import("../src/memory/memory-extractor");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const extractor = new MemoryExtractor(store);

    const result = await extractor.extract({
      conversationPath: "Odyssey/Conversations/2026/05/2026-05-16.md",
      userMessage: "My university was Sample University, and my major was communications engineering."
    });

    expect(result.rawMemoryIds.length).toBe(1);
    expect(result.summaryIds.length).toBe(1);
    const raw = Array.from(vault.files.values()).find(entry => entry.file.path.includes(result.rawMemoryIds[0]));
    expect(raw?.content).toContain("Sample University");
    expect(raw?.content).toContain("communications engineering");
  });

  it("keeps model-extracted memories in L1 during MVP automatic extraction", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { MemoryExtractor } = await import("../src/memory/memory-extractor");
    const { parseMarkdown } = await import("../src/utils/frontmatter");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();
    const modelGateway = {
      complete: async () => ({
        content: JSON.stringify({
          raw_memories: [
            {
              content: "The user's university was Sample University and their major was communications engineering.",
              level: "L1",
              tags: ["university", "major"],
              confidence: "high"
            }
          ],
          summaries: [
            {
              content: "The user's university and major.",
              kind: "important_fact",
              confidence: "high"
            }
          ]
        }),
        outputLimited: false
      })
    };
    const extractor = new MemoryExtractor(store, modelGateway as any);

    const result = await extractor.extract({
      conversationPath: "Odyssey/Conversations/2026/05/2026-05-16.md",
      userMessage: "My university was Sample University, and my major was communications engineering."
    });

    const summaryEntry = Array.from(vault.files.values()).find(entry => entry.file.path.includes(result.summaryIds[0]));
    const parsed = parseMarkdown(summaryEntry?.content ?? "");
    const rawEntry = Array.from(vault.files.values()).find(entry => entry.file.path.includes(result.rawMemoryIds[0]));
    const parsedRaw = parseMarkdown(rawEntry?.content ?? "");
    expect(rawEntry?.file.path).toContain("Odyssey/L1_");
    expect(summaryEntry?.file.path).toContain("Odyssey/L1_");
    expect(parsedRaw.frontmatter.level).toBe("L1");
    expect(parsed.frontmatter.level).toBe("L1");
    expect(parsed.frontmatter.anchors).toEqual(expect.arrayContaining([
      expect.stringContaining("Odyssey/L1_")
    ]));
    expect(parsed.frontmatter.anchors).not.toEqual(expect.arrayContaining([
      expect.stringContaining("Odyssey/L3_")
    ]));
  });

  it("exports the current chat into an Obsidian-compatible markdown note", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { parseMarkdown } = await import("../src/utils/frontmatter");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    const path = await store.writeConversationExport([
      { role: "user", content: "I want to organize this into a note.", created: "2026-05-14T10:00:00.000Z" },
      { role: "assistant", content: "Okay, we can preserve its source.", created: "2026-05-14T10:00:10.000Z" }
    ]);

    expect(path).toMatch(/^Odyssey\/Exports\/\d{4}-\d{2}-\d{2}-export_/);
    const parsed = parseMarkdown(vault.files.get(path)?.content ?? "");
    expect(parsed.frontmatter.type).toBe("export_bundle");
    expect(parsed.frontmatter.anchors).toEqual(["[[Odyssey/Conversations/2026/05/2026-05-14.md]]"]);
    expect(parsed.body).toContain("I want to organize this into a note.");
    expect(parsed.body).toContain("Okay, we can preserve its source.");
    expect(parsed.body).toContain("[[Odyssey/Conversations/2026/05/2026-05-14.md]]");
  });

  it("writes local alignment feedback without promoting it to memory", async () => {
    const { MarkdownStore } = await import("../src/store/markdown-store");
    const { parseMarkdown } = await import("../src/utils/frontmatter");
    const store = new MarkdownStore({ vault } as any, DEFAULT_SETTINGS);
    await store.ensureInitialized();

    const id = await store.writeFeedback("alignment_test", "How would you choose in my place?", "I would start with the long-term goal.", "Close, but too generic.");
    const entry = Array.from(vault.files.values()).find(item => item.file.path.includes(id));

    expect(entry?.file.path).toContain("Odyssey/Feedback/");
    const parsed = parseMarkdown(entry?.content ?? "");
    expect(parsed.frontmatter.type).toBe("feedback");
    expect(parsed.frontmatter.tags).toEqual(["feedback", "alignment_test"]);
    expect(parsed.body).toContain("Close, but too generic.");
  });
});
