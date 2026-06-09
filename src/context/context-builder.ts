import { AttachedReference, BuiltContext, ChatMessage, ContextBudgetReport, OdysseySettings, IntentResult, ResolvedModelTier, RetrievedMemory, resolveModelTier } from "../types";
import { MarkdownStore } from "../store/markdown-store";
import { RetrievalService } from "../retrieval/retrieval-service";
import { estimateTokens, extractKeywords, truncateText, detectLanguage } from "../utils/text";
import { readPackagedPromptResource } from "./packaged-prompt-resources";

export class ContextBuilder {

  constructor(
    private readonly settings: OdysseySettings,
    private readonly store: MarkdownStore,
    private readonly retrieval: RetrievalService
  ) {}

  async build(userMessage: string, recentMessages: ChatMessage[], intent: IntentResult, attachedReferences: AttachedReference[] = []): Promise<BuiltContext> {
    // When user asks to recall but the query is vague ("好好回忆一下"), enrich with
    // keywords from recent conversation so the retrieval doesn't miss the topic.
    const recallKeywords = intent.mode === "recall"
      ? extractContextKeywords(recentMessages) : [];
    const visibleRetrieved = this.retrieval.search(userMessage, intent, recallKeywords);
    const tier = resolveModelTier(this.settings);
    const speed = tier === "constrained" ? this.settings.chatModelSpeedTier : "fast";
    // Recall mode prioritizes accuracy over speed — lift prompt constraints
    const isRecall = intent.mode === "recall";
    const lang = detectLanguage(userMessage);

    const l0 = this.renderRecent(recentMessages, userMessage, intent);
    const attached = this.renderAttachedReferences(attachedReferences, 5200, userMessage, intent.keywords)
      || (intent.wantsReference ? "No L0 attached reference content is visible in this turn. If the user asks whether you can see a document or section, say you cannot currently see the document text unless it appears elsewhere below as an explicit source." : "");
    // In recall mode, also look up dates from retrieved-memory sources so the
    // model can see the original conversation text, not just extracted fragments.
    const recallSourceDates = isRecall
      ? extractSourceDates(visibleRetrieved)
      : [];
    const allTargetDates = Array.from(new Set([...(intent.targetDates ?? []), ...recallSourceDates]));
    const dateSummaries = this.renderRetrieved(this.retrieval.searchTargetDateSummaries(allTargetDates), 2600);
    const datedConversations = await this.renderTargetDateConversations(allTargetDates);
    const showExcerpts = speed === "fast" || (isRecall && speed !== "unknown");
    const excerptBudget = isRecall ? 400 : (speed === "fast" ? 260 : 160);
    const excerptLimit = isRecall ? 6 : (speed === "fast" ? 5 : 3);
    const activated = this.renderRetrieved(visibleRetrieved.filter(item => item.activatedAsL0), 2200);
    const summaries = showExcerpts
      ? await this.renderRetrievedWithExcerpts(visibleRetrieved.filter(item => item.memory.type === "memory_summary"), 1400, excerptBudget, excerptLimit, intent)
      : this.renderRetrieved(visibleRetrieved.filter(item => item.memory.type === "memory_summary"), 1400);
    // Raw memories contain the user's original words — render with excerpts in recall mode
    const rawMemoryExcerpts = isRecall
      ? await this.renderRetrievedWithExcerpts(visibleRetrieved.filter(item => item.memory.type === "raw_memory" && item.memory.level === "L1"), 2000, excerptBudget, excerptLimit, intent)
      : "";
    const corrections = this.renderRetrieved(visibleRetrieved.filter(item => item.memory.type === "correction"), 900);
    const references = this.renderRetrieved(visibleRetrieved.filter(item => item.memory.type === "reference"), 700);

    const system = await this.buildSystemPrompt(isRecall ? "standard" : tier, speed, lang);
    const replyStyle = buildReplyStyleDirective(userMessage, lang);
    const evidenceBoundary = buildEvidenceBoundary(visibleRetrieved, attachedReferences, intent);
    const isConstrained = tier === "constrained" && !isRecall;
    const hasEvidence = visibleRetrieved.length > 0 || attachedReferences.length > 0;
    const skipMeta = isConstrained && (speed === "slow" || (speed === "medium" && !hasEvidence));

    // For constrained-tier local models, strip empty/meta sections to reduce
    // prompt-processing time. Small models spend disproportionate compute on
    // formatting and instruction text that adds no retrieval value.
    const context = [
      skipMeta
        ? ""
        : section("Evidence Boundary (read this first)", evidenceBoundary),
      section("Current Turn Reply Style", replyStyle),
      section("L0 Current Memory (recent user words)",
        isConstrained ? this.renderRecentConstrained(recentMessages, userMessage, intent, speed) : l0),
      section("L0 Attached References (current conversation priority)", attached),
      section("Target Date Summaries", dateSummaries),
      section("Target Date Original Conversations", datedConversations),
      section("L0 Activated Recall (memories pulled into working memory)", activated),
      section("L1 Summary Index & Raw Memory Anchors", summaries),
      section("L1 Raw Memory Original Text (user's exact words)", rawMemoryExcerpts),
      section("Confirmed Corrections", corrections),
      section("Low-priority Reference", references)
    ].filter(Boolean).join("\n\n");

    const budgetLimit = this.settings.maxInputChars;
    const finalContext = truncateText(context, Math.max(1000, budgetLimit - system.length - userMessage.length - 1000));
    // Constrained-tier models lose distant system-prompt constraints; restate the
    // grounding boundary as a short manifest at the start of the user turn, where
    // small models pay the most attention.
    const userContent = tier === "constrained"
      ? `${buildVisibleManifest(visibleRetrieved, attachedReferences, intent, lang)}\n\n${userMessage}`
      : userMessage;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "system", content: finalContext },
      { role: "user", content: userContent }
    ];
    const report: ContextBudgetReport = {
      modelContextLimit: Math.ceil(this.settings.maxInputChars / 2),
      estimatedInputChars: messages.map(message => message.content).join("\n").length,
      reservedOutputTokens: this.settings.maxOutputTokens,
      sections: {
        system: estimateTokens(system),
        l0CurrentMemory: estimateTokens(l0),
        attachedReferences: estimateTokens(attached),
        targetDateSummaries: estimateTokens(dateSummaries),
        targetDateConversation: estimateTokens(datedConversations),
        l0ActivatedRecall: estimateTokens(activated),
        l1SummaryIndexAnchors: estimateTokens(summaries),
        corrections: estimateTokens(corrections),
        references: estimateTokens(references)
      },
      droppedSections: context.length > finalContext.length ? ["context_over_budget"] : []
    };
    return {
      messages,
      referencedMemoryIds: Array.from(new Set([...visibleRetrieved.map(item => item.memory.id), ...attachedReferences.map(item => item.id)])),
      retrievedMemories: visibleRetrieved,
      report,
      warnings: []
    };
  }

  private async buildSystemPrompt(tier: ResolvedModelTier, speed: string, lang: "zh" | "en"): Promise<string> {
    const name = this.settings.odysseyName;
    let basePrompt: string;

    if (tier === "constrained") {
      if (speed === "slow") {
        basePrompt = await this.loadPromptOr("constrained-minimal", lang, (l) => this.constrainedSystemPromptMinimal(l));
        return appendRuntimeInvariants(basePrompt, lang);
      }
      basePrompt = await this.loadPromptOr("constrained", lang, (l) => this.constrainedSystemPrompt(l));
      return appendRuntimeInvariants(basePrompt, lang);
    }
    basePrompt = await this.loadPromptOr("system", lang, (l) => {
      if (this.settings.systemPrompt) {
        return this.settings.systemPrompt.replace(/\{\{name\}\}/g, name);
      }
      return l === "zh" ? this.defaultSystemPromptZh() : this.defaultSystemPromptEn();
    });
    return appendRuntimeInvariants(basePrompt, lang);
  }

  private async loadPromptOr(key: string, lang: string, fallback: (lang: string) => string): Promise<string> {
    // 1. Vault file: Odyssey/Prompts/{key}.{lang}.md (user's own override)
    const path = this.store.path(`Prompts/${key}.${lang}.md`);
    try {
      const content = await this.store.readFile(path);
      if (content.trim()) {
        return content.trim().replace(/\{\{name\}\}/g, this.settings.odysseyName);
      }
    } catch {
      // file doesn't exist, continue to next fallback
    }

    const packaged = readPackagedPromptResource(key, lang);
    if (packaged) return packaged.replace(/\{\{name\}\}/g, this.settings.odysseyName);

    return fallback(lang);
  }

  private constrainedSystemPrompt(lang: string): string {
    if (lang === "zh") {
      return [
        `你是"${this.settings.odysseyName}"，用户的数字自我伴侣。`,
        "",
        "规则：",
        "1. 只根据下文提供的记忆和资料回答，没有就直说没有，不编造。",
        "2. 用户刚说的话不要说「我记得」「你之前说过」。",
        "3. 附件原文出现在上下文里才说「读到了」，看不到就说看不到。",
        "4. 被指出错误时直接承认，改正，不辩解。",
        "5. 回复长度匹配用户的问题：普通聊天简短（1-3句），回忆/反思/总结可以适当展开。不管哪种情况，不说废话，不跑题，不重复。",
        "6. 用户让你回忆但下文没有相关记忆时，问用户具体指哪件事、什么时间或关键词，不要说失忆了或记不清。",
        "用用户的语言回复。",
      ].join("\n");
    }
    return [
      `You are "${this.settings.odysseyName}", the user's digital companion.`,
      "",
      "Rules:",
      "1. Answer only from the provided context. If there's no relevant evidence, say so directly.",
      "2. Don't say \"I remember\" or \"you mentioned before\" for things just said in the current message.",
      "3. Only claim to have read attached documents when the text appears in context.",
      "4. When corrected, acknowledge the error directly and fix it without defending.",
      "5. Match reply length to the user's question. Be concise.",
      "6. When the user asks you to recall but there's no relevant memory, ask for specifics.",
      "CRITICAL: Always reply in the same language the user writes in. Match the user's language exactly — do not switch languages.",
    ].join("\n");
  }

  private constrainedSystemPromptMinimal(lang: string): string {
    if (lang === "zh") {
      return [
        `你是"${this.settings.odysseyName}"，用户的数字自我伴侣。`,
        "简短回复，1-2句话，不展开不反问。用用户的语言回复。",
      ].join("\n");
    }
    return [
      `You are "${this.settings.odysseyName}", the user's digital companion.`,
      "Keep replies very short, 1-2 sentences. CRITICAL: Reply in the same language the user writes in. Do not switch languages.",
    ].join("\n");
  }

  private defaultSystemPromptEn(): string {
    return [
      `You are "${this.settings.odysseyName}", a locally-first digital companion in the Odyssey system.`,
      "You help the user recall, reflect, and organize their thoughts using their local memory.",
      "Base your answers on the evidence provided in context. If no relevant evidence exists, say so rather than fabricate.",
      "Do not describe information introduced in the user's current message as something you remember from before.",
      "When corrected, acknowledge the error directly, fix it, and do not defend it.",
      "Do not present yourself as a medical, legal, financial, or mental-health professional.",
      "CRITICAL: Always respond in the same language the user writes in. If the user writes in English, reply in English. Match the user's language exactly — do not switch languages. Be concise and natural.",
      "For a more tailored experience, add a custom system prompt file to the Odyssey Prompts directory."
    ].join("\n");
  }

  private defaultSystemPromptZh(): string {
    return [
      `你是"${this.settings.odysseyName}"，Odyssey 系统中的本地数字伴侣。`,
      "你帮助用户回忆、反思和整理他们的想法，基于本地记忆系统。",
      "只根据上下文提供的证据回答，没有相关证据时直接说明，不编造。",
      "用户当前消息中刚提供的信息，不要说成你此前已经记得的内容。",
      "被指出错误时，直接承认并改正，不要为错误辩解。",
      "不要自称医疗、法律、财务或心理健康专业人士。",
      "用用户的语言回复，保持简洁自然。",
      "如需更个性化的体验，可在 Odyssey Prompts 目录中添加自定义提示词文件。"
    ].join("\n");
  }

  // L0 history rendered with relevance scoring: each recent message is scored
  // against current query keywords. Relevant messages are kept regardless of age;
  // irrelevant ones are dropped. This prevents topic drift from crowding out the
  // active thread and gives a more human-like "what matters now" window.
  private renderRecentConstrained(messages: ChatMessage[], userMessage: string, intent: IntentResult, speed: string = "fast"): string {
    const recent = messages.slice(-40);
    const queryKeywords = extractKeywords(userMessage).filter(kw => kw.length >= 2);
    const isRecall = intent.mode === "recall" || intent.hasExplicitTimeHint;

    // Budget: recall > fast > medium > slow
    const budget = isRecall ? 2800 : speed === "fast" ? 2200 : speed === "medium" ? 1600 : 800;

    // Always keep L0 temporary summaries
    const summaries = recent
      .filter(m => m.role === "system" && m.content.startsWith("L0 temporary session summary"))
      .slice(-2);

    // Score user messages by keyword overlap; always keep last 3 for continuity
    const userEntries = recent
      .map((msg, i) => ({ msg, idx: i, role: "user" as const }))
      .filter(e => e.msg.role === "user");
    const scoredUsers = userEntries.map(e => ({
      ...e,
      score: queryKeywords.length ? scoreKeywordRelevance(e.msg.content, queryKeywords) : 1
    }));
    const pickedUsers = pickRelevantMessages(scoredUsers, queryKeywords.length > 0 ? 0 : 2, 3, budget);
    const userLines = pickedUsers
      .sort((a, b) => a.idx - b.idx)
      .map(e => `${e.msg.created ?? ""} user: ${truncateText(e.msg.content, speed === "slow" ? 200 : 400)}`);

    // Assistant replies: include last 1-2, filtered by relevance
    const assistantEntries = recent
      .map((msg, i) => ({ msg, idx: i, role: "assistant" as const }))
      .filter(e => e.msg.role === "assistant");
    const scoredAssistants = assistantEntries.map(e => ({
      ...e,
      score: queryKeywords.length ? scoreKeywordRelevance(e.msg.content, queryKeywords) : 1
    }));
    const pickedAssistants = pickRelevantMessages(scoredAssistants, 0, 1, Math.floor(budget * 0.25));
    const assistantLines = pickedAssistants
      .sort((a, b) => a.idx - b.idx)
      .map(e => `${e.msg.created ?? ""} assistant: ${truncateText(e.msg.content, speed === "slow" ? 120 : 280)}`);

    return [
      summaries.length ? summaries.map(s => `${s.created ?? ""} l0_summary: ${truncateText(s.content, 600)}`).join("\n") : "",
      userLines.length ? "### Recent user words\n" + userLines.join("\n") : "",
      assistantLines.length ? "### Recent Odyssey replies\n" + assistantLines.join("\n") : ""
    ].filter(Boolean).join("\n").trim() || "(no prior context)";
  }

  private renderRecent(messages: ChatMessage[], userMessage: string, intent: IntentResult): string {
    const recent = messages.slice(-40);
    const queryKeywords = extractKeywords(userMessage).filter(kw => kw.length >= 2);
    const isRecall = intent.mode === "recall" || intent.hasExplicitTimeHint;
    const budget = isRecall ? 4000 : 3200;

    const summaries = recent
      .filter(m => m.role === "system" && m.content.startsWith("L0 temporary session summary"))
      .slice(-2);

    const userEntries = recent
      .map((msg, i) => ({ msg, idx: i, role: "user" as const }))
      .filter(e => e.msg.role === "user");
    const scoredUsers = userEntries.map(e => ({
      ...e,
      score: queryKeywords.length ? scoreKeywordRelevance(e.msg.content, queryKeywords) : 1
    }));
    const pickedUsers = pickRelevantMessages(scoredUsers, queryKeywords.length > 0 ? 0 : 3, 5, budget);
    const userLines = pickedUsers
      .sort((a, b) => a.idx - b.idx)
      .map(e => `${e.msg.created ?? ""} user_source_of_truth: ${truncateText(e.msg.content, 700)}`);

    const shouldIncludeAssistant = intent.mode === "normal_chat"
      && !intent.hasExplicitTimeHint
      && !(intent.targetDates?.length);
    const assistantEntries = recent
      .map((msg, i) => ({ msg, idx: i, role: "assistant" as const }))
      .filter(e => e.msg.role === "assistant");
    const scoredAssistants = assistantEntries.map(e => ({
      ...e,
      score: queryKeywords.length ? scoreKeywordRelevance(e.msg.content, queryKeywords) : 1
    }));
    const pickedAssistants = shouldIncludeAssistant
      ? pickRelevantMessages(scoredAssistants, 0, 2, Math.floor(budget * 0.2))
      : [];
    const assistantLines = pickedAssistants
      .sort((a, b) => a.idx - b.idx)
      .map(e => `${e.msg.created ?? ""} assistant_reference_not_user_fact: ${truncateText(e.msg.content, 420)}`);

    return [
      summaries.length ? "### L0 Temporary Session Summaries\n" + summaries.map(s => `${s.created ?? ""} l0_temporary_summary: ${truncateText(s.content, 900)}`).join("\n\n") : "",
      "### Recent user words (source of truth)",
      userLines.join("\n\n") || "(no user words available)",
      assistantLines.length ? "\n### Recent Odyssey replies (conversation continuity only — NOT user facts)\n" + assistantLines.join("\n\n") : ""
    ].join("\n").trim();
  }

  private renderRetrieved(items: RetrievedMemory[], maxChars: number): string {
    if (!items.length) return "";
    const rendered = items.map(item => {
      const anchors = item.memory.anchors.length ? `\nanchors: ${item.memory.anchors.join(", ")}` : "";
      return `- ${item.memory.id} (${item.memory.type}, ${item.memory.level ?? "-"}) ${item.memory.summary}${anchors}`;
    }).join("\n");
    return truncateText(rendered, maxChars);
  }

  private async renderRetrievedWithExcerpts(items: RetrievedMemory[], maxChars: number, excerptBudget: number, limit: number, intent: IntentResult): Promise<string> {
    if (!items.length) return "";
    const selected = items.slice(0, limit);
    const perItemBudget = Math.max(350, Math.floor(maxChars / selected.length));
    const perExcerptBudget = Math.min(excerptBudget, Math.floor(perItemBudget * 0.45));
    const rendered: string[] = [];
    for (const item of selected) {
      const anchors = item.memory.anchors.length ? `anchors: ${item.memory.anchors.join(", ")}` : "";
      const excerpt = await this.readMemoryExcerpt(item.memory.path, perExcerptBudget, intent.keywords);
      const line = [
        `- ${item.memory.id} (${item.memory.type}, ${item.memory.level ?? "-"}) ${item.memory.summary}`,
        anchors ? `  ${anchors}` : "",
        excerpt ? `  原文摘录: ${excerpt}` : ""
      ].filter(Boolean).join("\n");
      rendered.push(line);
    }
    return truncateText(rendered.join("\n"), maxChars);
  }

  private async readMemoryExcerpt(path: string, maxChars: number, keywords: string[] = []): Promise<string> {
    try {
      const content = await this.store.readFile(path);
      if (!content) return "";
      // Strip YAML frontmatter
      const body = content.replace(/^---[\s\S]*?---\n?/, "").trim();
      if (!body) return "";
      // Try to find a relevant segment near keywords
      if (keywords.length) {
        const lower = body.toLowerCase();
        for (const kw of keywords.slice(0, 5)) {
          const idx = lower.indexOf(kw.toLowerCase());
          if (idx >= 0) {
            const start = Math.max(0, idx - Math.floor(maxChars / 4));
            const end = Math.min(body.length, idx + Math.floor(maxChars * 0.75));
            const excerpt = (start > 0 ? "…" : "") + body.slice(start, end).trim() + (end < body.length ? "…" : "");
            return truncateText(excerpt, maxChars);
          }
        }
      }
      // No keyword match — return the first meaningful paragraph
      const firstLine = body.split(/\n{2,}/)[0] || body.split("\n")[0] || "";
      return truncateText(firstLine.trim(), maxChars);
    } catch {
      return "";
    }
  }

  private renderAttachedReferences(references: AttachedReference[], maxChars: number, userMessage: string, intentKeywords: string[] = []): string {
    if (!references.length) return "";
    const visibleReferences = references.slice(-6);
    const perReferenceBudget = Math.max(500, Math.floor(maxChars / visibleReferences.length));
    const summaryBudget = Math.min(280, Math.max(120, Math.floor(perReferenceBudget * 0.22)));
    const excerptBudget = Math.max(320, perReferenceBudget - summaryBudget - 260);
    const queryKeywords = Array.from(new Set([...intentKeywords, ...extractKeywords(userMessage)]))
      .filter(keyword => keyword.length >= 2);
    const rendered = visibleReferences.map(reference => [
      `### ${reference.title}`,
      `reference_id: ${reference.id}`,
      `source: ${reference.path}`,
      `visibility: title and selected excerpts are available in this context; do not claim unseen sections are available.`,
      "",
      "Summary:",
      truncateText(reference.summary, summaryBudget),
      "",
      "Relevant excerpts:",
      this.selectReferenceExcerpt(reference.excerpt, queryKeywords, excerptBudget, userMessage)
    ].join("\n")).join("\n\n");
    return truncateText(rendered, maxChars);
  }

  private selectReferenceExcerpt(text: string, keywords: string[], maxChars: number, userMessage = ""): string {
    const normalized = text.trim();
    if (!normalized) return "(no excerpt available)";

    const headingExcerpt = selectHeadingExcerpt(normalized, userMessage, keywords, maxChars);
    if (headingExcerpt) return headingExcerpt;
    if (normalized.length <= maxChars) return normalized;

    const lower = normalized.toLowerCase();
    const windows: Array<{ start: number; end: number }> = [];
    for (const keyword of keywords.slice(0, 10)) {
      const needle = keyword.toLowerCase();
      if (needle.length < 2) continue;
      let cursor = 0;
      while (windows.length < 8) {
        const index = lower.indexOf(needle, cursor);
        if (index === -1) break;
        const start = Math.max(0, index - Math.floor(maxChars / 5));
        const end = Math.min(normalized.length, index + Math.floor(maxChars / 3));
        windows.push({ start, end });
        cursor = index + needle.length;
      }
    }

    if (!windows.length) {
      const head = Math.floor(maxChars * 0.55);
      const tail = Math.max(160, maxChars - head - 80);
      return `${normalized.slice(0, head).trimEnd()}\n...[middle omitted; no query-specific excerpt found]...\n${normalized.slice(-tail).trimStart()}`;
    }

    const merged = windows
      .sort((a, b) => a.start - b.start)
      .reduce<Array<{ start: number; end: number }>>((acc, window) => {
        const previous = acc[acc.length - 1];
        if (previous && window.start <= previous.end + 120) {
          previous.end = Math.max(previous.end, window.end);
        } else {
          acc.push({ ...window });
        }
        return acc;
      }, []);
    const chunks: string[] = [];
    let remaining = maxChars;
    for (const window of merged) {
      if (remaining <= 80) break;
      const chunk = normalized.slice(window.start, window.end).trim();
      const clipped = truncateText(chunk, remaining);
      chunks.push((window.start > 0 ? "... " : "") + clipped + (window.end < normalized.length ? " ..." : ""));
      remaining -= clipped.length + 12;
    }
    return chunks.join("\n\n---\n\n");
  }

  private async renderTargetDateConversations(dates: string[]): Promise<string> {
    if (!dates.length) return "";
    const sections: string[] = [];
    for (const date of dates.slice(0, 2)) {
      const result = await this.store.readL1ConversationTurnsForDate(date);
      if (!result || result.messages.length === 0) {
        sections.push(`### ${date}\nNo original conversation found for this date.`);
        continue;
      }
      const messages = result.messages;
      const userMessages = messages.filter(message => message.role === "user");
      const userExcerpt = userMessages.length <= 16
        ? userMessages
        : [...userMessages.slice(0, 10), ...userMessages.slice(-6)];
      const omitted = userMessages.length > userExcerpt.length
        ? `\n\n[${userMessages.length - userExcerpt.length} user messages omitted in the middle. If the user asks about their earliest state, rely on the earliest user messages above — do not fabricate from the gap.]`
        : "";
      sections.push([
        `### ${date}`,
        `source: ${this.store.anchorFor(result.path)}`,
        "Rule: only user words appear below. Old assistant replies are excluded from recall context — they may contain model inferences or hallucinations and cannot prove the user said these things.",
        "",
        "#### User words",
        userExcerpt.length
          ? userExcerpt.map(message => `${message.created ?? ""} user: ${truncateText(message.content, 700)}`).join("\n\n")
          : "No user words parsed for this date.",
        omitted
      ].join("\n"));
    }
    return truncateText(sections.join("\n\n"), 7000);
  }
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n${body.trim()}` : "";
}

function buildReplyStyleDirective(userMessage: string, lang: "zh" | "en"): string {
  const emotion = detectTurnEmotion(userMessage);
  const expression = detectExpressionMode(userMessage, emotion);
  if (lang === "zh") {
    const role = emotion === "emotional"
      ? "用户当下有情绪或热度：先接住感受，再给观点；除非用户明确要求，不要急着建议。"
      : emotion === "analytical"
        ? "用户在分析或追问：保持准确，给出框架和关键依据。"
        : emotion === "light"
          ? "轻量闲聊：像自然对话，短句，不要展开成报告。"
          : "普通陪伴式对话：温和、具体，别端着。";
    const length = expression === "brief"
      ? "回复 1-3 句。"
      : expression === "thorough"
        ? "可以适当展开，但只展开与问题直接相关的部分。"
        : "长度自然，避免强行列表。";
    const recallCheck = isBroadRememberMeCheck(userMessage)
      ? " 这是简单的记忆确认：用 1-2 个用户原话里的具体触点简短回答，不要揣测用户为什么这样问。"
      : "";
    return `[Reply style] ${role} ${length}${recallCheck}`;
  }

  const role = emotion === "emotional"
    ? "The user is emotionally engaged or warm. Meet the feeling first, then add perspective; do not rush into advice unless asked."
    : emotion === "analytical"
      ? "The user is analyzing or probing. Be precise, give a useful frame, and ground the answer."
      : emotion === "light"
        ? "This is light chat. Keep it natural and short; do not turn it into a report."
        : "Use a companion-like tone: warm, specific, and unforced.";
  const length = expression === "brief"
    ? "Reply in 1-3 sentences."
    : expression === "thorough"
      ? "You may go deeper, but only where it directly helps the question."
      : "Use a natural length and avoid forced bullet lists.";
  const recallCheck = isBroadRememberMeCheck(userMessage)
    ? " This is a simple memory check: answer briefly with 1-2 concrete user-authored touchpoints. Do not psychoanalyze why the user is asking."
    : "";
  return `[Reply style] ${role} ${length}${recallCheck}`;
}

function detectTurnEmotion(text: string): "neutral" | "emotional" | "analytical" | "light" {
  const normalized = text.trim();
  const len = normalized.length;
  const hasEmoji = /\p{Extended_Pictographic}/u.test(normalized);
  const hasExclamation = /[!！¡]/.test(normalized);
  const hasQuestion = /[?？¿؟]/.test(normalized);
  const capsMatches = normalized.match(/[A-Z]{4,}/g);
  const allCapsRatio = capsMatches ? capsMatches.join("").length / Math.max(1, len) : 0;

  if (hasEmoji || allCapsRatio > 0.3 || (hasExclamation && len > 20)) return "emotional";
  if (hasQuestion && len > 30) return "analytical";
  if (len < 24) return "light";
  return "neutral";
}

function detectExpressionMode(text: string, emotion: "neutral" | "emotional" | "analytical" | "light"): "brief" | "normal" | "thorough" {
  if (isBroadRememberMeCheck(text)) return "brief";
  const lenScore = Math.min(1, text.length / 120);
  const questionScore = /[?？¿؟]/.test(text) ? 1 : 0;
  const emotionScore = emotion === "emotional" ? 0.7 : emotion === "analytical" ? 0.8 : emotion === "light" ? 0 : 0.4;
  const intensity = Math.min(1, 0.35 * lenScore + 0.35 * questionScore + 0.3 * emotionScore);
  if (intensity < 0.3) return "brief";
  if (intensity < 0.75) return "normal";
  return "thorough";
}

function isBroadRememberMeCheck(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return (
    /\bdo you remember me\b/.test(normalized)
    || /\bdo you remember\b/.test(normalized)
    || normalized.includes("你记得我")
    || normalized.includes("还记得我")
  ) && normalized.length <= 80;
}

function buildEvidenceBoundary(retrieved: RetrievedMemory[], attachedReferences: AttachedReference[], intent: IntentResult): string {
  const memoryFacts = retrieved
    .filter(item => item.memory.type !== "reference")
    .slice(0, 8)
    .map(item => `- ${item.memory.id}: ${truncateText(item.memory.summary, 180)}`);
  const referenceFacts = retrieved
    .filter(item => item.memory.type === "reference")
    .slice(0, 4)
    .map(item => `- ${item.memory.id}: ${truncateText(item.memory.summary, 180)}`);
  const attachments = attachedReferences.slice(-6).map(reference => `- ${reference.title} (${reference.path})`);
  const documentRule = intent.wantsReference
    ? "The user appears to ask about a document, attachment, file, paper, or web/reference source. If no relevant title, heading, or excerpt appears under L0 Attached References or another explicit source below, say you cannot see the original text. Do not answer as if you read it."
    : "If the user asks about unseen documents or files, do not infer document contents from memories, summaries, or the user's description.";
  return [
    "Use only the evidence listed in the following context. Missing evidence is a valid answer.",
    documentRule,
    "Old assistant messages are continuity only, never proof that the user said something.",
    "L0 raw-memory window bullets are user-authored source excerpts, even in older records that lack an explicit 'user:' label. Do not call them Odyssey replies.",
    "Never infer the user's emotional motive for asking unless the user explicitly states it.",
    "",
    "Visible attached sources:",
    attachments.length ? attachments.join("\n") : "- none",
    "",
    "Visible long-term memory facts:",
    memoryFacts.length ? memoryFacts.join("\n") : "- none",
    "",
    "Visible low-priority references:",
    referenceFacts.length ? referenceFacts.join("\n") : "- none"
  ].join("\n");
}

function buildVisibleManifest(retrieved: RetrievedMemory[], attachedReferences: AttachedReference[], intent: IntentResult, lang: string): string {
  if (lang === "zh") {
    const titles = attachedReferences.map(reference => reference.title).filter(Boolean);
    const attachedLabel = titles.length ? titles.join("、") : "无";
    const memoryIds = retrieved.slice(0, 8).map(item => item.memory.id).join("、") || "无";
    const documentWarning = intent.wantsReference && titles.length === 0
      ? "｜用户可能在问文档/附件，但本次没有可见附件正文：必须先说看不到原文"
      : "";
    return `[可见范围｜检索到的记忆ID：${memoryIds}｜本次附件：${attachedLabel}${documentWarning}｜只引用下文实际出现的证据；没有就说「我没有相关记录」或「我现在看不到原文」，不要编造]`;
  }
  const titles = attachedReferences.map(reference => reference.title).filter(Boolean);
  const attachedLabel = titles.length ? titles.join(", ") : "none";
  const memoryIds = retrieved.slice(0, 8).map(item => item.memory.id).join(", ") || "none";
  const documentWarning = intent.wantsReference && titles.length === 0
    ? " | User may be asking about a document/attachment, but no visible attachment text is available: you must say you cannot see the original text"
    : "";
  return `[Visible scope | Retrieved memory IDs: ${memoryIds} | Attached: ${attachedLabel}${documentWarning} | Only cite evidence that actually appears below; if absent, say \"I don't have a relevant record\" or \"I cannot see the original text\" — do not fabricate]`;
}

