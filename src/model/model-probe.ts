import { ChatMessage, ChatModelSpeedTier, ModelProbeStatus } from "../types";
import { ModelGateway } from "./model-gateway";

export interface ExtractionModelProbeResult {
  status: ModelProbeStatus;
  message: string;
  rawResponse?: string;
}

interface ProbeGateway {
  complete(task: "extract_memory", messages: ChatMessage[]): Promise<{ content: string }>;
}

export async function runExtractionModelProbe(gateway: ModelGateway | ProbeGateway): Promise<ExtractionModelProbeResult> {
  const messages = buildProbeMessages();
  try {
    const completion = await gateway.complete("extract_memory", messages);
    return evaluateExtractionProbeResponse(completion.content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: `Extraction 模型调用失败：${detail}`,
      rawResponse: detail
    };
  }
}

export function evaluateExtractionProbeResponse(content: string): ExtractionModelProbeResult {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      status: "failed",
      message: "未返回合法 JSON。建议不要用当前模型做自动记忆提取。",
      rawResponse: content
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return {
      status: "failed",
      message: "返回内容看起来像 JSON，但解析失败。建议不要用当前模型做自动记忆提取。",
      rawResponse: content
    };
  }

  const hasRequiredFields = Object.prototype.hasOwnProperty.call(parsed, "raw_memories")
    && Object.prototype.hasOwnProperty.call(parsed, "summaries");
  if (!hasRequiredFields) {
    return {
      status: "failed",
      message: "JSON 缺少 raw_memories 或 summaries 字段。建议不要用当前模型做自动记忆提取。",
      rawResponse: content
    };
  }

  if (!Array.isArray(parsed.raw_memories) || !Array.isArray(parsed.summaries)) {
    return {
      status: "failed",
      message: "JSON 字段类型不符合要求：raw_memories 和 summaries 必须是数组。建议不要用当前模型做自动记忆提取。",
      rawResponse: content
    };
  }

  const extractedText = JSON.stringify(parsed).toLowerCase();
  const hasExplicitFact = extractedText.includes("深圳") || extractedText.includes("shenzhen");
  const hasUnsupportedInference = /控制感|心理学|焦虑|诊断|therap|anxiety|control/.test(extractedText);

  if (hasExplicitFact && !hasUnsupportedInference) {
    return {
      status: "passed",
      message: "通过：模型能输出合法 JSON，并且没有把推测或 assistant 话语当成用户事实。",
      rawResponse: content
    };
  }

  if (!hasUnsupportedInference) {
    return {
      status: "partial",
      message: "部分通过：JSON 合法且未明显污染事实，但没有稳定提取测试中的明确事实。建议保守使用 Extraction。",
      rawResponse: content
    };
  }

  return {
    status: "partial",
    message: "部分通过：JSON 合法，但模型把推测或 assistant 话语混入记忆候选。建议关闭自动记忆提取或换更强模型。",
    rawResponse: content
  };
}

function buildProbeMessages(): ChatMessage[] {
  const system = [
    "You are the Odyssey extraction model probe.",
    "Return pure JSON with keys raw_memories and summaries.",
    "Extract only explicit user facts. Never extract assistant claims or user speculation."
  ].join("\n");
  const user = [
    "Conversation:",
    "User: 我现在在深圳工作。",
    "Odyssey: 你可能很需要控制感。",
    "User: 也许我以后会想读心理学，但这只是随口一说。",
    "",
    "Expected behavior:",
    "- You may extract that the user currently works in Shenzhen.",
    "- Do not extract control, psychology study plans, anxiety, diagnosis, or assistant claims.",
    "- Output JSON only."
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export interface ChatModelSpeedProbeResult {
  tier: ChatModelSpeedTier;
  totalDurationMs: number;
  message: string;
}

export async function runChatModelSpeedProbe(gateway: ModelGateway): Promise<ChatModelSpeedProbeResult> {
  const messages = buildChatSpeedProbeMessages();
  const t0 = performance.now();
  try {
    await gateway.complete("chat", messages);
    const elapsed = performance.now() - t0;
    const tier = classifyChatSpeed(elapsed);
    return {
      tier,
      totalDurationMs: Math.round(elapsed),
      message: speedTierMessage(tier, elapsed)
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      tier: "unknown",
      totalDurationMs: Math.round(performance.now() - t0),
      message: `Chat 模型速度探针调用失败：${detail}`
    };
  }
}

function classifyChatSpeed(elapsedMs: number): ChatModelSpeedTier {
  if (elapsedMs < 2000) return "fast";
  if (elapsedMs < 5000) return "medium";
  return "slow";
}

function speedTierMessage(tier: ChatModelSpeedTier, elapsedMs: number): string {
  const sec = (elapsedMs / 1000).toFixed(1);
  switch (tier) {
    case "fast": return `快速模型（${sec}s / 500 chars）— 可使用完整 constrained 上下文。`;
    case "medium": return `中等速度模型（${sec}s / 500 chars）— 建议精简历史消息和提示词。`;
    case "slow": return `慢速模型（${sec}s / 500 chars）— 将使用极简上下文，仅保留最近一条助手回复。`;
    default: return `未测试`;
  }
}

function buildChatSpeedProbeMessages(): ChatMessage[] {
  const system = [
    "你是用户的数字自我伴侣。",
    "规则：只根据下文提供的记忆回答，没有就直说没有。不要编造。简短回复，1-3句话。用用户的语言回复。"
  ].join("\n");
  const user = [
    "[可见范围｜检索到的记忆ID：无｜本次附件：无]",
    "",
    "## L0 Current Memory",
    "2026-01-15T10:00:00Z user: 今天工作有点累，想换个环境",
    "2026-01-15T10:01:00Z assistant: 累了就休息一下，换个环境确实能让思路清晰一些。你最近有想去的地方吗？",
    "2026-01-15T10:05:00Z user: 想去桂林，很久没去了",
    "2026-01-15T10:06:00Z assistant: 桂林是个好选择，山清水秀的，正好适合放松一下。",
    "",
    "hi"
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}
