import { requestUrl } from "obsidian";
import { ChatMessage, OdysseySettings, ModelTask, resolveModelTier } from "../types";
import { truncateText } from "../utils/text";

const MODEL_REQUEST_TIMEOUT_MS = 60_000;

export interface ModelCompletion {
  content: string;
  finishReason?: string;
  outputLimited: boolean;
}

export class ModelGateway {
  constructor(private readonly getSettings: () => OdysseySettings) {}

  async complete(task: ModelTask, messages: ChatMessage[]): Promise<ModelCompletion> {
    const settings = this.getSettings();
    if (settings.modelProvider === "ollama") return this.ollama(task, messages, settings);
    if (settings.modelProvider === "anthropic") return this.anthropic(task, messages, settings);
    return this.openAiCompatible(task, messages, settings);
  }

  private modelFor(task: ModelTask, settings: OdysseySettings): string {
    if (task === "chat") return settings.chatModel;
    if (task === "summarize") return settings.summaryModel || settings.chatModel;
    return settings.extractionModel || settings.chatModel;
  }

  private async ollama(task: ModelTask, messages: ChatMessage[], settings: OdysseySettings): Promise<ModelCompletion> {
    const url = `${settings.apiBaseUrl.replace(/\/$/, "")}/api/chat`;
    const model = this.modelFor(task, settings);
    const tier = resolveModelTier(settings);
    const speedTier = tier === "constrained" ? settings.chatModelSpeedTier || "unknown" : "fast";
    const constrainedOptions = tier === "constrained" && task === "chat"
      ? (() => { const p = resolveModelPreset(model); return { temperature: p.temperature, top_p: p.topP, repeat_penalty: p.repeatPenalty }; })()
      : {};
    const preparedMessages = prepareOllamaMessages(task, messages);
    const body = JSON.stringify({
      model,
      messages: preparedMessages,
      stream: false,
      think: shouldEnableOllamaThinking(task, messages),
      options: { num_predict: ollamaNumPredict(task, settings, tier, speedTier), ...constrainedOptions }
    });
    // Use native fetch for localhost — Obsidian's requestUrl adds noticeable overhead
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const json = await response.json() as { message?: { content?: string }; response?: string; done_reason?: string; error?: string };
    if (typeof json.error === "string") throw new Error(`Ollama 返回错误：${json.error}`);
    const content = json.message?.content ?? json.response;
    if (!content) throw new Error("Ollama response did not include message content.");
    return {
      content,
      finishReason: json.done_reason,
      outputLimited: json.done_reason === "length"
    };
  }

  private async openAiCompatible(task: ModelTask, messages: ChatMessage[], settings: OdysseySettings): Promise<ModelCompletion> {
    const url = `${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const response = await this.requestModel({
      url,
      providerName: "OpenAI-compatible",
      settingsHint: "请确认 API Base URL、API Key 和模型名配置正确。",
      options: {
        url,
        method: "POST",
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          model: this.modelFor(task, settings),
          messages: messages.map(({ role, content }) => ({ role, content })),
          max_tokens: settings.maxOutputTokens
        })
      }
    });
    const json = response.json as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: { message?: string } | string };
    if (typeof json.error === "string") throw new Error(`OpenAI-compatible 返回错误：${json.error}`);
    if (json.error?.message) throw new Error(`OpenAI-compatible 返回错误：${json.error.message}`);
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new Error("OpenAI-compatible response did not include message content.");
    return {
      content,
      finishReason: choice?.finish_reason,
      outputLimited: choice?.finish_reason === "length"
    };
  }

  private async anthropic(task: ModelTask, messages: ChatMessage[], settings: OdysseySettings): Promise<ModelCompletion> {
    const url = `${settings.apiBaseUrl.replace(/\/$/, "")}/messages`;
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01"
    };
    if (settings.apiKey) headers["x-api-key"] = settings.apiKey;
    const response = await this.requestModel({
      url,
      providerName: "Anthropic",
      settingsHint: "请确认 Anthropic API Key、API Base URL 和 Claude 模型名配置正确。",
      options: {
        url,
        method: "POST",
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          model: this.modelFor(task, settings),
          system: collectSystemPrompt(messages),
          messages: normalizeAnthropicMessages(messages),
          max_tokens: settings.maxOutputTokens
        })
      }
    });
    const json = response.json as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      error?: { message?: string } | string;
    };
    if (typeof json.error === "string") throw new Error(`Anthropic 返回错误：${json.error}`);
    if (json.error?.message) throw new Error(`Anthropic 返回错误：${json.error.message}`);
    const content = (json.content ?? [])
      .filter(block => block.type === "text" || block.text)
      .map(block => block.text ?? "")
      .join("")
      .trim();
    if (!content) throw new Error("Anthropic response did not include text content.");
    return {
      content,
      finishReason: json.stop_reason,
      outputLimited: json.stop_reason === "max_tokens"
    };
  }

  private async requestModel(input: {
    url: string;
    providerName: string;
    settingsHint: string;
    options: Parameters<typeof requestUrl>[0];
  }): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    try {
      const response = await withTimeout(
        requestUrl(input.options),
        MODEL_REQUEST_TIMEOUT_MS,
        `${input.providerName} 模型请求超过 ${Math.round(MODEL_REQUEST_TIMEOUT_MS / 1000)} 秒未返回`
      );
      if (response.status >= 400) {
        throw new Error(`${input.providerName} HTTP ${response.status}: ${extractResponseMessage(response)}`);
      }
      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${input.providerName} 模型服务不可用：${input.url}。${input.settingsHint}。原始错误：${detail}`);
    }
  }
}

