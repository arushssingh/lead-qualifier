// Background service: wires the message_received hook and drives the campaign state machine.
// Reactive only — no polling, no timers.

import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import {
  findProspectByTarget,
  loadStore,
  saveStore,
  upsertProspect,
  type CampaignStore,
  type ProspectRecord,
} from "./campaign-store.js";
import type { ResolvedLeadQualifierConfig } from "./config.js";
import { syncToHubSpot } from "./crm-sync.js";
import { detectAgentSignals } from "./agent-detector.js";
import { bookMeeting } from "./meeting-booker.js";
import { notifyHuman } from "./notify.js";
import { runQualificationTurn } from "./qualification-engine.js";

type SendFn = (target: string, text: string, opts?: object) => Promise<unknown>;

function getSendFn(api: OpenClawPluginApi, channel: string): SendFn | undefined {
  const ch = (api.runtime as unknown as Record<string, unknown>)["channel"] as
    | Record<string, unknown>
    | undefined;
  if (!ch) return undefined;

  const channelRuntime = ch[channel] as Record<string, unknown> | undefined;
  if (!channelRuntime) return undefined;

  const methodName =
    channel === "slack"
      ? "sendMessageSlack"
      : channel === "telegram"
        ? "sendMessageTelegram"
        : channel === "discord"
          ? "sendMessageDiscord"
          : channel === "msteams"
            ? "sendMessageTeams"
            : undefined;

  if (!methodName) return undefined;
  return channelRuntime[methodName] as SendFn | undefined;
}

async function sendReply(api: OpenClawPluginApi, channel: string, target: string, text: string) {
  const send = getSendFn(api, channel);
  if (send) {
    await send(target, text, {});
  } else {
    api.logger.warn(`lead-qualifier: no send function for channel "${channel}"`);
  }
}

