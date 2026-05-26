import { describe, expect, it } from "vitest";
import { evaluateExtractionProbeResponse, runExtractionModelProbe } from "../src/model/model-probe";

describe("extraction model probe", () => {
  it("passes when the model extracts explicit user facts only", () => {
    const result = evaluateExtractionProbeResponse(JSON.stringify({
      raw_memories: [
        {
          content: "The user currently works in Shenzhen.",
          level: "L1",
          tags: ["work", "Shenzhen"],
          confidence: "medium"
        }
      ],
      summaries: [
        {
          content: "The user currently works in Shenzhen.",
          kind: "important_fact",
          confidence: "medium"
        }
      ]
    }));

    expect(result.status).toBe("passed");
  });

  it("fails when the response is not valid JSON", () => {
    const result = evaluateExtractionProbeResponse("I will extract that the user works in Shenzhen.");

    expect(result.status).toBe("failed");
  });

  it("marks semantic contamination as partial", () => {
    const result = evaluateExtractionProbeResponse(JSON.stringify({
      raw_memories: [
        {
          content: "The user works in Shenzhen and needs a sense of control.",
          level: "L1",
          tags: ["Shenzhen", "control"],
          confidence: "medium"
        }
      ],
      summaries: []
    }));

    expect(result.status).toBe("partial");
  });

  it("wraps model call errors as failed probe results", async () => {
    const result = await runExtractionModelProbe({
      complete: async () => {
        throw new Error("model unavailable");
      }
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("model unavailable");
  });
});
