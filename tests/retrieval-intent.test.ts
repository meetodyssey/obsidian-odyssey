import { describe, expect, it } from "vitest";
import { RetrievalService } from "../src/retrieval/retrieval-service";
import { IndexedMemory } from "../src/types";

describe("retrieval intent date hints", () => {
  it("extracts ISO dates for explicit recall requests", () => {
    const service = new RetrievalService({ memories: [] } as any);

    const intent = service.analyze("Recall how I felt when we first chatted on 2026-05-13.");

    expect(intent.mode).toBe("recall");
    expect(intent.hasExplicitTimeHint).toBe(true);
    expect(intent.targetDates).toContain("2026-05-13");
  });

  it("extracts ISO dates for conversation lookups", () => {
    const service = new RetrievalService({ memories: [] } as any);

    const intent = service.analyze("What did I say on 2026-05-13?");

    expect(intent.hasExplicitTimeHint).toBe(true);
    expect(intent.targetDates).toEqual(["2026-05-13"]);
  });

  it("expands education and post-graduation questions into profile recall", () => {
    const unrelated: IndexedMemory = {
      id: "sum_work",
      path: "Odyssey/memories/sum_work.md",
      title: "Technical experience",
      type: "memory_summary",
      level: "L1",
      created: "2026-05-16T08:00:00.000Z",
      updated: "2026-05-16T08:00:00.000Z",
      tags: ["technical"],
      summary: "The user led a network research project and built a schema parser.",
      status: "active",
      source: [],
      anchors: ["[[Odyssey/memories/raw_work.md#raw_work]]"],
      correctionLinks: [],
      entities: []
    };
    const education: IndexedMemory = {
      id: "sum_education",
      path: "Odyssey/memories/sum_education.md",
      title: "Education and first job",
      type: "memory_summary",
      level: "L1",
      created: "2026-05-16T08:01:00.000Z",
      updated: "2026-05-16T08:01:00.000Z",
      tags: ["education", "university", "graduated", "major"],
      summary: "The user graduated from Sample University in communications engineering and joined Example Labs afterward.",
      status: "active",
      source: [],
      anchors: ["[[Odyssey/memories/raw_education.md#raw_education]]"],
      correctionLinks: [],
      entities: []
    };
    const service = new RetrievalService({ memories: [unrelated, education] } as any);

    const intent = service.analyze("Do you know my university and where I worked after graduating?");
    const results = service.search("Do you know my university and where I worked after graduating?", intent);

    expect(intent.mode).toBe("recall");
    expect(intent.keywords).toEqual(expect.arrayContaining(["education", "university", "major", "career"]));
    expect(results[0].memory.id).toBe("sum_education");
  });

});
