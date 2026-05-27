import {
  AgentRuntime,
  ChatMessage,
  OdysseySettings,
  ExtractMemoryInput,
  ExtractMemoryResult,
  IntentInput,
  IntentResult,
  MemoryExtractionStatus,
  RebuildIndexResult,
  SendMessageInput,
  SendMessageResult,
  SummarizeInput,
  SummarizeResult
} from "../types";
import { MarkdownStore } from "../store/markdown-store";
import { LocalIndex } from "../index/local-index";
import { RetrievalService } from "../retrieval/retrieval-service";
import { ContextBuilder } from "../context/context-builder";
import { ModelGateway } from "../model/model-gateway";
import { MemoryExtractor } from "../memory/memory-extractor";
import { CorrectionDetector } from "../memory/correction-detector";
import { nowIso } from "../utils/time";
import { detectLanguage, includesAny, truncateText } from "../utils/text";

export class PluginLocalRuntime implements AgentRuntime {
  private recentMessages: ChatMessage[] = [];
  private postResponseJob: Promise<void> = Promise.resolve();
  private turnsSinceConsolidation = 0;
  private charsSinceConsolidation = 0;
  private turnsSinceL0Compaction = 0;
  private charsSinceL0Compaction = 0;

  constructor(
    private readonly getSettings: () => OdysseySettings,
    private readonly store: MarkdownStore,
    private readonly index: LocalIndex,
    private readonly retrieval: RetrievalService,
    private readonly contextBuilder: ContextBuilder,
    private readonly modelGateway: ModelGateway,
    private readonly memoryExtractor: MemoryExtractor,
    private readonly correctionDetector: CorrectionDetector
  ) {}

  hydrateRecentMessages(messages: ChatMessage[]): void {
    this.recentMessages = messages.map(message => ({ ...message, ephemeral: false })).slice(-40);
  }

  endSession(): void {
    this.recentMessages = this.recentMessages.filter(message => !message.ephemeral && message.role !== "system").slice(-40);
    this.turnsSinceL0Compaction = 0;
    this.charsSinceL0Compaction = 0;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const ephemeral = input.ephemeral === true;
    const lang = detectLanguage(input.message);
    const userMessage: ChatMessage = { role: "user", content: input.message, created: nowIso(), ephemeral };
    const conversationPath = ephemeral ? "" : await this.store.appendConversationMessage(userMessage);
    this.recentMessages.push(userMessage);

    const confirmedCorrections = ephemeral ? [] : await this.correctionDetector.maybeWritePendingCorrection(input.message);
    const intent = await this.decomposeIntent({ message: input.message });
    const context = await this.contextBuilder.build(input.message, this.recentMessages, intent, input.attachedReferences ?? []);
    const assistantMessages: ChatMessage[] = [];
    const continuationReasons: string[] = [];
    const modelMessages = [...context.messages];
    const maxContinuationTurns = this.shouldAllowAutoContinuation(input.message)
      ? Math.max(0, Math.min(this.getSettings().maxContinuationTurns ?? 0, 5))
      : 0;
    let outputLimited = false;
    let finalFinishReason: string | undefined;

    for (let turn = 0; turn <= maxContinuationTurns; turn++) {
      const completion = await this.modelGateway.complete("chat", modelMessages);
      const assistantMessage: ChatMessage = { role: "assistant", content: completion.content, created: nowIso(), ephemeral };
      if (!ephemeral) await this.store.appendConversationMessage(assistantMessage);
      this.recentMessages.push(assistantMessage);
      assistantMessages.push(assistantMessage);

      outputLimited = completion.outputLimited;
      finalFinishReason = completion.finishReason;
      if (!completion.outputLimited) break;
      if (turn >= maxContinuationTurns) break;

      continuationReasons.push(completion.finishReason ?? "length");
      modelMessages.push(
        { role: "assistant", content: completion.content, created: assistantMessage.created },
        {
          role: "user",
          content: lang === "zh"
            ? "请从上一条回答被截断的位置继续写。不要重复已经说过的内容，不要重新开头，直接续上。"
            : "Continue from where the previous response was cut off. Do not repeat what was already said, do not restart — pick up directly where you left off.",
          created: nowIso()
        }
      );
    }

    const assistantContent = assistantMessages.map(message => message.content).join("\n\n");
    this.recentMessages = this.recentMessages.slice(-40);
    const turnChars = input.message.length + assistantContent.length;
    this.turnsSinceL0Compaction += 1;
    this.charsSinceL0Compaction += turnChars;
    if (!ephemeral) {
      this.turnsSinceConsolidation += 1;
      this.charsSinceConsolidation += turnChars;
    }

    if (!ephemeral) this.correctionDetector.holdCorrectionIntent(input.message, context.retrievedMemories);
    const shouldCompactL0 = this.shouldCompactL0Window(input.message);
    const shouldConsolidate = !ephemeral && this.shouldConsolidateMemory(input.message);
    const consolidationMode: ExtractMemoryInput["consolidationMode"] = "l0_window";
    if (shouldCompactL0) {
      this.compactL0IntoWorkingSummary();
      this.turnsSinceL0Compaction = 0;
      this.charsSinceL0Compaction = 0;
    }
    const memoryExtractionStatus = this.describeMemoryExtractionStatus(shouldConsolidate, consolidationMode, ephemeral, shouldCompactL0);
    if (!ephemeral && shouldConsolidate) {
      this.turnsSinceConsolidation = 0;
      this.charsSinceConsolidation = 0;
    }

    this.enqueuePostResponseWork({
      conversationPath,
      userMessage: input.message,
      assistantContent,
      recentMessages: this.recentMessages.filter(message => !message.ephemeral && message.role !== "system").slice(),
      confirmedCorrections,
      shouldConsolidate,
      consolidationMode,
      forceRuleBased: memoryExtractionStatus.mode === "rule_fallback"
    });

    const warnings = [...context.warnings];
    if (continuationReasons.length > 0) {
      warnings.push(`模型输出触达长度上限，已自动续写 ${continuationReasons.length} 次。`);
    }
    if (outputLimited) {
      warnings.push(`模型返回 finish_reason=${finalFinishReason ?? "length"}，回答在达到最大自动续写次数后仍可能未完。可在设置页调高“最大输出 token”或“自动续写次数”。`);
    }

    return {
      assistantMessage: assistantMessages[assistantMessages.length - 1],
      assistantMessages,
      referencedMemoryIds: context.referencedMemoryIds,
      contextBudgetReport: context.report,
      memoryExtractionStatus,
      warnings
    };
  }

