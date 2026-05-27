import { App, normalizePath, TFile } from "obsidian";
import { createHash } from "crypto";
import { AgentRecordMeta, ChatMessage, OdysseySettings, RecordLevel } from "../types";
import { dateParts, dateStamp, nowIso, weekStamp } from "../utils/time";
import { makeId } from "../utils/ids";
import { renderMarkdown } from "../utils/frontmatter";

export interface WriteRecordInput {
  meta: AgentRecordMeta;
  body: string;
}

export class MarkdownStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly app: App, private readonly settings: OdysseySettings) {}

  get root(): string {
    return normalizePath(this.settings.rootDir || "Odyssey");
  }

  async ensureInitialized(): Promise<void> {
    await this.migrateLegacyRootIfNeeded();
    const dirs = [
      this.root,
      this.path("Conversations"),
      this.path("L1_Recent_Memory"),
      this.path("Corrections"),
      this.path("References"),
      this.path("Exports"),
      this.path("Feedback"),
      this.path("Index")
    ];
    for (const dir of dirs) await this.ensureFolder(dir);
    await this.ensureFile(this.path("Index/document-index.json"), JSON.stringify({ documents: [], rebuiltAt: nowIso() }, null, 2));
    await this.ensureFile(this.path("Index/memory-index.json"), JSON.stringify({ memories: [], rebuiltAt: nowIso() }, null, 2));
  }

  async appendConversationMessage(message: ChatMessage): Promise<string> {
    const path = this.conversationPath();
    const role = message.role === "user" ? (this.settings.userAvatar || "User") : message.role === "assistant" ? this.settings.odysseyName : "System";
    const created = message.created ?? nowIso();
    const block = `\n\n## ${created} ${role}\n\n${message.content.trim()}\n`;
    await this.appendFile(path, block, `# ${dateStamp()}\n`);
    return path;
  }

  async readRecentConversationMessages(limit = 80): Promise<ChatMessage[]> {
    const prefix = this.path("Conversations/");
    const files = this.app.vault.getMarkdownFiles()
      .filter(file => normalizePath(file.path).startsWith(prefix))
      .sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)));
    const messages: ChatMessage[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      messages.push(...this.parseConversationMessages(content));
    }
    return messages.slice(-limit);
  }

  async readConversationMessagesForDate(date: string): Promise<{ path: string; messages: ChatMessage[] } | null> {
    const [year, month] = date.split("-");
    if (!year || !month) return null;
    const path = this.path(`Conversations/${year}/${month}/${date}.md`);
    const content = await this.readFile(path);
    if (!content.trim()) return null;
    return { path, messages: this.parseConversationMessages(content) };
  }

  async writeRawMemory(level: Exclude<RecordLevel, "L0">, body: string, source: string[], tags: string[] = []): Promise<string> {
    const id = makeId("mem");
    const meta: AgentRecordMeta = {
      id,
      type: "raw_memory",
      level,
      created: nowIso(),
      source,
      tags,
      entities: ["user"],
      confidence: "medium",
      status: "active",
      superseded_by: []
    };
    const path = this.recordPath(level, id);
    await this.writeRecord(path, { meta, body });
    return id;
  }

  rawMemoryPath(level: Exclude<RecordLevel, "L0">, id: string): string {
    return this.recordPath(level, id);
  }

  async writeMemorySummary(level: Exclude<RecordLevel, "L0">, summary: string, anchors: string[], tags: string[] = [], _priority: "low" | "normal" | "high" = "high"): Promise<string> {
    const normalizedAnchors = Array.from(new Set(anchors.map(anchor => anchor.trim()).filter(Boolean)));
    if (normalizedAnchors.length === 0) {
      throw new Error("memory_summary requires at least one raw memory or source anchor");
    }
    const id = makeId("sum");
    const meta: AgentRecordMeta = {
      id,
      type: "memory_summary",
      level,
      created: nowIso(),
      anchors: normalizedAnchors,
      tags,
      entities: ["user"],
      confidence: "medium",
      status: "active",
      summary_kind: "summary",
      superseded_by: []
    };
    const path = this.recordPath(level, id);
    await this.writeRecord(path, {
      meta,
      body: `## Summary\n\n${summary.trim()}\n\n## Memory Anchors\n\n${normalizedAnchors.map(anchor => `- ${anchor}`).join("\n")}`
    });
    return id;
  }

  memorySummaryPath(level: Exclude<RecordLevel, "L0">, id: string): string {
    return this.recordPath(level, id);
  }

  async writeCorrection(corrects: string[], correctedUnderstanding: string, reason: string, confirmationContext: string): Promise<string> {
    const id = makeId("corr");
    const meta: AgentRecordMeta = {
      id,
      type: "correction",
      created: nowIso(),
      corrects,
      status: "active",
      confidence: "medium"
    };
    const path = this.correctionPath(id);
    await this.writeRecord(path, {
      meta,
      body: `## Corrected Understanding\n\n${correctedUnderstanding.trim()}\n\n## Reason\n\n${reason.trim()}\n\n## Confirmation Context\n\n${confirmationContext.trim()}`
    });
    return id;
  }

  correctionRecordPath(id: string): string {
    return this.correctionPath(id);
  }

  async writeReference(sourcePath: string, title: string, summary: string, tags: string[] = []): Promise<string> {
    const id = `ref_${stableId(sourcePath)}`;
    const meta: AgentRecordMeta = {
      id,
      type: "reference",
      created: nowIso(),
      source: [this.anchorFor(sourcePath)],
      tags: Array.from(new Set(["reference", ...tags])).slice(0, 12),
      entities: [],
      confidence: "low",
      status: "active"
    };
    const path = this.path(`References/${id}.md`);
    await this.writeRecord(path, {
      meta,
      body: `# ${title.trim() || sourcePath}\n\n## Summary\n\n${summary.trim()}\n\n## Source Anchor\n\n- ${this.anchorFor(sourcePath)}`
    });
    return id;
  }

  referencePath(id: string): string {
    return this.path(`References/${id}.md`);
  }

  async writeConversationExport(messages: ChatMessage[], title = "聊天整理笔记"): Promise<string> {
    const id = makeId("export");
    const anchors = Array.from(new Set(messages.map(message => this.conversationAnchorFromCreated(message.created)).filter(Boolean)));
    const meta: AgentRecordMeta = {
      id,
      type: "export_bundle",
      created: nowIso(),
      source: anchors.length ? anchors : ["Odyssey 当前聊天窗口"],
      anchors,
      tags: ["odyssey-export"],
      entities: ["user"],
      confidence: "medium",
      status: "active"
    };
    const body = [
      `# ${title}`,
      "",
      "## Sources",
      "",
      ...(anchors.length ? anchors.map(anchor => `- ${anchor}`) : ["- Odyssey chat window"]),
      "",
      "## Content",
      "",
      ...messages.map(message => {
        const role = message.role === "user" ? "我" : message.role === "assistant" ? this.settings.odysseyName : "系统";
        return `### ${role} ${message.created ?? ""}\n\n${message.content.trim()}`;
      })
    ].join("\n");
    const path = this.path(`Exports/${dateStamp()}-${id}.md`);
    await this.writeRecord(path, { meta, body });
    return path;
  }

  async writeFeedback(kind: string, prompt: string, response: string, feedback: string, anchors: string[] = []): Promise<string> {
    const id = makeId("fb");
    const meta: AgentRecordMeta = {
      id,
      type: "feedback",
      created: nowIso(),
      source: anchors,
      anchors,
      tags: ["feedback", kind],
      entities: ["user"],
      confidence: "low",
      status: "active"
    };
    const path = this.path(`Feedback/${id}.md`);
    await this.writeRecord(path, {
      meta,
      body: [
        `# ${kind}`,
        "",
        "## Prompt",
        "",
        prompt.trim(),
        "",
        "## Odyssey Response",
        "",
        response.trim(),
        "",
        "## Feedback",
        "",
        feedback.trim()
      ].join("\n")
    });
    return id;
  }

  async readFile(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) return this.app.vault.read(file);
    // Fall back to adapter read when the vault file cache is cold
    try { return await this.app.vault.adapter.read(normalizePath(path)); } catch { return ""; }
  }

  getFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? file : null;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureParent(path);
      const normalized = normalizePath(path);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content);
      } else {
        await this.createOrModify(normalized, content);
      }
    });
  }

  async listMarkdownFiles(): Promise<TFile[]> {
    const rootPrefix = `${this.root}/`;
    const allFiles = this.getAllMarkdownFiles();
    const cached = allFiles.filter(file => normalizePath(file.path).startsWith(rootPrefix));
    if (cached.length > 0) return cached;
    // Vault file cache may be cold during early plugin init — use adapter directly
    return this.listMarkdownFilesViaAdapter(rootPrefix);
  }

  private async listMarkdownFilesViaAdapter(prefix: string): Promise<TFile[]> {
    const result: TFile[] = [];
    const adapter = this.app.vault.adapter;
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let listed: { files: string[]; folders: string[] };
      try { listed = await adapter.list(dir); } catch { continue; }
      for (const filePath of listed.files) {
        if (!filePath.endsWith(".md")) continue;
        const tfile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
        if (tfile instanceof TFile) { result.push(tfile); continue; }
        // Build a minimal TFile so callers can read via adapter fallback
        let mtime = 0;
        let size = 0;
        try { const s = await adapter.stat(filePath); mtime = s?.mtime ?? 0; size = (s as any)?.size ?? 0; } catch { /* ignore */ }
        result.push({
          path: filePath,
          basename: filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "",
          extension: "md",
          parent: null as any,
          vault: this.app.vault,
          stat: { ctime: 0, mtime, size }
        } as unknown as TFile);
      }
      for (const sub of listed.folders) stack.push(sub);
    }
    return result;
  }

  async listReferenceCandidateFiles(): Promise<TFile[]> {
    const rootPrefix = `${this.root}/`;
    return this.getAllMarkdownFiles().filter(file => {
      const path = normalizePath(file.path);
      if (path.startsWith(rootPrefix)) return false;
      if (path.startsWith(`${this.settings.shadowIndexDir}/`)) return false;
      if (path.startsWith(".obsidian/")) return false;
      return true;
    });
  }

  conversationPath(date = new Date()): string {
    const { year, month } = dateParts(date);
    return this.path(`Conversations/${year}/${month}/${dateStamp(date)}.md`);
  }

  path(child: string): string {
    return normalizePath(`${this.root}/${child}`);
  }

  anchorFor(path: string, id?: string): string {
    return id ? `[[${path}#${id}]]` : `[[${path}]]`;
  }

  recordAnchor(level: Exclude<RecordLevel, "L0">, id: string): string {
    return this.anchorFor(this.recordPath(level, id), id);
  }

  private recordPath(level: Exclude<RecordLevel, "L0">, id: string): string {
    const { year, month } = dateParts();
    return this.path(`L1_Recent_Memory/${year}/${month}/${id}.md`);
  }

  private correctionPath(id: string): string {
    const { year, month } = dateParts();
    return this.path(`Corrections/${year}/${month}/${id}.md`);
  }

  private conversationAnchorFromCreated(created?: string): string {
    if (!created) return "";
    const date = new Date(created);
    if (Number.isNaN(date.getTime())) return "";
    return this.anchorFor(this.conversationPath(date));
  }

  private parseConversationMessages(content: string): ChatMessage[] {
    const headingPattern = /^##\s+(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.+)$/gm;
    const headings: Array<{ created: string; label: string; start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(content)) !== null) {
      headings.push({
        created: match[1],
        label: match[2].trim(),
        start: match.index,
        end: headingPattern.lastIndex
      });
    }
    return headings
      .map((heading, index): ChatMessage | null => {
        const next = headings[index + 1]?.start ?? content.length;
        const body = content.slice(heading.end, next).trim();
        if (!body) return null;
        return {
          role: this.roleFromConversationLabel(heading.label),
          content: body,
          created: heading.created
        };
      })
      .filter((message): message is ChatMessage => Boolean(message));
  }

  private roleFromConversationLabel(label: string): ChatMessage["role"] {
    const normalized = label.trim().toLowerCase();
    if (["用户", "我", "user", "me"].includes(normalized)) return "user";
    if (["系统", "system"].includes(normalized)) return "system";
    return "assistant";
  }

  private async writeRecord(path: string, input: WriteRecordInput): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureParent(path);
      await this.createOrModify(normalizePath(path), renderMarkdown(input.meta as unknown as Record<string, unknown>, input.body));
    });
  }

  private async appendFile(path: string, content: string, initial = ""): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureParent(path);
      const normalized = normalizePath(path);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) {
        const old = await this.app.vault.read(file);
        await this.app.vault.modify(file, old + content);
      } else {
        await this.createOrModify(normalized, initial + content.trimStart());
      }
    });
  }

  private async ensureFile(path: string, content: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const normalized = normalizePath(path);
      if (await this.app.vault.adapter.exists(normalized)) return;
      await this.ensureParent(normalized);
      await this.createOrModify(normalized, content);
    });
  }

  private async ensureParent(path: string): Promise<void> {
    const idx = normalizePath(path).lastIndexOf("/");
    if (idx > 0) await this.ensureFolder(path.slice(0, idx));
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalized)) return;
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    try {
      await this.app.vault.createFolder(normalized);
    } catch (error) {
      if (isAlreadyExistsError(error)) return;
      if (await this.app.vault.adapter.exists(normalized)) return;
      if (this.app.vault.getAbstractFileByPath(normalized)) return;
      throw error;
    }
  }

  private async migrateLegacyRootIfNeeded(): Promise<void> {
    const currentRoot = normalizePath(this.root);
    const legacyRoot = normalizePath("DigitalSelf");
    if (currentRoot !== "Odyssey") return;
    if (await this.app.vault.adapter.exists(currentRoot)) return;
    if (!(await this.app.vault.adapter.exists(legacyRoot))) return;

    const adapter = this.app.vault.adapter as unknown as { rename?: (from: string, to: string) => Promise<void> };
    if (typeof adapter.rename === "function") {
      await adapter.rename(legacyRoot, currentRoot);
      return;
    }

    const legacyFolder = this.app.vault.getAbstractFileByPath(legacyRoot);
    const vault = this.app.vault as unknown as { rename?: (file: unknown, path: string) => Promise<void> };
    if (legacyFolder && typeof vault.rename === "function") {
      await vault.rename(legacyFolder, currentRoot);
    }
  }

  private async createOrModify(path: string, content: string): Promise<void> {
    try {
      await this.app.vault.create(path, content);
    } catch (error) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content);
        return;
      }
      if (isAlreadyExistsError(error)) {
        await this.app.vault.adapter.write(path, content);
        return;
      }
      throw error;
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private getAllMarkdownFiles(): TFile[] {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const getFiles = (this.app.vault as unknown as { getFiles?: () => TFile[] }).getFiles;
    const fallbackFiles: TFile[] = typeof getFiles === "function"
      ? getFiles.call(this.app.vault).filter((file: TFile) => isMarkdownFile(file))
      : [];
    const files = markdownFiles.length > 0 ? markdownFiles : fallbackFiles;
    const byPath = new Map<string, TFile>();
    for (const file of files) byPath.set(normalizePath(file.path), file);
    return Array.from(byPath.values());
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

function isMarkdownFile(file: TFile): boolean {
  const path = normalizePath(file.path).toLowerCase();
  return path.endsWith(".md") || file.extension === "md" || file.extension === "markdown";
}

function stableId(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").slice(0, 12);
}
