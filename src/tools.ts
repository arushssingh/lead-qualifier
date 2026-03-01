// Agent-callable tools for the lead-qualifier plugin.
// Uses @sinclair/typebox for parameter schemas (matching openclaw's pin).

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  findProspectByTarget,
  loadStore,
  newProspectId,
  saveStore,
  upsertProspect,
  type ProspectRecord,
} from "./campaign-store.js";
import type { ResolvedLeadQualifierConfig } from "./config.js";
import { syncToHubSpot } from "./crm-sync.js";
import { bookMeeting } from "./meeting-booker.js";
import { notifyHuman } from "./notify.js";
import { generateOutreachMessage } from "./qualification-engine.js";

/** Shared store state passed in from the service (avoids redundant disk reads) */
export type ToolDeps = {
  stateDir: string;
  cfg: ResolvedLeadQualifierConfig;
  api: OpenClawPluginApi;
};

/** Send the first outreach message via the OpenClaw channel runtime */
async function sendOutboundMessage(
  api: OpenClawPluginApi,
  channel: string,
  target: string,
  text: string,
): Promise<void> {
  const ch = (api.runtime as unknown as Record<string, unknown>)["channel"] as
    | Record<string, unknown>
    | undefined;
  if (!ch) {
    api.logger.warn("lead-qualifier: runtime.channel unavailable for outbound send");
    return;
  }

  try {
    switch (channel) {
      case "slack": {
        const fn = (ch["slack"] as Record<string, unknown> | undefined)?.["sendMessageSlack"] as
          | ((t: string, msg: string, opts: object) => Promise<unknown>)
          | undefined;
        await fn?.(target, text, {});
        break;
      }
      case "telegram": {
        const fn = (ch["telegram"] as Record<string, unknown> | undefined)?.[
          "sendMessageTelegram"
        ] as ((t: string, msg: string) => Promise<unknown>) | undefined;
        await fn?.(target, text);
        break;
      }
      case "discord": {
        const fn = (ch["discord"] as Record<string, unknown> | undefined)?.["sendMessageDiscord"] as
          | ((t: string, msg: string, opts: object) => Promise<unknown>)
          | undefined;
        await fn?.(target, text, {});
        break;
      }
      case "msteams": {
        const fn = (ch["msteams"] as Record<string, unknown> | undefined)?.["sendMessageTeams"] as
          | ((t: string, msg: string, opts: object) => Promise<unknown>)
          | undefined;
        await fn?.(target, text, {});
        break;
      }
      default:
        api.logger.warn(`lead-qualifier: unsupported channel "${channel}" for outbound send`);
    }
  } catch (err) {
    api.logger.error(`lead-qualifier: outbound send failed: ${String(err)}`);
  }
}