  private enqueuePostResponseWork(input: {
    conversationPath: string;
    userMessage: string;
    assistantContent: string;
    recentMessages: ChatMessage[];
    confirmedCorrections: string[];
    shouldConsolidate: boolean;
    consolidationMode: ExtractMemoryInput["consolidationMode"];
    forceRuleBased: boolean;
  }): void {
    this.postResponseJob = this.postResponseJob
      .catch(error => console.warn("Odyssey previous background memory job failed", error))
      .then(() => this.runPostResponseWork(input))
      .catch(error => console.warn("Odyssey background memory job failed", error));
  }

  private async runPostResponseWork(input: {
    conversationPath: string;
    userMessage: string;
    assistantContent: string;
    recentMessages: ChatMessage[];
    confirmedCorrections: string[];
    shouldConsolidate: boolean;
    consolidationMode: ExtractMemoryInput["consolidationMode"];
    forceRuleBased: boolean;
  }): Promise<void> {
    const settings = this.getSettings();
    const changedPaths = [...input.confirmedCorrections];
    if (input.shouldConsolidate && settings.autoExtractMemories) {
      const result = await this.extractMemories({
        conversationPath: input.conversationPath,
        userMessage: input.userMessage,
        assistantMessage: input.assistantContent,
        recentMessages: input.recentMessages,
        consolidationMode: input.consolidationMode,
        forceRuleBased: input.forceRuleBased
      });
      changedPaths.push(...(result.changedPaths ?? []));
    }
    if (changedPaths.length > 0 || input.shouldConsolidate && settings.autoExtractMemories) {
      await this.index.refreshPaths(changedPaths);
    }
  }

  private describeMemoryExtractionStatus(
    shouldConsolidate: boolean,
    consolidationMode: ExtractMemoryInput["consolidationMode"],
    ephemeral = false,
    l0Compacted = false
  ): MemoryExtractionStatus {
    const settings = this.getSettings();
    if (ephemeral) {
      return {
        mode: "ephemeral",
        label: l0Compacted ? "L0 临时摘要已更新" : "阅后即焚中",
        detail: l0Compacted
          ? "本区间不写入原始对话、L1 或索引；为了当前对话连贯，L0 已在内存中临时压缩。"
          : "本区间只保留在当前 L0 工作窗口，不写入原始对话、L1 或索引。",
        probeStatus: settings.extractionModelProbeStatus,
        consolidationMode,
        backgroundJobQueued: false
      };
    }
    if (!shouldConsolidate) {
      return {
        mode: "not_triggered",
        label: "本轮未触发记忆整理",
        detail: "消息会保存到原始对话；L0 窗口未满，也没有显式记忆请求或修正。",
        probeStatus: settings.extractionModelProbeStatus,
        backgroundJobQueued: false
      };
    }
    if (!settings.autoExtractMemories) {
      return {
        mode: "disabled",
        label: "自动记忆提取已关闭",
        detail: "本轮只保存原始对话和已确认修正；不会写入 raw memory / summary。",
        probeStatus: settings.extractionModelProbeStatus,
        consolidationMode,
        backgroundJobQueued: true
      };
    }
    if (settings.extractionModelProbeStatus === "passed") {
      return {
        mode: "ai_extraction",
        label: "AI 记忆提取",
        detail: "后台会使用 Extraction 模型整理 L1 raw memory / summary。",
        probeStatus: settings.extractionModelProbeStatus,
        consolidationMode,
        backgroundJobQueued: true
      };
    }
    if (settings.extractionModelProbeStatus === "partial") {
      return {
        mode: "degraded_ai_extraction",
        label: "降级 AI 记忆提取",
        detail: "Extraction 模型测试为部分通过；后台会保守提取，复杂观察可能不完整。",
        probeStatus: settings.extractionModelProbeStatus,
        consolidationMode,
        backgroundJobQueued: true
      };
    }
    return {
      mode: "rule_fallback",
      label: "规则 fallback 记忆提取",
      detail: "Extraction 模型未测试或测试失败；后台跳过模型 JSON 提取，只写入保守规则生成的基础记忆。",
      probeStatus: settings.extractionModelProbeStatus,
      consolidationMode,
      backgroundJobQueued: true
    };
  }

