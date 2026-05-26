import { describe, expect, it } from "vitest";
import { ollamaNumPredict, prepareOllamaMessages, shouldEnableOllamaThinking } from "../src/model/model-gateway";

describe("ollama thinking mode", () => {
  it("keeps summarize tasks on the responsive non-thinking path for now", () => {
    expect(shouldEnableOllamaThinking("summarize", [])).toBe(false);
  });

  it("keeps memory extraction fast and schema-focused", () => {
    expect(shouldEnableOllamaThinking("extract_memory", [
      { role: "user", content: "Summarize what I just said." }
    ])).toBe(false);
  });

  it("keeps explicit review and analysis chat requests responsive until streaming exists", () => {
    expect(shouldEnableOllamaThinking("chat", [
      { role: "user", content: "Review this week's discussion and give your analysis." }
    ])).toBe(false);
  });

  it("keeps ordinary chat responsive", () => {
    expect(shouldEnableOllamaThinking("chat", [
      { role: "user", content: "Hello, I feel a little tired today." }
    ])).toBe(false);
  });

  it("does not mistake timezone questions for retrospective analysis", () => {
    expect(shouldEnableOllamaThinking("chat", [
      { role: "user", content: "Why is it May 21 here? Are we in different time zones?" }
    ])).toBe(false);
  });

  it("respects explicit requests not to summarize", () => {
    expect(shouldEnableOllamaThinking("chat", [
      { role: "user", content: "Do not summarize. Just tell me what to do next." }
    ])).toBe(false);
  });
});

describe("ollama output budget", () => {
  it("caps foreground chat output for local Ollama responsiveness", () => {
    expect(ollamaNumPredict("chat", { maxOutputTokens: 4000 })).toBe(750);
  });

  it("keeps smaller user-configured output limits", () => {
    expect(ollamaNumPredict("chat", { maxOutputTokens: 700 })).toBe(700);
  });

  it("allows slightly larger background summarize output", () => {
    expect(ollamaNumPredict("summarize", { maxOutputTokens: 4000 })).toBe(1600);
  });
});

describe("ollama input budget", () => {
  it("trims verbose chat context before sending to local Ollama", () => {
    const messages = prepareOllamaMessages("chat", [
      { role: "system", content: "system ".repeat(1200) },
      { role: "system", content: "context ".repeat(1200) },
      { role: "user", content: "Please summarize my education and work history." }
    ]);

    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(6500);
    expect(messages.at(-1)?.content).toContain("Please summarize my education and work history.");
  });

  it("keeps small prompts untouched", () => {
    const messages = [
      { role: "system" as const, content: "You are Odyssey." },
      { role: "user" as const, content: "Hello" }
    ];
    expect(prepareOllamaMessages("chat", messages)).toEqual(messages);
  });
});
