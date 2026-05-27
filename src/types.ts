export type ModelProvider = "ollama" | "openai-compatible" | "anthropic";
export type ModelTask = "chat" | "summarize" | "extract_memory";
export type ModelTier = "auto" | "constrained" | "standard" | "frontier";
export type ResolvedModelTier = "constrained" | "standard" | "frontier";
export type ModelProbeStatus = "unknown" | "passed" | "partial" | "failed";
export type ChatModelSpeedTier = "unknown" | "fast" | "medium" | "slow";
export type MemoryExtractionMode =
  | "not_triggered"
  | "ephemeral"
  | "disabled"
  | "ai_extraction"
  | "degraded_ai_extraction"
  | "rule_fallback";
export type RecordLevel = "L0" | "L1";
export type AgentRecordType =
  | "conversation"
  | "raw_memory"
  | "memory_summary"
  | "correction"
  | "reference"
  | "export_bundle"
  | "feedback";
export type AgentRecordStatus = "active" | "superseded" | "uncertain" | "archived";

export interface RetrievalWeights {
  baseWeight: number;
  correctionBoost: number;
  memorySummaryBoost: number;
  referenceBoost: number;
  l1Boost: number;
  supersededPenalty: number;
  rankingCorrectionBoost: number;
  rankingSummaryBoost: number;
  rankingReferenceBoost: number;
}

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  baseWeight: 20,
  correctionBoost: 80,
  memorySummaryBoost: 65,
  referenceBoost: 10,
  l1Boost: 20,
  supersededPenalty: 70,
  rankingCorrectionBoost: 30,
  rankingSummaryBoost: 18,
  rankingReferenceBoost: -6
};

export interface OdysseySettings {
  rootDir: string;
  odysseyName: string;
  userAvatar: string;
  odysseyAvatar: string;
  shadowIndexDir: string;
  shadowIndexSecret: string;
  modelProvider: ModelProvider;
  modelTier: ModelTier;
  apiBaseUrl: string;
  apiKey: string;
  chatModel: string;
  summaryModel: string;
  extractionModel: string;
  extractionModelProbeStatus: ModelProbeStatus;
  extractionModelProbeMessage: string;
  extractionModelProbeUpdatedAt: string;
  chatModelSpeedTier: ChatModelSpeedTier;
  chatModelSpeedProbeUpdatedAt: string;
  autoExtractMemories: boolean;
  maxInputChars: number;
  maxOutputTokens: number;
  maxContinuationTurns: number;
  lockOnOpen: boolean;
  lockMemoryFilesByDefault: boolean;
  autoLockMinutes: number;
  privacyLockPasscodeHash: string;
  hideDebugByDefault: boolean;
  systemPrompt: string;
  retrievalWeights: RetrievalWeights;
}

export const DEFAULT_SETTINGS: OdysseySettings = {
  rootDir: "Odyssey",
  odysseyName: "Odyssey",
  userAvatar: "Me",
  odysseyAvatar: "O",
  shadowIndexDir: ".odyssey",
  shadowIndexSecret: "",
  modelProvider: "ollama",
  modelTier: "auto",
  apiBaseUrl: "http://127.0.0.1:11434",
  apiKey: "",
  chatModel: "llama3.1",
  summaryModel: "llama3.1",
  extractionModel: "llama3.1",
  extractionModelProbeStatus: "unknown",
  extractionModelProbeMessage: "尚未测试 Extraction 模型。Chat 可先使用，记忆提取建议使用 14B+ 本地模型或 GPT-4o-mini+。",
  extractionModelProbeUpdatedAt: "",
  chatModelSpeedTier: "unknown",
  chatModelSpeedProbeUpdatedAt: "",
  autoExtractMemories: true,
  maxInputChars: 12000,
  maxOutputTokens: 4000,
  maxContinuationTurns: 2,
  lockOnOpen: true,
  lockMemoryFilesByDefault: true,
  autoLockMinutes: 5,
  privacyLockPasscodeHash: "",
  hideDebugByDefault: true,
  systemPrompt: "",
  retrievalWeights: { ...DEFAULT_RETRIEVAL_WEIGHTS }
};

