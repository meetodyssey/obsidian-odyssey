import { normalizePath, TFile } from "obsidian";
import { DEFAULT_RETRIEVAL_WEIGHTS, IndexedDocument, IndexedMemory, LocalIndexData, RebuildIndexResult, RetrievalWeights, ShadowIndexEntry } from "../types";
import { parseMarkdown } from "../utils/frontmatter";
import { firstNonEmptyLine } from "../utils/text";
import { nowIso } from "../utils/time";
import { MarkdownStore } from "../store/markdown-store";
import { ShadowIndexStore } from "./shadow-index-store";

export class LocalIndex {
  private data: LocalIndexData = { documents: [], memories: [], rebuiltAt: nowIso() };
  private weights: RetrievalWeights;

  constructor(private readonly store: MarkdownStore, private readonly shadow?: ShadowIndexStore, weights?: RetrievalWeights) {
    this.weights = weights ?? { ...DEFAULT_RETRIEVAL_WEIGHTS };
  }

  get documents(): IndexedDocument[] {
    return this.data.documents;
  }

  get memories(): IndexedMemory[] {
    return this.data.memories;
  }

  async load(): Promise<void> {
    const raw = await this.store.readFile(this.store.path("Index/memory-index.json"));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<LocalIndexData>;
      this.data = {
        documents: parsed.documents ?? [],
        memories: (parsed.memories ?? []).map(normalizeLoadedMemory),
        rebuiltAt: parsed.rebuiltAt ?? nowIso()
      };
    } catch {
      this.data = { documents: [], memories: [], rebuiltAt: nowIso() };
    }
    if (this.shadow) {
      const shadow = await this.shadow.load();
      this.data.memories = this.data.memories.map(memory => this.applyShadow(memory, shadow.entries[memory.id]));
    }
  }

  async rebuild(): Promise<RebuildIndexResult> {
    const files = await this.store.listMarkdownFiles();
    const documents: IndexedDocument[] = [];
    const memories: IndexedMemory[] = [];
    const shadowEntries: ShadowIndexEntry[] = [];
    for (const file of files) {
      if (file.path.includes("/Index/")) continue;
      if (file.path.includes("/Prompts/")) continue;
      try {
        const indexed = await this.indexFile(file);
        documents.push(indexed.document);
        if (indexed.memory) {
          memories.push(indexed.memory);
        }
      } catch {
        // skip files that fail to index
      }
    }
    applyCorrections(memories);
    for (const memory of memories) shadowEntries.push(this.buildShadowEntry(memory));
    this.data = { documents, memories, rebuiltAt: nowIso() };
    if (this.shadow) await this.shadow.replaceEntries(shadowEntries);
    await this.persist();
    return { documentCount: documents.length, memoryCount: memories.length, shadowEntryCount: shadowEntries.length };
  }

  async refreshPaths(paths: string[]): Promise<RebuildIndexResult> {
    const normalizedPaths = Array.from(new Set(paths.map(path => normalizePath(path.trim())).filter(Boolean)));
    if (normalizedPaths.length === 0) {
      return { documentCount: this.data.documents.length, memoryCount: this.data.memories.length, shadowEntryCount: this.shadow?.entryCount };
    }

    const changedDocuments: IndexedDocument[] = [];
    const changedMemories: IndexedMemory[] = [];
    for (const path of normalizedPaths) {
      if (path.includes("/Index/")) continue;
      if (path.includes("/Prompts/")) continue;
      const file = this.store.getFile(path);
      this.data.documents = this.data.documents.filter(document => document.path !== path);
      this.data.memories = this.data.memories.filter(memory => memory.path !== path);
      if (!file) continue;
      const indexed = await this.indexFile(file);
      changedDocuments.push(indexed.document);
      if (indexed.memory) changedMemories.push(indexed.memory);
    }

    this.data.documents.push(...changedDocuments);
    this.data.memories.push(...changedMemories);
    applyCorrections(this.data.memories);
    this.data.rebuiltAt = nowIso();
    if (this.shadow) {
      await this.shadow.replaceEntries(this.data.memories.map(memory => this.buildShadowEntry(memory)));
    }
    await this.persist();
    return { documentCount: this.data.documents.length, memoryCount: this.data.memories.length, shadowEntryCount: this.shadow?.entryCount };
  }

  async persist(): Promise<void> {
    const data = JSON.stringify({
      documents: this.data.documents,
      memories: this.data.memories.map(toPublicMemory),
      rebuiltAt: this.data.rebuiltAt
    }, null, 2);
    await this.writeIndexFile("memory-index.json", data);
    await this.writeIndexFile("document-index.json", JSON.stringify({
      documents: this.data.documents,
      rebuiltAt: this.data.rebuiltAt
    }, null, 2));
  }

  markSuperseded(memoryId: string, correctionId: string): void {
    for (const memory of this.data.memories) {
      if (memory.id === memoryId || memory.path.includes(memoryId)) {
        memory.status = "superseded";
        memory.correctionLinks = Array.from(new Set([...memory.correctionLinks, correctionId]));
      }
    }
  }

  async hasUnappliedCorrections(store: { listMarkdownFiles: () => Promise<TFile[]> }): Promise<boolean> {
    // If the index is empty, there's nothing to apply corrections to.
    if (this.data.memories.length === 0) return false;
    const correctionIds = new Set(
      this.data.memories
        .filter(m => m.type === "correction" && m.status === "active")
        .map(m => m.id)
    );
    // Quick check: scan the Corrections directory for files not yet in the index.
    const allFiles = await store.listMarkdownFiles();
    for (const file of allFiles) {
      if (!file.path.includes("/Corrections/")) continue;
      const id = file.basename;
      if (!correctionIds.has(id)) return true;
    }
    return false;
  }

  private async indexFile(file: TFile): Promise<{ document: IndexedDocument; memory?: IndexedMemory }> {
    const content = await this.store.readFile(file.path);
    const parsed = parseMarkdown(content);
    const fm = parsed.frontmatter;
    const title = firstNonEmptyLine(parsed.body).replace(/^#+\s*/, "") || file.basename;
    const summary = extractSummary(parsed.body);
    const tags = asArray(fm.tags);
    const type = typeof fm.type === "string" ? fm.type as IndexedDocument["type"] : undefined;
    const level = typeof fm.level === "string" ? fm.level as IndexedDocument["level"] : undefined;
    const document: IndexedDocument = {
      path: file.path,
      title,
      type,
      level,
      created: typeof fm.created === "string" ? fm.created : undefined,
      updated: file.stat.mtime ? new Date(file.stat.mtime).toISOString() : undefined,
      tags,
      summary
    };
    if (!type || !["raw_memory", "memory_summary", "correction", "reference", "export_bundle", "feedback"].includes(type)) {
      return { document };
    }
    const id = typeof fm.id === "string" ? fm.id : file.basename;
    const memory: IndexedMemory = {
      ...document,
      id,
      status: typeof fm.status === "string" ? fm.status as IndexedMemory["status"] : "active",
      source: asArray(fm.source),
      anchors: asArray(fm.anchors),
      correctionLinks: [...asArray(fm.corrects), ...asArray(fm.superseded_by)],
      entities: asArray(fm.entities),
      confidence: typeof fm.confidence === "string" ? fm.confidence as IndexedMemory["confidence"] : undefined,
      summaryKind: typeof fm.summary_kind === "string" ? fm.summary_kind : undefined,
      priority: defaultPriority(type)
    };
    return { document, memory };
  }

  private applyShadow(memory: IndexedMemory, shadow?: ShadowIndexEntry): IndexedMemory {
    if (!shadow) return { ...memory, priority: memory.priority ?? defaultPriority(memory.type) };
    return {
      ...memory,
      priority: shadow.retrievalWeight >= 80 ? "high" : shadow.retrievalWeight >= 45 ? "normal" : "low",
      correctionLinks: Array.from(new Set([...memory.correctionLinks, ...shadow.correctionLinks])),
      status: shadow.status ?? memory.status
    };
  }

  private buildShadowEntry(memory: IndexedMemory): ShadowIndexEntry {
    return {
      id: memory.id,
      path: memory.path,
      type: memory.type,
      level: memory.level,
      sourceAnchors: [...memory.source, ...memory.anchors],
      internalTags: Array.from(new Set([...memory.tags, ...(memory.entities ?? [])])),
      intentCategories: inferIntentCategories(memory),
      retrievalWeight: this.retrievalWeight(memory),
      rankingBoost: this.rankingBoost(memory),
      correctionLinks: memory.correctionLinks,
      sourceRange: { path: memory.path },
      status: memory.status,
      updatedAt: nowIso()
    };
  }

  private async writeIndexFile(name: string, content: string): Promise<void> {
    const path = this.store.path(`Index/${name}`);
    await this.store.writeTextFile(path, content);
  }

  private retrievalWeight(memory: IndexedMemory): number {
    const w = this.weights;
    let weight = w.baseWeight;
    if (memory.type === "correction") weight += w.correctionBoost;
    if (memory.type === "memory_summary") weight += w.memorySummaryBoost;
    if (memory.type === "reference") weight += w.referenceBoost;
    if (memory.level === "L1") weight += w.l1Boost;
    if (memory.status === "superseded") weight -= w.supersededPenalty;
    return Math.max(0, Math.min(100, weight));
  }

  private rankingBoost(memory: IndexedMemory): number {
    const w = this.weights;
    if (memory.type === "correction") return w.rankingCorrectionBoost;
    if (memory.type === "memory_summary") return w.rankingSummaryBoost;
    if (memory.type === "reference") return w.rankingReferenceBoost;
    return 0;
  }
}