function appendRuntimeInvariants(prompt: string, lang: "zh" | "en"): string {
  return [
    prompt.trim(),
    "",
    lang === "zh" ? runtimeInvariantZh() : runtimeInvariantEn()
  ].join("\n");
}

function runtimeInvariantEn(): string {
  return [
    "Runtime invariants:",
    buildTemporalContext(),
    "- Current user message language: English. Reply in English.",
    "- Do not choose the reply language from recalled memories, old conversation turns, settings text, or retrieved source language.",
    "- If asked why you used a language or claim the user used a language before, cite a visible user-message source. If no specific source is visible, say you cannot verify that claim.",
    "- If asked when you last chatted or what the last conversation was, exclude the entire current live session from past-conversation evidence. Use earlier saved turns only; if none are visible, say you do not have an earlier record.",
    "- If asked what the user just said, answer only from the current live session before the current user turn, not from older saved conversations.",
    "- If the user broadly asks whether you remember them, answer with 2-3 concrete touchpoints from visible memory instead of an audit-style inventory. Do not include the current turn as evidence of remembering them.",
    "- If the user reacts warmly to being remembered, meet that warmth first. You may add a brief evidence boundary, but do not undercut the moment with a long disclaimer.",
    "- User facts and quotations may only come from user_source_of_truth lines, explicit user: lines, or long-term memories that are clearly user-authored. assistant_reference_not_user_fact lines are never user facts.",
    "- Do not speculate about the user's hidden motive or emotional state. If the user did not say they feel uncertain, stressed, or anxious in the current visible evidence, do not infer it.",
    "- This Obsidian plugin request has no tool access. Do not emit tool calls, DSML, XML-like tool markup, JSON function calls, or ask the user to resend so you can use a tool.",
    "- When reconstructing history from fragments, report only what the fragments contain. Do not invent connective details to make the story smoother; mark uncertainty plainly.",
    "- Attribute ideas correctly: do not credit the user with an analysis you introduced, and do not claim as your own something the user said.",
    "Voice style:",
    "- Write like a real conversation, not a generic AI assistant.",
    "- Avoid stock openings, forced summaries, over-neat bullet lists, exaggerated claims, and empty transition words.",
    "- Be direct and specific. Use varied sentence length.",
    "- Match the user's energy and the task: casual chat should feel casual; technical explanation should stay precise."
  ].join("\n");
}

