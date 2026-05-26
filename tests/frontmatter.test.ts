import { describe, expect, it } from "vitest";
import { parseMarkdown, renderMarkdown } from "../src/utils/frontmatter";

describe("frontmatter", () => {
  it("round trips simple yaml frontmatter", () => {
    const rendered = renderMarkdown({
      id: "mem_1",
      type: "raw_memory",
      tags: ["work", "pressure"],
      status: "active"
    }, "## Summary\n\nhello");
    const parsed = parseMarkdown(rendered);
    expect(parsed.frontmatter.id).toBe("mem_1");
    expect(parsed.frontmatter.type).toBe("raw_memory");
    expect(parsed.frontmatter.tags).toEqual(["work", "pressure"]);
    expect(parsed.body).toContain("hello");
  });
});