async function handleProspectReply(
  api: OpenClawPluginApi,
  cfg: ResolvedLeadQualifierConfig,
  store: CampaignStore,
  stateDir: string,
  prospect: ProspectRecord,
  inboundContent: string,
  channelId: string,
  metadata: Record<string, unknown> | undefined,
): Promise<void> {
  const now = Date.now();

  // Detect A2A
  const detection = detectAgentSignals(inboundContent, metadata, channelId, cfg.a2aSignatures);
  if (detection.isAgent && !prospect.a2aDetected) {
    prospect.a2aDetected = true;
    api.logger.info(
      `lead-qualifier: A2A detected for prospect ${prospect.id} (signals: ${detection.signals.join(", ")})`,
    );
  }

  // Record the prospect's turn
  prospect.turns.push({ role: "prospect", content: inboundContent, ts: now });
  prospect.status = "qualifying";
  prospect.updatedAt = now;

  // Auto-escalate if we've hit the turn limit
  if (prospect.turns.length >= cfg.maxTurns * 2) {
    prospect.status = "escalated";
    upsertProspect(store, prospect);
    await saveStore(stateDir, store);

    api.logger.info(`lead-qualifier: max turns reached for prospect ${prospect.id}, escalating`);

    if (cfg.notifyChannel && cfg.notifyTarget) {
      await notifyHuman({
        runtime: api.runtime,
        notifyChannel: cfg.notifyChannel,
        notifyTarget: cfg.notifyTarget,
        prospect,
        reason: "max_turns_reached",
      });
    }
    return;
  }

  // Run the qualification LLM turn
  let decision;
  try {
    decision = await runQualificationTurn({
      pitch: cfg.pitch,
      companyName: prospect.companyName,
      contactName: prospect.contactName,
      prospectEmail: prospect.prospectEmail,
      a2aDetected: prospect.a2aDetected,
      turns: prospect.turns,
      latestProspectMessage: inboundContent,
      geminiApiKey: cfg.geminiApiKey,
      model: cfg.qualificationModel,
    });
  } catch (err) {
    api.logger.error(`lead-qualifier: LLM turn failed for ${prospect.id}: ${String(err)}`);
    upsertProspect(store, prospect);
    await saveStore(stateDir, store);
    return;
  }

  switch (decision.action) {
    case "reply": {
      prospect.turns.push({ role: "agent", content: decision.message, ts: Date.now() });
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);
      await sendReply(api, prospect.channel, prospect.target, decision.message);
      break;
    }

    case "book_meeting": {
      const email = decision.prospectEmail || prospect.prospectEmail;
      if (!email) {
        // No email yet — ask the prospect for it
        const ask = "I'd love to set up a call. Could you share your email so I can send a calendar invite?";
        prospect.turns.push({ role: "agent", content: ask, ts: Date.now() });
        prospect.status = "qualifying";
        upsertProspect(store, prospect);
        await saveStore(stateDir, store);
        await sendReply(api, prospect.channel, prospect.target, ask);
        break;
      }

      prospect.prospectEmail = email;
      prospect.status = "warm_lead";

      if (cfg.calApiKey && cfg.calEventTypeId) {
        const booking = await bookMeeting({
          calApiKey: cfg.calApiKey,
          eventTypeId: cfg.calEventTypeId,
          prospectEmail: email,
          prospectName: prospect.contactName,
          preferredStartTime: decision.preferredSlot,
        });

        if (booking.ok) {
          prospect.meetingUrl = booking.meetingUrl;
          prospect.meetingStartTime = booking.startTime;
          prospect.status = "booked";

          const confirmMsg = `Excellent! I've booked time with our team: ${booking.meetingUrl}`;
          prospect.turns.push({ role: "agent", content: confirmMsg, ts: Date.now() });
          upsertProspect(store, prospect);
          await saveStore(stateDir, store);

          await sendReply(api, prospect.channel, prospect.target, confirmMsg);

          // CRM sync
          if (cfg.hubspotToken) {
            await syncToHubSpot(cfg.hubspotToken, {
              email,
              name: prospect.contactName,
              company: prospect.companyName,
              channel: prospect.channel,
              status: "booked",
              meetingUrl: booking.meetingUrl,
            }).catch((e) =>
              api.logger.warn(`lead-qualifier: HubSpot sync failed: ${String(e)}`),
            );
          }

          // Notify human
          if (cfg.notifyChannel && cfg.notifyTarget) {
            await notifyHuman({
              runtime: api.runtime,
              notifyChannel: cfg.notifyChannel,
              notifyTarget: cfg.notifyTarget,
              prospect,
              reason: "meeting_booked",
            });
          }
        } else {
          // Booking failed — escalate
          prospect.status = "escalated";
          upsertProspect(store, prospect);
          await saveStore(stateDir, store);
          api.logger.error(`lead-qualifier: booking failed for ${prospect.id}: ${booking.error}`);

          if (cfg.notifyChannel && cfg.notifyTarget) {
            await notifyHuman({
              runtime: api.runtime,
              notifyChannel: cfg.notifyChannel,
              notifyTarget: cfg.notifyTarget,
              prospect,
              reason: "manual_escalation",
              summary: `Booking failed: ${booking.error}. Please follow up manually.`,
            });
          }
        }
      } else {
        // No Cal.com configured — escalate to human to book manually
        prospect.status = "escalated";
        upsertProspect(store, prospect);
        await saveStore(stateDir, store);

        if (cfg.notifyChannel && cfg.notifyTarget) {
          await notifyHuman({
            runtime: api.runtime,
            notifyChannel: cfg.notifyChannel,
            notifyTarget: cfg.notifyTarget,
            prospect,
            reason: "warm_lead",
            summary: "Prospect agreed to meet — please book manually (Cal.com not configured).",
          });
        }
      }
      break;
    }

    case "escalate": {
      prospect.status = "escalated";
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      if (cfg.notifyChannel && cfg.notifyTarget) {
        await notifyHuman({
          runtime: api.runtime,
          notifyChannel: cfg.notifyChannel,
          notifyTarget: cfg.notifyTarget,
          prospect,
          reason: "manual_escalation",
          summary: `${decision.reason}\n${decision.summary}`,
        });
      }
      break;
    }

    case "close_disqualified": {
      prospect.status = "cold_lead";
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);
      api.logger.info(
        `lead-qualifier: prospect ${prospect.id} closed as disqualified. Reason: ${decision.reason}`,
      );
      break;
    }
  }
}

export function createLeadQualifierService(
  cfg: ResolvedLeadQualifierConfig,
  api: OpenClawPluginApi,
): OpenClawPluginService {
  return {
    id: "lead-qualifier",

    async start(ctx) {
      ctx.logger.info("lead-qualifier: service started");

      // Wire the inbound hook — every message on every channel goes through here.
      // We check if the sender matches an active prospect before doing anything.
      api.on("message_received", async (event, hookCtx) => {
        const channelId = hookCtx.channelId;
        const from = event.from;

        if (!from || !channelId) return;

        let store;
        try {
          store = await loadStore(ctx.stateDir);
        } catch (err) {
          ctx.logger.error(`lead-qualifier: failed to load store: ${String(err)}`);
          return;
        }

        const prospect = findProspectByTarget(store, channelId, from);
        if (!prospect) return; // Not our conversation

        await handleProspectReply(
          api,
          cfg,
          store,
          ctx.stateDir,
          prospect,
          event.content,
          channelId,
          event.metadata,
        );
      });
    },

    async stop(ctx) {
      ctx.logger.info("lead-qualifier: service stopped");
    },
  };
}