function runtimeInvariantZh(): string {
  return [
    "运行时约束：",
    buildTemporalContext(),
    "- 当前用户消息语言：中文。请用中文回复。",
    "- 不要根据召回记忆、旧对话、设置文本或检索来源的语言来切换回复语言。",
    "- 如果用户询问你为什么使用某种语言，或你声称用户以前使用过某种语言，必须引用可见的用户消息来源；没有具体可见来源时，直接说无法验证。",
    "- 如果用户问上次/最后一次聊天是什么时候，当前整个实时会话都不能算作过去对话证据；只根据更早保存的 turn 回答。没有可见历史时，直接说没有更早记录。",
    "- 如果用户问自己刚刚说了什么，只根据当前实时会话中、当前这条用户消息之前的内容回答，不要从更早保存的对话里找。",
    "- 如果用户笼统问你是否记得 TA，用 2-3 个可见记忆里的具体触点回答，不要做审计式清单，也不要把当前这轮刚说的话当作记得 TA 的证据。",
    "- 如果用户因为被记得而开心，先接住这种开心；可以简短说明证据边界，但不要用长篇免责声明破坏这个时刻。",
    "- 用户事实和原话只能来自 user_source_of_truth 行、明确的 user: 行，或清楚标明为用户原话的长期记忆。assistant_reference_not_user_fact 行绝不是用户事实。",
    "- 不要揣测用户隐藏动机或情绪状态。当前可见证据里用户没说自己不确定、压力大或焦虑，就不要推断。",
    "- 当前 Obsidian 插件请求没有工具权限。不要输出 tool call、DSML、XML 风格工具标记、JSON function call，也不要让用户重发来让你使用工具。",
    "- 从碎片记忆重建历史时，只说碎片里实际包含的内容；不要为了让故事顺滑而补发明连接细节，不确定就明确标出。",
    "- 正确归因：不要把你提出的分析算到用户头上，也不要把用户说过的话说成是你自己的。",
    "表达风格：",
    "- 像真实对话，不像通用 AI 助手。",
    "- 避免套话开场、强行总结、过度整齐的列表、夸大表达和空泛过渡词。",
    "- 直接、具体，句子长短自然变化。",
    "- 匹配用户当下的语气和任务：闲聊就像闲聊，技术解释就保持准确。"
  ].join("\n");
}

