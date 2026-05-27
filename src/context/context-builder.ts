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

  private async buildSystemPrompt(tier: ResolvedModelTier, speed: string, lang: string): Promise<string> {
    const name = this.settings.odysseyName;

    if (tier === "constrained") {
      if (speed === "slow") {
        return await this.loadPromptOr("constrained-minimal", lang, (l) => this.constrainedSystemPromptMinimal(l));
      }
      return await this.loadPromptOr("constrained", lang, (l) => this.constrainedSystemPrompt(l));
    }
    return await this.loadPromptOr("system", lang, (l) => {
      if (this.settings.systemPrompt) {
        return this.settings.systemPrompt.replace(/\{\{name\}\}/g, name);
      }
      return l === "zh" ? this.defaultSystemPromptZh() : this.defaultSystemPromptEn();
    });
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
      const result = await this.store.readConversationMessagesForDate(date);
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

// Extract dates (YYYY-MM-DD) from memory source/anchors that point to
// conversation files, so recall mode can include original conversation text.
function extractSourceDates(memories: RetrievedMemory[]): string[] {
  const pattern = /Conversations\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.md/;
  const dates = new Set<string>();
  for (const item of memories.slice(0, 10)) {
    const anchors = [...item.memory.source, ...item.memory.anchors];
    for (const anchor of anchors) {
      const match = anchor.match(pattern);
      if (match) dates.add(match[3]);
    }
  }
  return Array.from(dates).slice(0, 3);
}
