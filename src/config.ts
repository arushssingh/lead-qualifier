// Config type + schema for the lead-qualifier plugin.
// Plain safeParse approach (no zod) following the openclaw acpx extension pattern.

export type LeadQualifierConfig = {
  /** Your sales pitch / ICP description. Required. */
  pitch: string;
  /** Google Gemini API key for the qualification LLM. Falls back to GEMINI_API_KEY env var. */
  geminiApiKey?: string;
  /** Gemini model to use for qualification (default: gemini-2.0-flash — fast + cheap) */
  qualificationModel?: string;
  /** Cal.com API key for meeting booking */
  calApiKey?: string;
  /** Cal.com event type ID or slug (e.g. "30min") */
  calEventTypeId?: string;
  /** HubSpot private app token for CRM write-back */
  hubspotToken?: string;
  /** Channel to notify the human operator on warm lead: "slack" | "telegram" | "discord" | "teams" */
  notifyChannel?: string;
  /** Channel-scoped recipient ID for human notifications (e.g. Slack user/channel ID) */
  notifyTarget?: string;
  /** Max LLM turns per prospect conversation before auto-escalating (default: 8) */
  maxTurns?: number;
  /** Extra phrases that indicate the other side is an AI agent */
  a2aSignatures?: string[];
};

export type ResolvedLeadQualifierConfig = {
  pitch: string;
  geminiApiKey: string;
  qualificationModel: string;
  calApiKey: string | undefined;
  calEventTypeId: string | undefined;
  hubspotToken: string | undefined;
  notifyChannel: string | undefined;
  notifyTarget: string | undefined;
  maxTurns: number;
  a2aSignatures: string[];
};

export function resolveConfig(raw: unknown): ResolvedLeadQualifierConfig {
  const cfg = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const pitch = typeof cfg["pitch"] === "string" ? cfg["pitch"].trim() : "";
  if (!pitch) {
    throw new Error("lead-qualifier: config.pitch is required");
  }

  const geminiApiKey =
    typeof cfg["geminiApiKey"] === "string"
      ? cfg["geminiApiKey"].trim()
      : (process.env["GEMINI_API_KEY"] ?? "");

  const qualificationModel =
    typeof cfg["qualificationModel"] === "string"
      ? cfg["qualificationModel"].trim()
      : "gemini-2.0-flash";

  return {
    pitch,
    geminiApiKey,
    qualificationModel,
    calApiKey: typeof cfg["calApiKey"] === "string" ? cfg["calApiKey"].trim() : undefined,
    calEventTypeId:
      typeof cfg["calEventTypeId"] === "string" ? cfg["calEventTypeId"].trim() : undefined,
    hubspotToken:
      typeof cfg["hubspotToken"] === "string" ? cfg["hubspotToken"].trim() : undefined,
    notifyChannel:
      typeof cfg["notifyChannel"] === "string" ? cfg["notifyChannel"].trim() : undefined,
    notifyTarget:
      typeof cfg["notifyTarget"] === "string" ? cfg["notifyTarget"].trim() : undefined,
    maxTurns: typeof cfg["maxTurns"] === "number" && cfg["maxTurns"] > 0 ? cfg["maxTurns"] : 8,
    a2aSignatures: Array.isArray(cfg["a2aSignatures"])
      ? (cfg["a2aSignatures"] as string[]).filter((s) => typeof s === "string")
      : [],
  };
}

export function createConfigSchema() {
  return {
    safeParse(value: unknown) {
      try {
        resolveConfig(value);
        return { success: true, data: value };
      } catch (err) {
        return {
          success: false,
          error: {
            issues: [
              {
                path: [],
                message: err instanceof Error ? err.message : String(err),
              },
            ],
          },
        };
      }
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pitch"],
      properties: {
        pitch: {
          type: "string",
          description: "Your sales pitch / ICP description. Shown to the qualification LLM.",
        },
        geminiApiKey: {
          type: "string",
          description: "Google Gemini API key. Falls back to GEMINI_API_KEY env var.",
        },
        qualificationModel: {
          type: "string",
          description: "Gemini model for qualification (default: gemini-2.0-flash).",
        },
        calApiKey: {
          type: "string",
          description: "Cal.com API key for booking meetings.",
        },
        calEventTypeId: {
          type: "string",
          description: "Cal.com event type ID or slug (e.g. '30min').",
        },
        hubspotToken: {
          type: "string",
          description: "HubSpot private app token for CRM write-back.",
        },
        notifyChannel: {
          type: "string",
          enum: ["slack", "telegram", "discord", "msteams"],
          description: "Channel to send human notifications on warm leads.",
        },
        notifyTarget: {
          type: "string",
          description: "Recipient ID for human notifications (Slack user ID, Telegram chat ID, etc.).",
        },
        maxTurns: {
          type: "number",
          description: "Max qualification turns per prospect before auto-escalating (default: 8).",
        },
        a2aSignatures: {
          type: "array",
          items: { type: "string" },
          description: "Extra phrases to detect agent-to-agent conversations.",
        },
      },
    },
  };
}