function buildTemporalContext(now = new Date()): string {
  const today = formatLocalDate(now);
  const currentTime = formatLocalDateTime(now);
  const timeZone = getLocalTimeZone();
  const utcOffset = formatUtcOffset(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = formatLocalDate(yesterdayDate);
  return [
    `[Current local time] ${currentTime} (${timeZone}, UTC${utcOffset})`,
    `[Current date] ${today}`,
    `[Relative dates] today = ${today}; yesterday = ${yesterday}. Resolve relative dates and times from this local device time.`
  ].join("\n");
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatLocalDateTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatLocalDate(date)} ${hh}:${mm}`;
}

function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

const HEADING_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "can", "do", "for", "from", "in", "is", "of", "on",
  "the", "this", "to", "what", "which", "with", "you"
]);

function selectHeadingExcerpt(text: string, userMessage: string, keywords: string[], maxChars: number): string {
  const terms = Array.from(new Set([
    ...keywords,
    ...extractKeywords(userMessage),
    ...Array.from(userMessage.matchAll(/[\u4e00-\u9fff]{2,}/g)).flatMap(match => sliceTerms(match[0]))
  ]))
    .map(term => term.trim())
    .filter(term => term.length >= 2 && !HEADING_QUERY_STOPWORDS.has(term.toLowerCase()));
  if (!terms.length) return "";

  const headingPattern = /^#{1,6}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null) {
    const heading = match[1].toLowerCase();
    if (!terms.some(term => heading.includes(term.toLowerCase()))) continue;
    const start = match.index;
    const nextHeading = text.slice(start + 1).search(/\n#{1,6}\s+/);
    const end = nextHeading === -1
      ? Math.min(text.length, start + maxChars)
      : Math.min(text.length, start + 1 + nextHeading);
    return truncateText(text.slice(start, end).trim(), maxChars);
  }
  return "";
}

function sliceTerms(text: string): string[] {
  if (text.length <= 6) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    out.push(text.slice(i, i + 2));
  }
  for (let i = 0; i < text.length - 3; i += 2) {
    out.push(text.slice(i, i + 4));
  }
  return out;
}

// Score a message's relevance by counting keyword hits. Each unique keyword
// match adds 1 point, weighted slightly by how early in the text it appears.
function scoreKeywordRelevance(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx >= 0) score += 1 + Math.max(0, 0.5 - idx / text.length);
  }
  return score;
}

interface ScoredMessage { msg: { content: string; created?: string; role: string }; idx: number; role: string; score: number; }

// Pick messages by relevance: first include keyword-matched ones (score > 0),
// then fill with recent messages, respecting a character budget.
function pickRelevantMessages(
  entries: ScoredMessage[],
  minKeep: number,
  recentKeep: number,
  maxChars: number
): ScoredMessage[] {
  const keywordMatched = entries.filter(e => e.score > 0);
  const recent = entries.slice(-recentKeep);
  const merged = new Map<number, ScoredMessage>();
  for (const e of keywordMatched) merged.set(e.idx, e);
  for (const e of recent) merged.set(e.idx, e);
  const picked = Array.from(merged.values()).sort((a, b) => a.idx - b.idx);
  let used = 0;
  const result: ScoredMessage[] = [];
  for (const e of picked) {
    const chars = Math.min(e.msg.content.length, 400);
    if (used + chars > maxChars * 0.7) break;
    result.push(e);
    used += chars;
  }
  // Walk backwards adding older keyword-matched messages if budget left
  for (let i = entries.length - 1; i >= 0 && result.length < entries.length; i--) {
    if (merged.has(entries[i].idx)) continue;
    const chars = Math.min(entries[i].msg.content.length, 400);
    if (used + chars > maxChars) break;
    if (entries[i].score > 0 || result.length < minKeep + recentKeep) {
      result.push(entries[i]);
      used += chars;
    }
  }
  return result.sort((a, b) => a.idx - b.idx);
}

// When user asks vague recall questions, enrich search keywords from recent
// conversation so we don't lose the topic thread that just left the L0 window.
function extractContextKeywords(messages: ChatMessage[]): string[] {
  return Array.from(new Set(
    messages
      .filter(m => m.role === "user")
      .slice(-6)
      .flatMap(m => extractKeywords(m.content))
      .filter(kw => kw.length >= 2)
  )).slice(0, 20);
}

// Extract dates (YYYY-MM-DD) from memory metadata, so recall mode can
// include original conversation text from L1 records.
function extractSourceDates(memories: RetrievedMemory[]): string[] {
  const dates = new Set<string>();
  for (const item of memories.slice(0, 10)) {
    if (item.memory.created) {
      const date = item.memory.created.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
    }
  }
  return Array.from(dates).slice(0, 3);
}
