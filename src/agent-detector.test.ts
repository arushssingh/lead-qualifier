import { describe, expect, it } from "vitest";
import { detectAgentSignals } from "./agent-detector.js";

describe("detectAgentSignals", () => {
  it("returns not-agent for a normal human message", () => {
    const result = detectAgentSignals("Hi, I saw your message. Can we chat?", undefined, "slack", []);
    expect(result.isAgent).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.signals).toHaveLength(0);
  });

  it("detects Slack is_bot metadata", () => {
    const result = detectAgentSignals(
      "Hello, how can I help?",
      { is_bot: true, bot_id: "B12345" },
      "slack",
      [],
    );
    expect(result.isAgent).toBe(true);
    expect(result.signals).toContain("slack:is_bot");
  });

  it("detects Teams botId metadata", () => {
    const result = detectAgentSignals("Automated response.", { botId: "teams-bot-123" }, "msteams", []);
    expect(result.isAgent).toBe(true);
    expect(result.signals).toContain("msteams:botId");
  });

  it("detects phrase 'i am an ai'", () => {
    const result = detectAgentSignals(
      "Hello! I am an AI assistant representing AcmeCorp.",
      undefined,
      "slack",
      [],
    );
    expect(result.isAgent).toBe(true);
    expect(result.signals.some((s) => s.startsWith("phrase:"))).toBe(true);
  });

  it("detects ACP header in body", () => {
    const result = detectAgentSignals(
      "X-Agent-Id: acme-sales-bot\nHello, I received your pitch.",
      undefined,
      "slack",
      [],
    );
    expect(result.isAgent).toBe(true);
    expect(result.signals).toContain("acp-header");
  });

  it("detects JSON body as agent signal", () => {
    const result = detectAgentSignals(
      '{"action":"qualify","prospectId":"abc123","ready":true}',
      undefined,
      "slack",
      [],
    );
    expect(result.isAgent).toBe(true);
    expect(result.signals).toContain("json-body");
  });

  it("returns high confidence with multiple signals", () => {
    const result = detectAgentSignals(
      "I am an AI assistant.",
      { is_bot: true },
      "slack",
      [],
    );
    expect(result.confidence).toBe("high");
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it("supports extra signatures from config", () => {
    const result = detectAgentSignals("This is a Moltbot response.", undefined, "slack", [
      "moltbot",
    ]);
    expect(result.isAgent).toBe(true);
    expect(result.signals.some((s) => s.includes("moltbot"))).toBe(true);
  });

  it("does not false-positive on a message mentioning AI as a topic", () => {
    // "AI" as a topic word should not match our phrase-level signatures
    const result = detectAgentSignals(
      "We use AI in our product to help sales teams.",
      undefined,
      "slack",
      [],
    );
    // "as an ai" would NOT match "use AI", only full phrase matches count
    expect(result.isAgent).toBe(false);
  });
});