function collectSystemPrompt(messages: ChatMessage[]): string | undefined {
  const system = messages
    .filter(message => message.role === "system")
    .map(message => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  return system || undefined;
}

function normalizeAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const normalized: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content.trim();
    if (!content) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === role) {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      normalized.push({ role, content });
    }
  }
  if (normalized.length === 0) {
    normalized.push({ role: "user", content: "Continue." });
  }
  return normalized;
}

function extractResponseMessage(response: Awaited<ReturnType<typeof requestUrl>>): string {
  const json = response.json as { error?: { message?: string } | string } | undefined;
  if (typeof json?.error === "string") return json.error;
  if (json?.error?.message) return json.error.message;
  return response.text?.slice(0, 500) || "empty response";
}

export function shouldEnableOllamaThinking(task: ModelTask, messages: ChatMessage[]): boolean {
  void task;
  void messages;
  // Qwen thinking models return reasoning in a separate `thinking` field. With
  // stream:false, the UI waits for the full response and content can be empty if
  // the thinking trace exhausts num_predict. Keep this off until streaming or a
  // separate background thinking path is implemented.
  return false;
}

export function ollamaNumPredict(task: ModelTask, settings: Pick<OdysseySettings, "maxOutputTokens">, tier?: string, speedTier?: string): number {
  const configured = Math.max(128, Math.floor(settings.maxOutputTokens || 1024));
  if (task === "chat") {
    if (tier !== "constrained") return Math.min(configured, 750);
    // Scale output cap to model speed
    if (speedTier === "slow") return Math.min(configured, 200);
    if (speedTier === "medium") return Math.min(configured, 350);
    return Math.min(configured, 500);
  }
  if (task === "summarize") return Math.min(configured, 1600);
  return Math.min(configured, 1800);
}

export function prepareOllamaMessages(task: ModelTask, messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const budget = ollamaInputBudget(task);
  const normalized = messages.map(({ role, content }) => ({ role, content }));
  const total = normalized.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= budget) return normalized;

  const lastUserIndex = findLastIndex(normalized, message => message.role === "user");
  const firstSystemIndex = normalized.findIndex(message => message.role === "system");
  const output = normalized.map(message => ({ ...message, content: "" }));

  let remaining = budget;
  if (firstSystemIndex >= 0) {
    const maxSystem = task === "chat" ? 2600 : 2200;
    output[firstSystemIndex].content = truncateText(normalized[firstSystemIndex].content, Math.min(maxSystem, remaining));
    remaining -= output[firstSystemIndex].content.length;
  }

  if (lastUserIndex >= 0 && remaining > 0) {
    const maxUser = Math.min(2000, remaining);
    output[lastUserIndex].content = truncateText(normalized[lastUserIndex].content, maxUser);
    remaining -= output[lastUserIndex].content.length;
  }

  const middleIndexes = normalized
    .map((_, index) => index)
    .filter(index => index !== firstSystemIndex && index !== lastUserIndex)
    .reverse();
  for (const index of middleIndexes) {
    if (remaining <= 0) break;
    const share = Math.max(500, Math.floor(remaining / Math.max(1, middleIndexes.length)));
    output[index].content = truncateText(normalized[index].content, Math.min(share, remaining));
    remaining -= output[index].content.length;
  }

  return output
    .filter(message => message.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
}

function ollamaInputBudget(task: ModelTask): number {
  if (task === "chat") return 6500;
  if (task === "summarize") return 7500;
  return 6000;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

interface ModelPreset {
  temperature: number;
  topP: number;
  repeatPenalty: number;
}

const MODEL_PRESETS: Record<string, ModelPreset> = {
  "qwen3.5":       { temperature: 0.3, topP: 0.85, repeatPenalty: 1.2 },
  "qwen3":         { temperature: 0.3, topP: 0.85, repeatPenalty: 1.15 },
  "qwen2.5":       { temperature: 0.3, topP: 0.85, repeatPenalty: 1.15 },
  "qwen2":         { temperature: 0.3, topP: 0.85, repeatPenalty: 1.15 },
  "llama3.2":      { temperature: 0.3, topP: 0.9, repeatPenalty: 1.25 },
  "llama3.1":      { temperature: 0.3, topP: 0.9, repeatPenalty: 1.2 },
  "llama3":        { temperature: 0.3, topP: 0.9, repeatPenalty: 1.2 },
  "llama-3.1":     { temperature: 0.3, topP: 0.9, repeatPenalty: 1.2 },
  "deepseek-r1":   { temperature: 0.6, topP: 0.9, repeatPenalty: 1.05 },
  "deepseek-v4":   { temperature: 0.3, topP: 0.9, repeatPenalty: 1.1 },
  "deepseek-v3":   { temperature: 0.3, topP: 0.9, repeatPenalty: 1.1 },
  "phi4":          { temperature: 0.3, topP: 0.85, repeatPenalty: 1.15 },
  "phi3":          { temperature: 0.3, topP: 0.85, repeatPenalty: 1.2 },
  "mistral":       { temperature: 0.3, topP: 0.85, repeatPenalty: 1.15 },
  "gemma3":        { temperature: 0.3, topP: 0.9, repeatPenalty: 1.15 },
  "gemma2":        { temperature: 0.3, topP: 0.9, repeatPenalty: 1.15 },
};

const DEFAULT_MODEL_PRESET: ModelPreset = {
  temperature: 0.3, topP: 0.85, repeatPenalty: 1.15
};

function resolveModelPreset(modelName: string): ModelPreset {
  const lower = modelName.toLowerCase();
  for (const [pattern, preset] of Object.entries(MODEL_PRESETS)) {
    if (lower.includes(pattern)) return preset;
  }
  return DEFAULT_MODEL_PRESET;
}
