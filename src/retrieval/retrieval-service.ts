import { IntentResult, RetrievedMemory } from "../types";
import { extractKeywords, includesAny } from "../utils/text";
import { dateStamp, nowIso } from "../utils/time";
import { LocalIndex } from "../index/local-index";

const TIME_HINTS = ["以前", "小时候", "去年", "过去", "那时候", "当时", "童年", "ago", "when i was", "used to", "childhood", "years ago", "back then", "the other day"];
const REFERENCE_HINTS = ["笔记", "资料", "文档", "文件", "附件", "论文", "原文", "章节", "网页", "url", "链接", "obsidian", "reference", "知识库", "导入", "note", "document", "file", "attachment", "paper", "section", "webpage", "knowledge base", "import", "vault"];

export class RetrievalService {
  constructor(private readonly index: LocalIndex) {}

  analyze(message: string): IntentResult {
    const keywords = expandIntentKeywords(message, extractKeywords(message));
    const targetDates = extractTargetDates(message);
    const hasExplicitTimeHint = targetDates.length > 0
      || includesAny(message, TIME_HINTS)
      || /\d{4}年\s*\d{1,2}月\s*\d{1,2}日?/.test(message);
    const correction = includesAny(message, ["不对", "不是这样", "说错了", "记错了", "其实不是", "更准确", "that's not right", "not correct", "i was wrong", "more accurately", "correction"]);
    const recall = includesAny(message, ["还记得", "之前", "我以前", "我说过", "回忆", "想起来", "第一次聊天", "你知道我", "你记得我", "我告诉过你", "remember", "recall", "previously", "did i tell you", "do you know my"]);
    const wantsReference = includesAny(message, REFERENCE_HINTS);
    return {
      mode: correction ? "correction" : recall ? "recall" : "normal_chat",
      keywords,
      hasExplicitTimeHint,
      targetDates,
      wantsReference
    };
  }

  search(message: string, intent = this.analyze(message), extraKeywords: string[] = []): RetrievedMemory[] {
    const messageKeywords = intent.keywords.length ? intent.keywords : expandIntentKeywords(message, extractKeywords(message));
    const keywords = Array.from(new Set([...messageKeywords, ...extraKeywords.filter(kw => kw.length >= 2)]));
    const memories = this.index.memories
      .filter(memory => this.isInjectable(memory))
      .map(memory => {
        const { score, reason } = this.score(memory, keywords, intent);
        return { memory, score, reason, activatedAsL0: false };
      })
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked: RetrievedMemory[] = [];
    const nativeMatches = memories.filter(item => item.memory.type !== "reference" && item.score > 0).length;
    const caps: Record<string, number> = {
      correction: 5,
      memory_summary: 6,
      reference: 4
    };

    const now = nowIso();
    for (const item of memories) {
      if (item.memory.type === "reference" && !intent.wantsReference && nativeMatches >= 3) continue;
      const key = item.memory.type === "raw_memory" ? `raw_memory_${item.memory.level}` : item.memory.type ?? "other";
      if (caps[key] === undefined) caps[key] = 4;
      if (caps[key] <= 0) continue;
      caps[key] -= 1;
      item.activatedAsL0 = item.memory.type !== "reference" && item.memory.level === "L1";
      item.memory.lastReferenced = now;
      picked.push(item);
    }
    return picked.slice(0, 16);
  }

  searchTargetDateSummaries(dates: string[]): RetrievedMemory[] {
    if (!dates.length) return [];
    const datePaths = dates.map(date => {
      const [year, month] = date.split("-");
      return `Conversations/${year}/${month}/${date}.md`;
    });
    return this.index.memories
      .filter(memory => memory.type === "memory_summary" || memory.type === "raw_memory")
      .filter(memory => memory.status !== "archived")
      .filter(memory => {
        const anchors = [...memory.source, ...memory.anchors, memory.path];
        return datePaths.some(datePath => anchors.some(anchor => anchor.includes(datePath)));
      })
      .map(memory => {
        memory.lastReferenced = nowIso();
        return {
          memory,
          score: this.targetDateSummaryScore(memory),
          reason: `target_date_summary; type=${memory.type}; level=${memory.level ?? "-"}`,
          activatedAsL0: false
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private isInjectable(memory: { type?: string; anchors?: string[]; status?: string }): boolean {
    if (memory.status === "archived") return false;
    if (memory.type === "memory_summary" && (!memory.anchors || memory.anchors.length === 0)) return false;
    return true;
  }

  private score(memory: { type?: string; level?: string; title: string; summary: string; tags: string[]; priority?: string; status?: string }, keywords: string[], intent: IntentResult): { score: number; reason: string } {
    let score = 0;
    const haystack = `${memory.title}\n${memory.summary}\n${memory.tags.join(" ")}`.toLowerCase();
    for (const keyword of keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += 5;
    }
    if (memory.status === "superseded") score -= 20;
    if (memory.type === "correction") score += 30;
    if (memory.type === "memory_summary") score += memory.priority === "high" ? 18 : 12;
    if (memory.type === "reference") score += intent.wantsReference ? 10 : -6;
    if (memory.level === "L1") score += 12;
    if (intent.mode === "correction" && memory.status !== "superseded") score += 8;
    if (intent.mode === "recall") score += 4;
    if (!keywords.length && memory.level === "L1") score += 2;
    return { score, reason: `score=${score}; type=${memory.type}; level=${memory.level ?? "-"}` };
  }

  private targetDateSummaryScore(memory: { type?: string; level?: string; priority?: string }): number {
    let score = 0;
    if (memory.type === "memory_summary") score += 80;
    if (memory.type === "raw_memory") score += 45;
    if (memory.priority === "high") score += 10;
    if (memory.level === "L1") score += 6;
    return score;
  }
}

function expandIntentKeywords(message: string, keywords: string[]): string[] {
  const expanded = [...keywords];
  const add = (terms: string[]) => expanded.push(...terms);

  if (includesAny(message, ["大学", "本科", "研究生", "硕士", "博士", "专业", "学校", "学院", "毕业", "university", "college", "major", "graduated", "graduate school"])) {
    add(["教育", "大学", "本科", "专业", "学校", "学院", "毕业", "education", "university", "college", "major"]);
  }
  if (includesAny(message, ["毕业后", "第一份工作", "入职", "去了哪里", "工作", "公司", "职业", "after graduating", "first job", "joined", "work", "company", "career"])) {
    add(["毕业后", "第一份工作", "入职", "工作", "公司", "职业", "career", "job"]);
  }
  return Array.from(new Set(expanded)).slice(0, 32);
}

function extractTargetDates(message: string, now = new Date()): string[] {
  const dates: string[] = [];
  const push = (date: Date) => {
    if (Number.isNaN(date.getTime())) return;
    dates.push(dateStamp(date));
  };

  for (const [keyword, offset] of [["今天", 0], ["昨天", -1], ["前天", -2], ["today", 0], ["yesterday", -1], ["day before yesterday", -2]] as const) {
    if (message.includes(keyword)) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      push(date);
    }
  }

  for (const match of message.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    push(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  for (const match of message.matchAll(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?/g)) {
    push(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  for (const match of message.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日?/g)) {
    push(new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2])));
  }

  return Array.from(new Set(dates));
}
