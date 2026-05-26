export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${renderYaml(frontmatter)}---\n\n${body.trim()}\n`;
}

export function parseMarkdown(text: string): ParsedMarkdown {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: {}, body: text };
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const yaml = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  return { frontmatter: parseYaml(yaml), body };
}

export function renderYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    appendYaml(lines, key, value, 0);
  }
  return lines.join("\n") + "\n";
}

function appendYaml(lines: string[], key: string, value: unknown, indent: number): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (typeof item === "string") {
        lines.push(`${pad}  - ${quoteYaml(item)}`);
      } else {
        lines.push(`${pad}  - ${JSON.stringify(item)}`);
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    lines.push(`${pad}${key}: ${JSON.stringify(value)}`);
    return;
  }
  lines.push(`${pad}${key}: ${quoteYaml(String(value ?? ""))}`);
}

function quoteYaml(value: string): string {
  if (/^[a-zA-Z0-9_\-./:]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\n/);
  let currentArrayKey: string | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const arrayMatch = line.match(/^\s*-\s+(.*)$/);
    if (arrayMatch && currentArrayKey) {
      const existing = result[currentArrayKey];
      if (Array.isArray(existing)) existing.push(unquoteYaml(arrayMatch[1]));
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, value] = keyMatch;
    if (value === "") {
      result[key] = [];
      currentArrayKey = key;
    } else {
      result[key] = unquoteYaml(value);
      currentArrayKey = null;
    }
  }
  return result;
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