export function normalizeSettings(raw: unknown): OdysseySettings {
  const saved = isRecord(raw) ? raw : {};
  return {
    rootDir: normalizeRootDir(saved.rootDir),
    odysseyName: readString(saved.odysseyName ?? saved.digitalSelfName, DEFAULT_SETTINGS.odysseyName),
    userAvatar: readString(saved.userAvatar, DEFAULT_SETTINGS.userAvatar),
    odysseyAvatar: readString(saved.odysseyAvatar, DEFAULT_SETTINGS.odysseyAvatar),
    shadowIndexDir: readString(saved.shadowIndexDir, DEFAULT_SETTINGS.shadowIndexDir),
    shadowIndexSecret: readString(saved.shadowIndexSecret, DEFAULT_SETTINGS.shadowIndexSecret),
    modelProvider: saved.modelProvider === "openai-compatible" || saved.modelProvider === "ollama" || saved.modelProvider === "anthropic"
      ? saved.modelProvider
      : DEFAULT_SETTINGS.modelProvider,
    modelTier: readModelTier(saved.modelTier),
    apiBaseUrl: readString(saved.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl),
    apiKey: readString(saved.apiKey, DEFAULT_SETTINGS.apiKey),
    chatModel: readString(saved.chatModel, DEFAULT_SETTINGS.chatModel),
    summaryModel: readString(saved.summaryModel, DEFAULT_SETTINGS.summaryModel),
    extractionModel: readString(saved.extractionModel, DEFAULT_SETTINGS.extractionModel),
    extractionModelProbeStatus: readProbeStatus(saved.extractionModelProbeStatus),
    extractionModelProbeMessage: readString(saved.extractionModelProbeMessage, DEFAULT_SETTINGS.extractionModelProbeMessage),
    extractionModelProbeUpdatedAt: readString(saved.extractionModelProbeUpdatedAt, DEFAULT_SETTINGS.extractionModelProbeUpdatedAt),
    chatModelSpeedTier: readChatSpeedTier(saved.chatModelSpeedTier),
    chatModelSpeedProbeUpdatedAt: readString(saved.chatModelSpeedProbeUpdatedAt, DEFAULT_SETTINGS.chatModelSpeedProbeUpdatedAt),
    autoExtractMemories: readBoolean(saved.autoExtractMemories, DEFAULT_SETTINGS.autoExtractMemories),
    maxInputChars: readNumber(saved.maxInputChars, DEFAULT_SETTINGS.maxInputChars),
    maxOutputTokens: readNumber(saved.maxOutputTokens, DEFAULT_SETTINGS.maxOutputTokens),
    maxContinuationTurns: readNumber(saved.maxContinuationTurns, DEFAULT_SETTINGS.maxContinuationTurns),
    lockOnOpen: readBoolean(saved.lockOnOpen, DEFAULT_SETTINGS.lockOnOpen),
    lockMemoryFilesByDefault: readBoolean(saved.lockMemoryFilesByDefault, DEFAULT_SETTINGS.lockMemoryFilesByDefault),
    autoLockMinutes: readNumber(saved.autoLockMinutes, DEFAULT_SETTINGS.autoLockMinutes),
    privacyLockPasscodeHash: readString(saved.privacyLockPasscodeHash, DEFAULT_SETTINGS.privacyLockPasscodeHash),
    hideDebugByDefault: readBoolean(saved.hideDebugByDefault, DEFAULT_SETTINGS.hideDebugByDefault),
    systemPrompt: readString(saved.systemPrompt, DEFAULT_SETTINGS.systemPrompt),
    retrievalWeights: readWeights(saved.retrievalWeights)
  };
}