export function registerLeadQualifierTools(api: OpenClawPluginApi, deps: ToolDeps): void {
  const { stateDir, cfg } = deps;

  // ─── Tool 1: qualify_lead ────────────────────────────────────────────────
  api.registerTool({
    name: "qualify_lead",
    label: "Qualify Lead",
    description:
      "Proactively reach out to a B2B prospect on a messaging channel and begin autonomous qualification. Creates a campaign record and sends the first outreach message.",
    parameters: Type.Object({
      channel: Type.String({
        description: 'Messaging channel to use. One of: "slack", "telegram", "discord", "msteams"',
      }),
      target: Type.String({
        description: "Channel-scoped recipient ID (e.g. Slack user/channel ID, Telegram chat ID)",
      }),
      companyName: Type.Optional(Type.String({ description: "Prospect's company name" })),
      contactName: Type.Optional(Type.String({ description: "Prospect contact's name" })),
      prospectEmail: Type.Optional(Type.String({ description: "Prospect's email address" })),
    }),
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_id: string, params: any) {
      const store = await loadStore(stateDir);

      // Avoid duplicate campaigns for the same target on the same channel
      const existing = findProspectByTarget(store, params.channel, params.target);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: `Campaign already active for ${params.channel}:${params.target} (id: ${existing.id}, status: ${existing.status})`,
            },
          ],
        };
      }

      const id = newProspectId();
      const now = Date.now();

      const outreachText = await generateOutreachMessage({
        pitch: cfg.pitch,
        companyName: params.companyName,
        contactName: params.contactName,
        geminiApiKey: cfg.geminiApiKey,
        model: cfg.qualificationModel,
      });

      const prospect: ProspectRecord = {
        id,
        channel: params.channel,
        target: params.target,
        companyName: params.companyName,
        contactName: params.contactName,
        prospectEmail: params.prospectEmail,
        status: "outreach_sent",
        a2aDetected: false,
        turns: [{ role: "agent", content: outreachText, ts: now }],
        createdAt: now,
        updatedAt: now,
      };

      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      await sendOutboundMessage(api, params.channel, params.target, outreachText);

      return {
        content: [
          {
            type: "text",
            text: `Campaign started (id: ${id}). Outreach sent to ${params.channel}:${params.target}\n\nMessage sent:\n${outreachText}`,
          },
        ],
      };
    },
  });

  // ─── Tool 2: book_meeting ────────────────────────────────────────────────
  api.registerTool({
    name: "book_meeting",
    label: "Book Meeting",
    description:
      "Book a Cal.com meeting with a qualified prospect and sync to HubSpot. Sends a confirmation message to the prospect and notifies the human operator.",
    parameters: Type.Object({
      campaignId: Type.String({ description: "The campaign/prospect ID from qualify_lead" }),
      prospectEmail: Type.String({ description: "Prospect email address for the meeting invite" }),
      preferredSlot: Type.Optional(
        Type.String({ description: "Preferred meeting time in ISO 8601 (e.g. 2026-03-10T14:00:00Z)" }),
      ),
    }),
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_id: string, params: any) {
      const store = await loadStore(stateDir);
      const prospect = store.prospects[params.campaignId];
      if (!prospect) {
        return {
          content: [{ type: "text", text: `Campaign ${params.campaignId} not found` }],
        };
      }

      // Book via Cal.com
      if (!cfg.calApiKey || !cfg.calEventTypeId) {
        return {
          content: [
            {
              type: "text",
              text: "Cal.com not configured (calApiKey + calEventTypeId required). Please set up in plugin config.",
            },
          ],
        };
      }

      const booking = await bookMeeting({
        calApiKey: cfg.calApiKey,
        eventTypeId: cfg.calEventTypeId,
        prospectEmail: params.prospectEmail,
        prospectName: prospect.contactName,
        preferredStartTime: params.preferredSlot,
      });

      if (!booking.ok) {
        return { content: [{ type: "text", text: `Booking failed: ${booking.error}` }] };
      }

      // Update campaign
      const now = Date.now();
      prospect.status = "booked";
      prospect.meetingUrl = booking.meetingUrl;
      prospect.meetingStartTime = booking.startTime;
      prospect.prospectEmail = params.prospectEmail;
      prospect.updatedAt = now;

      // Sync to HubSpot
      if (cfg.hubspotToken) {
        const crmResult = await syncToHubSpot(cfg.hubspotToken, {
          email: params.prospectEmail,
          name: prospect.contactName,
          company: prospect.companyName,
          channel: prospect.channel,
          status: "booked",
          meetingUrl: booking.meetingUrl,
        });
        if (crmResult.ok) {
          prospect.hubspotContactId = crmResult.contactId;
        }
      }

      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      // Send confirmation to prospect
      const confirmMsg = `Great! I've booked time for us. Here's your meeting link: ${booking.meetingUrl}`;
      await sendOutboundMessage(api, prospect.channel, prospect.target, confirmMsg);

      // Notify human operator
      if (cfg.notifyChannel && cfg.notifyTarget) {
        await notifyHuman({
          runtime: api.runtime,
          notifyChannel: cfg.notifyChannel,
          notifyTarget: cfg.notifyTarget,
          prospect,
          reason: "meeting_booked",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Meeting booked!\nMeeting URL: ${booking.meetingUrl}\nStart: ${booking.startTime}\nProspect notified. Human operator notified.`,
          },
        ],
      };
    },
  });

  // ─── Tool 3: escalate_to_human ───────────────────────────────────────────
  api.registerTool({
    name: "escalate_to_human",
    label: "Escalate Lead to Human",
    description:
      "Notify the human operator that a lead needs personal attention — use for hot leads, complex asks, or when human judgment is needed.",
    parameters: Type.Object({
      campaignId: Type.String({ description: "The campaign/prospect ID" }),
      reason: Type.String({ description: "Why this is being escalated (shown to the human)" }),
      summary: Type.Optional(
        Type.String({ description: "1-3 sentence summary of the conversation" }),
      ),
    }),
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_id: string, params: any) {
      const store = await loadStore(stateDir);
      const prospect = store.prospects[params.campaignId];
      if (!prospect) {
        return { content: [{ type: "text", text: `Campaign ${params.campaignId} not found` }] };
      }

      prospect.status = "escalated";
      prospect.updatedAt = Date.now();
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      if (cfg.notifyChannel && cfg.notifyTarget) {
        await notifyHuman({
          runtime: api.runtime,
          notifyChannel: cfg.notifyChannel,
          notifyTarget: cfg.notifyTarget,
          prospect,
          reason: "manual_escalation",
          summary: params.summary,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Campaign ${params.campaignId} escalated to human. Reason: ${params.reason}`,
          },
        ],
      };
    },
  });
}
