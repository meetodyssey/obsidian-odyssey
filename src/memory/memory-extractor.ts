import { ExtractMemoryInput, ExtractMemoryResult, ChatMessage } from "../types";
import { MarkdownStore } from "../store/markdown-store";
import { ModelGateway } from "../model/model-gateway";
import { extractKeywords, includesAny } from "../utils/text";

interface ExtractedRawMemory {
  content: string;
  level: "L1";
  tags: string[];
  confidence: "low" | "medium" | "high";
}

interface ExtractedSummary {
  content: string;
  kind: "recent_context" | "important_fact" | "pattern";
  confidence: "low" | "medium" | "high";
}

interface ExtractionOutput {
  raw_memories: ExtractedRawMemory[];
  summaries: ExtractedSummary[];
}

export class MemoryExtractor {
  constructor(
    private readonly store: MarkdownStore,
    private readonly modelGateway?: ModelGateway
  ) {}

  async extract(input: ExtractMemoryInput): Promise<ExtractMemoryResult> {
    const result: ExtractMemoryResult = {
      rawMemoryIds: [],
      summaryIds: [],
      correctionIds: [],
      changedPaths: []
    };

    const shouldRemember = input.consolidationMode === "l0_window" || this.shouldExtract(input.userMessage, input.recentMessages ?? []);
    if (!shouldRemember) return result;
    if (!input.conversationPath.trim()) return result;

    const anchor = this.store.anchorFor(input.conversationPath);
    if (!anchor) return result;

    if (this.isUnsafeInference(input.userMessage)) return result;

    if (this.modelGateway && !input.forceRuleBased) {
      try {
        const output = await this.callModelForExtraction(input);
        return this.processExtractionOutput(output, anchor, input);
      } catch (error) {
        console.warn("Memory Extractor model call failed, falling back to rule-based extraction", error);
      }
    }

    return this.ruleBasedExtract(input, anchor);
  }

  private async callModelForExtraction(input: ExtractMemoryInput): Promise<ExtractionOutput> {
    const messages = this.buildExtractionMessages(input);
    const completion = await this.modelGateway!.complete("extract_memory", messages);
    return this.parseExtractionResponse(completion.content);
  }