function normalizeRootDir(value: unknown): string {
  const root = readString(value, DEFAULT_SETTINGS.rootDir).trim();
  if (!root || root === "DigitalSelf") return DEFAULT_SETTINGS.rootDir;
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readProbeStatus(value: unknown): ModelProbeStatus {
  return value === "passed" || value === "partial" || value === "failed" || value === "unknown"
    ? value
    : DEFAULT_SETTINGS.extractionModelProbeStatus;
}

function readChatSpeedTier(value: unknown): ChatModelSpeedTier {
  return value === "fast" || value === "medium" || value === "slow" || value === "unknown"
    ? value
    : DEFAULT_SETTINGS.chatModelSpeedTier;
}

function readModelTier(value: unknown): ModelTier {
  return value === "auto" || value === "constrained" || value === "standard" || value === "frontier"
    ? value
    : DEFAULT_SETTINGS.modelTier;
}

// Resolve the effective capability tier. "auto" infers from the provider:
// local models (Ollama) follow long, multi-rule prompts unreliably regardless
// of language, so they get the constrained prompt profile.
export function resolveModelTier(settings: OdysseySettings): ResolvedModelTier {
  if (settings.modelTier !== "auto") return settings.modelTier;
  if (settings.modelProvider === "ollama") return "constrained";
  if (settings.modelProvider === "anthropic") return "frontier";
  return "standard";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readWeights(value: unknown): RetrievalWeights {
  if (!isRecord(value)) return { ...DEFAULT_RETRIEVAL_WEIGHTS };
  return {
    baseWeight: readNumber(value.baseWeight, DEFAULT_RETRIEVAL_WEIGHTS.baseWeight),
    correctionBoost: readNumber(value.correctionBoost, DEFAULT_RETRIEVAL_WEIGHTS.correctionBoost),
    memorySummaryBoost: readNumber(value.memorySummaryBoost, DEFAULT_RETRIEVAL_WEIGHTS.memorySummaryBoost),
    referenceBoost: readNumber(value.referenceBoost, DEFAULT_RETRIEVAL_WEIGHTS.referenceBoost),
    l1Boost: readNumber(value.l1Boost, DEFAULT_RETRIEVAL_WEIGHTS.l1Boost),
    supersededPenalty: readNumber(value.supersededPenalty, DEFAULT_RETRIEVAL_WEIGHTS.supersededPenalty),
    rankingCorrectionBoost: readNumber(value.rankingCorrectionBoost, DEFAULT_RETRIEVAL_WEIGHTS.rankingCorrectionBoost),
    rankingSummaryBoost: readNumber(value.rankingSummaryBoost, DEFAULT_RETRIEVAL_WEIGHTS.rankingSummaryBoost),
    rankingReferenceBoost: readNumber(value.rankingReferenceBoost, DEFAULT_RETRIEVAL_WEIGHTS.rankingReferenceBoost)
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  created?: string;
  ephemeral?: boolean;
}

export interface AttachedReference {
  id: string;
  title: string;
  path: string;
  summary: string;
  excerpt: string;
}

export interface SendMessageInput {
  message: string;
  attachedReferences?: AttachedReference[];
  ephemeral?: boolean;
}

export interface SendMessageResult {
  assistantMessage: ChatMessage;
  assistantMessages: ChatMessage[];
  referencedMemoryIds: string[];
  contextBudgetReport: ContextBudgetReport;
  memoryExtractionStatus: MemoryExtractionStatus;
  warnings: string[];
}

export interface IntentInput {
  message: string;
}

export interface IntentResult {
  mode: "normal_chat" | "recall" | "correction" | "intent_decomposition" | "tool_selection";
  keywords: string[];
  hasExplicitTimeHint: boolean;
  targetDates?: string[];
  wantsReference?: boolean;
}

export interface SummarizeInput {
  sourcePath: string;
  content: string;
}

export interface SummarizeResult {
  summary: string;
  anchors: string[];
}

export interface ExtractMemoryInput {
  conversationPath: string;
  userMessage: string;
  assistantMessage?: string;
  recentMessages?: ChatMessage[];
  consolidationMode?: "turn" | "l0_window";
  forceRuleBased?: boolean;
}

export interface ExtractMemoryResult {
  rawMemoryIds: string[];
  summaryIds: string[];
  correctionIds: string[];
  changedPaths?: string[];
}

export interface RebuildIndexResult {
  documentCount: number;
  memoryCount: number;
  shadowEntryCount?: number;
}

export interface ReferenceImportResult {
  scannedCount: number;
  importedCount: number;
  skippedCount: number;
}

export interface MemoryExtractionStatus {
  mode: MemoryExtractionMode;
  label: string;
  detail: string;
  probeStatus: ModelProbeStatus;
  consolidationMode?: ExtractMemoryInput["consolidationMode"];
  backgroundJobQueued: boolean;
}

export interface AgentRuntime {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  endSession(): void;
  decomposeIntent(input: IntentInput): Promise<IntentResult>;
  summarizeConversation(input: SummarizeInput): Promise<SummarizeResult>;
  extractMemories(input: ExtractMemoryInput): Promise<ExtractMemoryResult>;
  rebuildIndex(): Promise<RebuildIndexResult>;
}

export interface AgentRecordMeta {
  id: string;
  type: AgentRecordType;
  level?: RecordLevel;
  created: string;
  source?: string[];
  anchors?: string[];
  tags?: string[];
  entities?: string[];
  confidence?: "low" | "medium" | "high";
  status: AgentRecordStatus;
  superseded_by?: string[];
  corrects?: string[];
  summary_kind?: "summary" | "important_fact" | "pattern";
  priority?: "low" | "normal" | "high";
}

export interface IndexedDocument {
  path: string;
  title: string;
  type?: AgentRecordType;
  level?: RecordLevel;
  created?: string;
  updated?: string;
  tags: string[];
  summary: string;
}

export interface IndexedMemory extends IndexedDocument {
  id: string;
  status: AgentRecordStatus;
  source: string[];
  anchors: string[];
  correctionLinks: string[];
  entities: string[];
  confidence?: "low" | "medium" | "high";
  summaryKind?: string;
  priority?: "low" | "normal" | "high";
  lastReferenced?: string;
}

export interface LocalIndexData {
  documents: IndexedDocument[];
  memories: IndexedMemory[];
  rebuiltAt: string;
}

export interface ShadowIndexEntry {
  id: string;
  path: string;
  type?: AgentRecordType;
  level?: RecordLevel;
  sourceAnchors: string[];
  internalTags: string[];
  intentCategories: string[];
  retrievalWeight: number;
  rankingBoost: number;
  correctionLinks: string[];
  sourceRange?: {
    path: string;
    startLine?: number;
    endLine?: number;
  };
  status?: AgentRecordStatus;
  updatedAt: string;
}

export interface ShadowIndexData {
  version: 1;
  rebuiltAt: string;
  entries: Record<string, ShadowIndexEntry>;
}

export interface RetrievedMemory {
  memory: IndexedMemory;
  score: number;
  reason: string;
  activatedAsL0: boolean;
}

export interface ContextBudgetReport {
  modelContextLimit: number;
  estimatedInputChars: number;
  reservedOutputTokens: number;
  sections: Record<string, number>;
  droppedSections: string[];
}

export interface BuiltContext {
  messages: ChatMessage[];
  referencedMemoryIds: string[];
  retrievedMemories: RetrievedMemory[];
  report: ContextBudgetReport;
  warnings: string[];
}