function toPublicMemory(memory: IndexedMemory): IndexedMemory {
  const {
    priority: _priority,
    lastReferenced: _lastReferenced,
    correctionLinks: _correctionLinks,
    ...publicMemory
  } = memory;
  return publicMemory as IndexedMemory;
}

function normalizeLoadedMemory(memory: IndexedMemory): IndexedMemory {
  return {
    ...memory,
    tags: memory.tags ?? [],
    source: memory.source ?? [],
    anchors: memory.anchors ?? [],
    correctionLinks: memory.correctionLinks ?? [],
    entities: memory.entities ?? [],
    status: memory.status ?? "active"
  };
}

function applyCorrections(memories: IndexedMemory[]): void {
  const corrections = memories.filter(memory => memory.type === "correction" && memory.status === "active");
  for (const correction of corrections) {
    for (const target of correction.correctionLinks) {
      const targetId = extractAnchorId(target);
      for (const memory of memories) {
        if (memory.id === correction.id || memory.type === "correction") continue;
        if (memory.id === targetId || target.includes(memory.id) || target.includes(memory.path)) {
          memory.status = "superseded";
          memory.correctionLinks = Array.from(new Set([...memory.correctionLinks, correction.id]));
        }
      }
    }
  }
}

function extractAnchorId(anchor: string): string {
  const match = anchor.match(/#([^\]]+)\]\]$/);
  return match?.[1] ?? "";
}

function defaultPriority(type?: string): IndexedMemory["priority"] {
  if (type === "memory_summary") return "high";
  if (type === "correction") return "high";
  if (type === "reference") return "low";
  return undefined;
}

function inferIntentCategories(memory: IndexedMemory): string[] {
  const haystack = `${memory.title}\n${memory.summary}\n${memory.tags.join(" ")}`;
  const categories: string[] = [];
  if (/修正|不准确|不是/.test(haystack) || memory.type === "correction") categories.push("correction");
  if (/以前|过去|去年|小时候|\d{4}/.test(haystack)) categories.push("recall_time");
  if (/资料|笔记|文档|reference|obsidian/i.test(haystack) || memory.type === "reference") categories.push("reference_lookup");
  if (memory.type === "memory_summary") categories.push("summary_recall");
  return categories;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function extractSummary(body: string): string {
  const normalized = body.replace(/\r?\n/g, "\n").trim();
  const summaryMatch = normalized.match(/##\s*(摘要|Summary|Observation)\s*\n+([\s\S]*?)(\n##\s+|$)/i);
  if (summaryMatch) return summaryMatch[2].trim().slice(0, 500);
  return normalized.slice(0, 500);
}
