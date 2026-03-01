// Autonomous LLM qualification loop.
// Uses the Anthropic SDK directly — one API call per conversation turn.
// Returns a structured decision the caller dispatches.

import Anthropic from "@anthropic-ai/sdk";
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
  anthropicApiKey: string;
  model: string;
};

const SYSTEM_PROMPT = `You are an autonomous B2B sales qualification agent. Your job is to:

1. Introduce your company's value proposition concisely and compellingly
2. Qualify the prospect using BANT criteria (Budget, Authority, Need, Timeline)
3. Answer their questions truthfully using the provided pitch context
4. If qualified and interested, propose and book a meeting
5. If clearly not a fit, politely disengage

IMPORTANT RULES:
- Be conversational, professional, and brief (2-4 sentences per reply)
- Never make up information not in the pitch context
- If the prospect asks something outside your knowledge, say you'll have a human expert follow up
- If you detect you're talking to an AI agent/bot, acknowledge it briefly and continue — AI gatekeepers still route to human decision-makers
- You MUST call exactly one tool to complete your response — never reply with plain text

QUALIFICATION SIGNALS:
- Budget: Do they have budget allocated? Do they mention cost concerns?
- Authority: Are they a decision-maker or influencer?
- Need: Is there a clear pain point your product solves?
- Timeline: Are they looking to buy now, next quarter, or "someday"?

DECISION GUIDE:
- reply_to_prospect: Continue the conversation — ask a BANT question or answer their question
- book_meeting: They've shown clear interest + have budget + authority → schedule time
- escalate_to_human: Complex legal/technical asks, negative sentiment, or explicit request for human
- close_disqualified: Wrong industry, no budget, no authority, not interested after 2+ exchanges`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "reply_to_prospect",
    description: "Send a reply continuing the qualification conversation",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The reply message to send to the prospect (2-4 sentences, professional tone)",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "book_meeting",
    description:
      "Propose and book a meeting with the prospect. Use this when they show clear buying intent.",
    input_schema: {
      type: "object",
      properties: {
        prospectEmail: {
          type: "string",
          description: "Email address for the meeting invite",
        },
        preferredSlot: {
          type: "string",
          description: "Optional preferred meeting time in ISO 8601 format (e.g. 2026-03-10T14:00:00Z)",
        },
        bookingMessage: {
          type: "string",
          description:
            "Short message to send to the prospect when proposing the meeting (1-2 sentences)",
        },
      },
      required: ["prospectEmail"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand off to a human sales rep — use for complex asks, legal questions, or very hot leads",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you are escalating (brief, for the human operator)",
        },
        summary: {
          type: "string",
          description: "1-3 sentence summary of the conversation so far",
        },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "close_disqualified",
    description: "End the conversation — prospect is not a fit or not interested",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why this prospect is being closed as disqualified",
        },
        farewell_message: {
          type: "string",
          description: "Optional polite closing message to send to the prospect",
        },
      },
      required: ["reason"],
    },
  },
];

function buildMessages(ctx: QualificationContext): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  // Build conversation history
  for (const turn of ctx.turns) {
    messages.push({
      role: turn.role === "agent" ? "assistant" : "user",
      content: turn.content,
    });
  }

  // Current prospect message (may already be in turns, but we always add it explicitly
  // if turns is empty or the last turn is from the agent)
  const lastTurn = ctx.turns[ctx.turns.length - 1];
  if (!lastTurn || lastTurn.role === "agent") {
    messages.push({
      role: "user",
      content: ctx.latestProspectMessage,
    });
  }

  return messages;
}

function buildSystemPrompt(ctx: QualificationContext): string {
  const parts = [SYSTEM_PROMPT, `\n\n## YOUR PITCH / ICP\n${ctx.pitch}`];

  if (ctx.companyName) parts.push(`\n## PROSPECT COMPANY\n${ctx.companyName}`);
  if (ctx.contactName) parts.push(`\n## PROSPECT CONTACT\n${ctx.contactName}`);
  if (ctx.prospectEmail) parts.push(`\n## PROSPECT EMAIL\n${ctx.prospectEmail}`);
  if (ctx.a2aDetected) {
    parts.push(
      `\n## NOTE\nYou are communicating with an AI agent/gatekeeper. Continue the qualification — AI gatekeepers often route to human decision-makers.`,
    );
  }

  return parts.join("");
}

/**
 * Run one qualification turn and return a structured decision.
 * This is the core LLM call — kept stateless so the service can manage conversation state.
 */
export async function runQualificationTurn(
  ctx: QualificationContext,
): Promise<QualificationDecision> {
  const client = new Anthropic({ apiKey: ctx.anthropicApiKey });

  const response = await client.messages.create({
    model: ctx.model,
    max_tokens: 512,
    system: buildSystemPrompt(ctx),
    messages: buildMessages(ctx),
    tools: TOOLS,
    tool_choice: { type: "any" }, // Force tool use — no plain text replies
  });

  // Find the first tool_use block
  const toolUse = response.content.find((block) => block.type === "tool_use");

  if (!toolUse || toolUse.type !== "tool_use") {
    // Fallback: if the model returns text despite tool_choice:any, wrap it as a reply
    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text : "Thank you for your message. I'll follow up shortly.";
    return { action: "reply", message: text };
  }

  const input = toolUse.input as Record<string, unknown>;

  switch (toolUse.name) {
    case "reply_to_prospect":
      return { action: "reply", message: String(input["message"] ?? "") };

    case "book_meeting":
      return {
        action: "book_meeting",
        prospectEmail: String(input["prospectEmail"] ?? ctx.prospectEmail ?? ""),
        preferredSlot:
          typeof input["preferredSlot"] === "string" ? input["preferredSlot"] : undefined,
      };

    case "escalate_to_human":
      return {
        action: "escalate",
        reason: String(input["reason"] ?? "Agent requested escalation"),
        summary: String(input["summary"] ?? ""),
      };

    case "close_disqualified":
      return {
        action: "close_disqualified",
        reason: String(input["reason"] ?? "Not a fit"),
      };

    default:
      return { action: "reply", message: "Thank you, I'll be in touch." };
  }
}

/**
 * Generate the initial outreach message for a new prospect.
 */
export async function generateOutreachMessage(params: {
  pitch: string;
  companyName?: string;
  contactName?: string;
  anthropicApiKey: string;
  model: string;
}): Promise<string> {
  const client = new Anthropic({ apiKey: params.anthropicApiKey });

  const systemPrompt = `You are a B2B sales agent. Write a brief, personalized cold outreach message.

RULES:
- 2-3 short sentences maximum
- Lead with a specific value proposition (not generic)
- End with a soft question to start a conversation
- Do NOT be pushy, do NOT use buzzwords like "synergy" or "disruptive"
- Sound like a real person, not a template

## YOUR PITCH / ICP
${params.pitch}`;

  const userPrompt = [
    `Write a cold outreach message`,
    params.companyName ? `to ${params.companyName}` : "",
    params.contactName ? `(contact: ${params.contactName})` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const response = await client.messages.create({
    model: params.model,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content.find((b) => b.type === "text");
  return text && text.type === "text" ? text.text : params.pitch.split("\n")[0] ?? params.pitch;
}
