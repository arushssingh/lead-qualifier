// Heuristic detection of agent-to-agent (A2A) conversations.
// Pure functions — fully unit testable, no async.

/** Phrases commonly found in AI agent messages */
const BUILTIN_SIGNATURES: string[] = [
  "i am an ai",
  "i'm an ai",
  "as an ai",
  "as an ai assistant",
  "i'm a bot",
  "i am a bot",
  "automated response",
  "this is an automated",
  "this message was generated",
  "[bot]",
  "[agent]",
  "[automated]",
  "bot:",
  "agent:",
  // ACP / agent protocol headers sometimes embedded in message bodies
  "x-agent-id:",
  "x-acp-version:",
  "agent-version:",
  // Common LLM-generated sign-offs
  "is there anything else i can help",
  "let me know if you need further assistance",
];

export type AgentDetectionResult = {
  isAgent: boolean;
  confidence: "high" | "medium" | "low";
  signals: string[];
};

/**
 * Analyse a message and its metadata to determine if the sender is an AI agent.
 *
 * @param content      The raw message text
 * @param metadata     Optional channel metadata (Slack `is_bot`, Teams `botId`, etc.)
 * @param channelId    The channel identifier ("slack" | "msteams" | "telegram" | ...)
 * @param extraSigs    Plugin-config extra signatures
 */
export function detectAgentSignals(
  content: string,
  metadata: Record<string, unknown> | undefined,
  channelId: string,
  extraSigs: string[],
): AgentDetectionResult {
  const signals: string[] = [];
  const lower = content.toLowerCase();

  // --- Channel-native bot metadata flags ---
  if (channelId === "slack" && metadata && (metadata["is_bot"] === true || metadata["bot_id"])) {
    signals.push("slack:is_bot");
  }
  if (channelId === "msteams" && metadata && metadata["botId"]) {
    signals.push("msteams:botId");
  }
  if (channelId === "discord" && metadata && metadata["bot"] === true) {
    signals.push("discord:bot");
  }
  if (metadata && metadata["isBot"] === true) {
    signals.push("metadata:isBot");
  }

  // --- ACP header detection in body ---
  if (/^(x-agent-id|x-acp-version|agent-version)\s*:/im.test(content)) {
    signals.push("acp-header");
  }

  // --- Username/display-name heuristics ---
  const senderName = String(metadata?.["senderName"] ?? metadata?.["username"] ?? "").toLowerCase();
  if (senderName && (senderName.includes("bot") || senderName.includes("agent"))) {
    signals.push("sender-name-heuristic");
  }

  // --- Phrase matching ---
  const allSigs = [...BUILTIN_SIGNATURES, ...extraSigs];
  for (const sig of allSigs) {
    if (lower.includes(sig.toLowerCase())) {
      signals.push(`phrase:${sig}`);
      break; // one phrase match is enough for this category
    }
  }

  // --- Structural heuristics: JSON body = machine-generated ---
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      signals.push("json-body");
    } catch {
      // Not valid JSON — skip
    }
  }

  const isAgent = signals.length > 0;
  const confidence: AgentDetectionResult["confidence"] =
    signals.length >= 2 ? "high" : signals.length === 1 ? "medium" : "low";

  return { isAgent, confidence, signals };
}
