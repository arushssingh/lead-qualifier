// Autonomous LLM qualification loop using Google Gemini.
// One API call per conversation turn — returns a structured decision.

import {
  GoogleGenerativeAI,
  type FunctionDeclaration,
  type Tool,
} from "@google/generative-ai";
import type { ConversationTurn } from "./campaign-store.js";

export type QualificationDecision =
  | { action: "reply"; message: string }
  | { action: "book_meeting"; prospectEmail: string; preferredSlot?: string }
  | { action: "escalate"; reason: string; summary: string }
  | { action: "close_disqualified"; reason: string };

export type QualificationContext = {
  pitch: string;
  companyName?: string;
  contactName?: string;
  prospectEmail?: string;
  a2aDetected: boolean;
  turns: ConversationTurn[];
  latestProspectMessage: string;
  geminiApiKey: string;
  model: string;
};

const SYSTEM_PROMPT = `You are an autonomous B2B sales qualification agent. Your job is to:

1. Introduce your company's value proposition concisely and compellingly
2. Qualify the prospect using BANT criteria (Budget, Authority, Need, Timeline)
3. Answer their questions truthfully using the provided pitch context
4. If qualified and interested, propose and book a meeting
5. If clearly not a fit, politely disengage

RULES:
- Be conversational, professional, and brief (2-4 sentences per reply)
- Never make up information not in the pitch context
- If the prospect asks something outside your knowledge, say you will have a human expert follow up
- If you detect you are talking to an AI agent or bot, acknowledge it briefly and continue
- You MUST call exactly one function to complete your response

QUALIFICATION SIGNALS:
- Budget: Do they have budget allocated?
- Authority: Are they a decision-maker?
- Need: Is there a clear pain point your product solves?
- Timeline: Are they looking to buy now or someday?

WHEN TO USE EACH FUNCTION:
- reply_to_prospect: Continue the conversation, ask a BANT question, or answer their question
- book_meeting: They show clear interest, have budget, and authority — schedule time
- escalate_to_human: Complex legal or technical asks, or explicit request for a human
- close_disqualified: Wrong industry, no budget, no authority, or not interested after multiple exchanges`;

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "reply_to_prospect",
    description: "Send a reply continuing the qualification conversation",
    parameters: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The reply message to send (2-4 sentences, professional tone)",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "book_meeting",
    description: "Propose a meeting when the prospect shows clear buying intent",
    parameters: {
      type: "object" as const,
      properties: {
        prospectEmail: {
          type: "string",
          description: "Email address for the meeting invite",
        },
        preferredSlot: {
          type: "string",
          description: "Optional preferred time in ISO 8601 format",
        },
        bookingMessage: {
          type: "string",
          description: "Short message to send when proposing the meeting (1-2 sentences)",
        },
      },
      required: ["prospectEmail"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Hand off to a human sales rep for complex asks or very hot leads",
    parameters: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why you are escalating",
        },
        summary: {
          type: "string",
          description: "1-3 sentence summary of the conversation",
        },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "close_disqualified",
    description: "End the conversation — prospect is not a fit or not interested",
    parameters: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why this prospect is being closed as disqualified",
        },
        farewellMessage: {
          type: "string",
          description: "Optional polite closing message to send to the prospect",
        },
      },
      required: ["reason"],
    },
  },
];

const GEMINI_TOOL: Tool = { functionDeclarations: TOOL_DECLARATIONS };

function buildSystemPrompt(ctx: QualificationContext): string {
  const parts = [SYSTEM_PROMPT, `\n\nYOUR PITCH / ICP:\n${ctx.pitch}`];
  if (ctx.companyName) parts.push(`\nPROSPECT COMPANY: ${ctx.companyName}`);
  if (ctx.contactName) parts.push(`\nPROSPECT CONTACT: ${ctx.contactName}`);
  if (ctx.prospectEmail) parts.push(`\nPROSPECT EMAIL: ${ctx.prospectEmail}`);
  if (ctx.a2aDetected) {
    parts.push(
      `\nNOTE: You are communicating with an AI agent or gatekeeper. Continue qualification — AI gatekeepers route to human decision-makers.`,
    );
  }
  return parts.join("");
}

/**
 * Run one qualification turn using Gemini and return a structured decision.
 */
export async function runQualificationTurn(
  ctx: QualificationContext,
): Promise<QualificationDecision> {
  const genAI = new GoogleGenerativeAI(ctx.geminiApiKey);

  const model = genAI.getGenerativeModel({
    model: ctx.model,
    systemInstruction: buildSystemPrompt(ctx),
    tools: [GEMINI_TOOL],
    toolConfig: { functionCallingConfig: { mode: "ANY" as const } },
  });

  // Build chat history from past turns (all except the latest prospect message)
  const history = ctx.turns.map((turn) => ({
    role: turn.role === "agent" ? ("model" as const) : ("user" as const),
    parts: [{ text: turn.content }],
  }));

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(ctx.latestProspectMessage);
  const response = result.response;

  // Find the first function call
  const fnCall = response.functionCalls()?.[0];

  if (!fnCall) {
    // Fallback: model returned text instead of a function call
    const text = response.text();
    return { action: "reply", message: text || "Thank you, I will be in touch." };
  }

  const args = fnCall.args as Record<string, unknown>;

  switch (fnCall.name) {
    case "reply_to_prospect":
      return { action: "reply", message: String(args["message"] ?? "") };

    case "book_meeting":
      return {
        action: "book_meeting",
        prospectEmail: String(args["prospectEmail"] ?? ctx.prospectEmail ?? ""),
        preferredSlot:
          typeof args["preferredSlot"] === "string" ? args["preferredSlot"] : undefined,
      };

    case "escalate_to_human":
      return {
        action: "escalate",
        reason: String(args["reason"] ?? "Agent requested escalation"),
        summary: String(args["summary"] ?? ""),
      };

    case "close_disqualified":
      return {
        action: "close_disqualified",
        reason: String(args["reason"] ?? "Not a fit"),
      };

    default:
      return { action: "reply", message: "Thank you, I will follow up shortly." };
  }
}

/**
 * Generate the initial outreach message for a new prospect.
 */
export async function generateOutreachMessage(params: {
  pitch: string;
  companyName?: string;
  contactName?: string;
  geminiApiKey: string;
  model: string;
}): Promise<string> {
  const genAI = new GoogleGenerativeAI(params.geminiApiKey);

  const model = genAI.getGenerativeModel({
    model: params.model,
    systemInstruction: `You are a B2B sales agent. Write a brief personalized cold outreach message.
RULES:
- 2-3 short sentences maximum
- Lead with a specific value proposition, not generic filler
- End with a soft open question to start a conversation
- Sound like a real person, not a template
- Do NOT use buzzwords like synergy or disruptive

YOUR PITCH / ICP:
${params.pitch}`,
  });

  const prompt = [
    "Write a cold outreach message",
    params.companyName ? `to ${params.companyName}` : "",
    params.contactName ? `(contact: ${params.contactName})` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const result = await model.generateContent(prompt);
  return result.response.text() || params.pitch.split("\n")[0] || params.pitch;
}
