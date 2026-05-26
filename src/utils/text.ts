export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

export function extractKeywords(text: string): string[] {
  const normalized = text.toLowerCase();
  const ascii = normalized.match(/[a-z0-9_\-.]{2,}/g) ?? [];
  const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const semantic = IMPORTANT_CJK_TERMS.filter(term => normalized.includes(term));
  const words = [...ascii, ...semantic, ...cjk.flatMap(chunk => chunk.length <= 6 ? [chunk] : sliceCjk(chunk))];
  return Array.from(new Set(words)).slice(0, 24);
}

function sliceCjk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1 && out.length < 12; i++) {
    out.push(text.slice(i, i + 2));
  }
  for (let i = 0; i < text.length - 1; i += 2) {
    out.push(text.slice(i, Math.min(text.length, i + 4)));
  }
  return out;
}

const IMPORTANT_CJK_TERMS = [
  "大学",
  "本科",
  "研究生",
  "硕士",
  "博士",
  "专业",
  "学院",
  "学校",
  "毕业",
  "毕业后",
  "第一份工作",
  "入职",
  "工作",
  "公司",
  "职业",
  "经历",
  "家乡",
  "出生",
  "住在",
  "喜欢",
  "重视",
  "在意",
  "记得",
  "知道",
  "论文",
  "文档",
  "文件",
  "附件",
  "原文",
  "章节",
  "阶段"
];

export function includesAny(text: string, needles: string[]): boolean {
  const normalized = text.toLowerCase();
  return needles.some(needle => normalized.includes(needle.toLowerCase()));
}

export function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
}

export function detectLanguage(text: string): "zh" | "en" {
  const cjk = text.match(/[一-鿿]/g);
  return cjk && cjk.length >= 3 ? "zh" : "en";
}