  private shouldConsolidateMemory(userMessage: string): boolean {
    return this.l0WindowIsFull(userMessage);
  }

  private shouldCompactL0Window(userMessage: string): boolean {
    if (this.recentUserMessagesAreLowInformation()) return false;
    return this.turnsSinceL0Compaction >= 6 || this.charsSinceL0Compaction >= 2500 || userMessage.length >= 2500;
  }

  private l0WindowIsFull(userMessage: string): boolean {
    if (this.recentUserMessagesAreLowInformation()) return false;
    return this.turnsSinceConsolidation >= 6 || this.charsSinceConsolidation >= 2500;
  }

  private recentUserMessagesAreLowInformation(): boolean {
    const recentUserMessages = this.recentMessages
      .filter(message => message.role === "user")
      .slice(-3);
    return recentUserMessages.length >= 3
      && recentUserMessages.every(message => this.isLowInformationMessage(message.content));
  }

  private compactL0IntoWorkingSummary(): void {
    const compactable = this.recentMessages.filter(message => message.role !== "system");
    if (compactable.length <= 18) return;
    const keep = compactable.slice(-12);
    const source = compactable.slice(0, -12);
    const userPoints = source
      .filter(message => message.role === "user")
      .slice(-8)
      .map(message => `- ${message.created ?? ""}: ${truncateText(message.content, 220)}`)
      .join("\n");
    const assistantPoints = source
      .filter(message => message.role === "assistant")
      .slice(-4)
      .map(message => `- ${message.created ?? ""}: ${truncateText(message.content, 180)}`)
      .join("\n");
    const content = [
      "L0 temporary session summary. This is working memory only, not a persisted user fact.",
      userPoints ? `Recent user words:\n${userPoints}` : "",
      assistantPoints ? `Recent Odyssey replies:\n${assistantPoints}` : ""
    ].filter(Boolean).join("\n\n");
    const summaryMessage: ChatMessage = { role: "system", content, created: nowIso(), ephemeral: true };
    this.recentMessages = [
      summaryMessage,
      ...keep
    ].slice(-40);
  }

  private isLowInformationMessage(message: string): boolean {
    const normalized = message.replace(/\s+/g, "");
    if (normalized.length >= 30) return false;
    return !includesAny(normalized, [
      "我专业", "我的专业", "我是", "我在", "我住", "我来自", "我喜欢", "我讨厌", "我重视", "我在意",
      "我想", "我觉得", "我发现", "我决定", "我以前", "我最近", "记住", "重要", "不对", "不是",
      "工作", "项目", "大学", "学校", "关系", "家人", "朋友", "目标", "计划", "压力", "焦虑",
      "i am", "i'm", "my", "i work", "i live", "i like", "i hate", "i value", "i want", "remember",
      "important", "wrong", "actually", "career", "project", "school", "relationship", "goal", "plan"
    ]);
  }

  private shouldAllowAutoContinuation(message: string): boolean {
    const normalized = message.toLowerCase();
    if (includesAny(normalized, [
      "别太长", "不要太长", "简短", "短一点", "一句话", "三句话", "不用展开",
      "keep it short", "briefly", "concise", "don't expand", "do not expand"
    ])) return false;

    return includesAny(normalized, [
      "详细展开", "完整展开", "写长文", "长文回答", "完整报告", "完整文档", "完整方案",
      "不要截断", "别截断", "如果不够就继续", "可以分多次", "继续写完",
      "detailed long-form", "expand fully", "complete report", "complete document",
      "do not truncate", "don't truncate", "continue if needed", "write a long"
    ]);
  }

  async decomposeIntent(input: IntentInput): Promise<IntentResult> {
    return this.retrieval.analyze(input.message);
  }

  async summarizeConversation(input: SummarizeInput): Promise<SummarizeResult> {
    const summary = truncateText(input.content.replace(/\s+/g, " "), 360);
    return { summary, anchors: [this.store.anchorFor(input.sourcePath)] };
  }

  async extractMemories(input: ExtractMemoryInput): Promise<ExtractMemoryResult> {
    return this.memoryExtractor.extract(input);
  }

  async rebuildIndex(): Promise<RebuildIndexResult> {
    return this.index.rebuild();
  }
}