  private buildExtractionMessages(input: ExtractMemoryInput): ChatMessage[] {
    const recentContext = this.l0WindowMessages(input)
      .map(msg => `${msg.role === "user" ? "User" : "Odyssey"}: ${msg.content}`)
      .join("\n\n");

    const systemPrompt = [
      "You are the Odyssey memory extractor. Extract key user information from conversations for long-term memory.",
      input.consolidationMode === "l0_window"
        ? "This is L0 window consolidation: preserve the user's own words from the full L0 window as L1 raw memory, then create concise L1 summaries anchored to that raw memory. Do not treat the final turn as the whole memory."
        : "This is single-turn consolidation triggered by an explicit memory request, a long message, or a correction.",
      "",
      "Core principles:",
      "- Err on the side of extracting less. When uncertain, skip.",
      "- Only extract facts, preferences, emotions, and events the user explicitly expressed.",
      "- Never extract user facts from Odyssey replies — those may contain inferences or hallucinations.",
      "- Never add details the user didn't say. If the user said 'I was a moderator,' do not extract 'the user set a hands-off moderation policy' — that is fabrication.",
      "- In l0_window mode, raw_memories.content should cover the meaningful user-authored material across the window, using compact excerpts or close paraphrase. In turn mode, it may focus on the current user message.",
      "- When a fragment refers to an action or emotion whose subject was clarified in a nearby message (e.g., a classmate, a family member, a colleague), include the subject explicitly in the extracted content. Do not extract pronouns or subject-ambiguous sentences without their referent.",
      "- If the user explicitly says to remember, note this as an importance signal. It does not mean Odyssey only remembers then; it means the item should be tagged and weighted as explicitly important.",
      "- Never diagnose. Never label the user.",
      "- Default confidence to low or medium. Only use high for long-term facts the user has repeatedly and clearly stated.",
      "- Write policy: automatic extraction writes raw memories and summaries to L1 only.",
      "",
      "Output pure JSON (no markdown code fences):",
      "{",
      '  "raw_memories": [',
      '    {"content": "verbatim fact fragment from the user", "level": "L1", "tags": ["tag"], "confidence": "medium"}',
      "  ],",
      '  "summaries": [',
      '    {"content": "one-sentence summary", "kind": "recent_context", "confidence": "medium"}',
      "  ]",
      "}",
      "",
      "Field notes:",
      "- raw_memories.level: always L1 in MVP automatic extraction.",
      "- summaries.kind: recent_context | important_fact | pattern.",
      "- If nothing is worth extracting this round, return empty arrays."
    ].join("\n");

    const userPrompt = [
      input.consolidationMode === "l0_window"
        ? "Consolidate the following L0 working-memory window into L1 memory candidates."
        : "Extract memory candidates from the following conversation.",
      "",
      "Current user message:",
      input.userMessage,
      "",
      input.assistantMessage ? `Odyssey reply:\n${input.assistantMessage.slice(0, 1200)}` : "",
      "",
      recentContext ? `Recent conversation context:\n${recentContext}` : ""
    ].filter(Boolean).join("\n");

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];
  }

  private parseExtractionResponse(content: string): ExtractionOutput {
    const trimmed = content.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Memory Extractor response did not contain valid JSON");
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const raw_memories = this.validateRawMemories(parsed.raw_memories);
    const summaries = this.validateSummaries(parsed.summaries);

    return { raw_memories, summaries };
  }

  private validateRawMemories(raw: unknown): ExtractedRawMemory[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(item => ({
        content: typeof item.content === "string" ? item.content.trim() : "",
        level: "L1" as const,
        tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 6) : [],
        confidence: ["low", "medium", "high"].includes(String(item.confidence)) ? item.confidence as ExtractedRawMemory["confidence"] : "medium"
      }))
      .filter(item => item.content.length >= 8);
  }

  private validateSummaries(raw: unknown): ExtractedSummary[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(item => ({
        content: typeof item.content === "string" ? item.content.trim() : "",
        kind: ["recent_context", "important_fact", "pattern"].includes(String(item.kind))
          ? item.kind as ExtractedSummary["kind"] : "recent_context",
        confidence: ["low", "medium", "high"].includes(String(item.confidence)) ? item.confidence as ExtractedSummary["confidence"] : "medium"
      }))
      .filter(item => item.content.length >= 8);
  }

  private async processExtractionOutput(
    output: ExtractionOutput,
    conversationAnchor: string,
    input: ExtractMemoryInput
  ): Promise<ExtractMemoryResult> {
    const result: ExtractMemoryResult = {
      rawMemoryIds: [],
      summaryIds: [],
      correctionIds: [],
      changedPaths: []
    };

    const sourceText = input.consolidationMode === "l0_window"
      ? this.renderUserWindowForRawMemory(input)
      : input.userMessage;
    const tags = this.memoryTags(sourceText, input.userMessage);
    const rawAnchors: string[] = [];
    const rawLevels: Array<ExtractedRawMemory["level"]> = [];

    if (input.consolidationMode === "l0_window" && sourceText.trim()) {
      const body = [
        "## L0 窗口原始记忆",
        "",
        sourceText.trim(),
        "",
        "## 来源",
        "",
        `- ${conversationAnchor}`
      ].join("\n");
      const id = await this.store.writeRawMemory("L1", body, [conversationAnchor], tags);
      result.rawMemoryIds.push(id);
      result.changedPaths?.push(this.store.rawMemoryPath("L1", id));
      rawAnchors.push(this.store.recordAnchor("L1", id));
      rawLevels.push("L1");
    }

    for (const raw of input.consolidationMode === "l0_window" ? [] : output.raw_memories) {
      const body = [
        "## 原始记忆",
        "",
        raw.content,
        "",
        "## 来源",
        "",
        `- ${conversationAnchor}`
      ].join("\n");
      const id = await this.store.writeRawMemory(raw.level, body, [conversationAnchor], [...tags, ...raw.tags]);
      result.rawMemoryIds.push(id);
      result.changedPaths?.push(this.store.rawMemoryPath(raw.level, id));
      rawAnchors.push(this.store.recordAnchor(raw.level, id));
      rawLevels.push(raw.level);
    }

    for (const summary of output.summaries) {
      const anchors = rawAnchors.length > 0 ? rawAnchors : [conversationAnchor];
      try {
        const id = await this.store.writeMemorySummary(
          highestMemoryLevel(rawLevels) ?? "L1",
          summary.content,
          [...anchors, conversationAnchor],
          tags,
          "high"
        );
        result.summaryIds.push(id);
        result.changedPaths?.push(this.store.memorySummaryPath(highestMemoryLevel(rawLevels) ?? "L1", id));
      } catch {
        // skip summaries that fail anchor validation
      }
    }

    return result;
  }

  private async ruleBasedExtract(input: ExtractMemoryInput, anchor: string): Promise<ExtractMemoryResult> {
    const result: ExtractMemoryResult = {
      rawMemoryIds: [],
      summaryIds: [],
      correctionIds: [],
      changedPaths: []
    };

    const sourceText = input.consolidationMode === "l0_window"
      ? this.renderUserWindowForRawMemory(input)
      : input.userMessage.trim();
    if (!sourceText) return result;
    const tags = this.memoryTags(sourceText, input.userMessage);
    const body = [
      input.consolidationMode === "l0_window" ? "## L0 窗口原始记忆" : "## Raw Memory",
      "",
      sourceText,
      "",
      "## Source",
      "",
      `- ${anchor}`
    ].join("\n");
    const rawId = await this.store.writeRawMemory("L1", body, [anchor], tags);
    result.rawMemoryIds.push(rawId);
    result.changedPaths?.push(this.store.rawMemoryPath("L1", rawId));

    const rawAnchor = this.store.recordAnchor("L1", rawId);
    const summary = this.ruleBasedSummarize(sourceText);
    try {
      const summaryId = await this.store.writeMemorySummary("L1", summary, [anchor, rawAnchor], tags, "high");
      result.summaryIds.push(summaryId);
      result.changedPaths?.push(this.store.memorySummaryPath("L1", summaryId));
    } catch {
      // skip
    }

    return result;
  }

  private shouldExtract(message: string, recentMessages: ChatMessage[]): boolean {
    if (recentMessages.length >= 8) return true;
    const recentText = recentMessages.map(item => item.content).join("\n");
    if (recentText.length >= 3000) return true;
    if (message.trim().length >= 80) return true;
    if (this.isSelfFactCandidate(message)) return true;
    return includesAny(message, ["remember", "remind me", "note this", "I've been", "I recently", "I realized", "I found that", "to me", "I care about", "summarize", "write this down", "记住", "以后提醒我", "总结一下", "先记下来"]);
  }

  private memoryTags(sourceText: string, triggerMessage: string): string[] {
    const tags = extractKeywords(sourceText).slice(0, 6);
    if (this.isExplicitMemoryRequest(triggerMessage)) tags.unshift("explicit_memory_request", "user_marked_important");
    return Array.from(new Set(tags)).slice(0, 8);
  }

  private isExplicitMemoryRequest(message: string): boolean {
    return includesAny(message, [
      "remember", "remind me", "note this", "write this down", "summarize",
      "记住", "以后提醒我", "总结一下", "先记下来", "这个很重要", "帮我记"
    ]);
  }

  private l0WindowMessages(input: ExtractMemoryInput): ChatMessage[] {
    const windowSize = input.consolidationMode === "l0_window" ? 16 : 10;
    return (input.recentMessages ?? []).slice(-windowSize);
  }

  private renderUserWindowForRawMemory(input: ExtractMemoryInput): string {
    const userMessages = this.l0WindowMessages(input)
      .filter(message => message.role === "user")
      .map(message => {
        const created = message.created ? `${message.created} ` : "";
        return `- ${created}${message.content.trim()}`;
      })
      .filter(line => line.length > 2);
    return userMessages.join("\n");
  }

  private isSelfFactCandidate(message: string): boolean {
    const normalized = message.replace(/\s+/g, "");
    const educationFact = /我(的)?(大学|学校|本科|研究生|硕士|博士|专业|学院)|我.*(毕业于|读的是|学的是|专业是|本科是|大学是)/.test(normalized);
    const careerFact = /我.*(毕业后|第一份工作|入职|去了|加入|在.+工作|去了.+公司)/.test(normalized);
    const identityFact = /我(来自|出生在|住在|现在住|老家是|家乡是)/.test(normalized);
    const lower = message.toLowerCase();
    const englishFact = /\b(my (university|college|major|school)|i (graduated|studied|work|worked|joined|live|lived|am from|was born))\b/.test(lower);
    return educationFact || careerFact || identityFact || englishFact;
  }

  private isUnsafeInference(message: string): boolean {
    const dangerTerms = ["可能是因为我有病", "诊断", "抑郁症", "人格障碍", "diagnosed with", "personality disorder", "mental illness", "depression"];
    const safetyTerms = ["医生", "确诊", "明确", "doctor", "diagnosed", "professional", "therapist"];
    return includesAny(message, dangerTerms) && !includesAny(message, safetyTerms);
  }

  private ruleBasedSummarize(message: string): string {
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`;
  }

}

function highestMemoryLevel(levels: Array<ExtractedRawMemory["level"]>): ExtractedRawMemory["level"] | undefined {
  if (levels.includes("L1")) return "L1";
  return undefined;
}
