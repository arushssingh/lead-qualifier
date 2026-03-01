// Human escalation notifications.
// Routes to the configured channel via the OpenClaw plugin runtime.

import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { ProspectRecord } from "./campaign-store.js";

export type NotifyParams = {
  runtime: PluginRuntime;
  notifyChannel: string;
  notifyTarget: string;
  prospect: ProspectRecord;
  reason: "warm_lead" | "meeting_booked" | "manual_escalation" | "max_turns_reached";
  summary?: string;
};

function buildMessage(params: NotifyParams): string {
  const { prospect, reason } = params;
  const who = [prospect.contactName, prospect.companyName].filter(Boolean).join(" @ ") || prospect.target;

  const lines: string[] = [];

  if (reason === "meeting_booked") {
    lines.push(`Meeting booked with ${who}`);
    if (prospect.meetingUrl) lines.push(`Meeting link: ${prospect.meetingUrl}`);
    if (prospect.meetingStartTime) lines.push(`When: ${prospect.meetingStartTime}`);
  } else if (reason === "warm_lead") {
    lines.push(`Warm lead: ${who} is interested — needs your attention`);
  } else if (reason === "max_turns_reached") {
    lines.push(`Qualification hit max turns for ${who} — please follow up manually`);
  } else {
    lines.push(`Lead escalated: ${who}`);
  }

  if (prospect.prospectEmail) lines.push(`Email: ${prospect.prospectEmail}`);
  lines.push(`Channel: ${prospect.channel} | Target: ${prospect.target}`);
  if (prospect.a2aDetected) lines.push(`(Prospect appears to be an AI agent)`);
  if (params.summary) lines.push(`\nSummary: ${params.summary}`);

  return lines.join("\n");
}

/**
 * Send a human notification via the configured OpenClaw channel.
 * Uses the PluginRuntime channel-specific send methods.
 */
export async function notifyHuman(params: NotifyParams): Promise<void> {
  const { runtime, notifyChannel, notifyTarget } = params;
  const message = buildMessage(params);

  // Access the channel send functions through the runtime.
  // The PluginRuntime exposes channel-specific methods at runtime.channel.*
  // We use dynamic property access since we support multiple channels.
  const ch = (runtime as unknown as Record<string, unknown>)["channel"] as
    | Record<string, unknown>
    | undefined;

  if (!ch) {
    console.warn(`lead-qualifier: runtime.channel not available, cannot notify human`);
    return;
  }

  try {
    switch (notifyChannel) {
      case "slack": {
        const fn = ch["slack"] as Record<string, unknown> | undefined;
        const send = fn?.["sendMessageSlack"] as
          | ((target: string, text: string, opts: Record<string, unknown>) => Promise<unknown>)
          | undefined;
        if (send) {
          await send(notifyTarget, message, {});
        }
        break;
      }
      case "telegram": {
        const fn = ch["telegram"] as Record<string, unknown> | undefined;
        const send = fn?.["sendMessageTelegram"] as
          | ((target: string, text: string) => Promise<unknown>)
          | undefined;
        if (send) {
          await send(notifyTarget, message);
        }
        break;
      }
      case "discord": {
        const fn = ch["discord"] as Record<string, unknown> | undefined;
        const send = fn?.["sendMessageDiscord"] as
          | ((target: string, text: string, opts: Record<string, unknown>) => Promise<unknown>)
          | undefined;
        if (send) {
          await send(notifyTarget, message, {});
        }
        break;
      }
      case "msteams": {
        const fn = ch["msteams"] as Record<string, unknown> | undefined;
        const send = fn?.["sendMessageTeams"] as
          | ((target: string, text: string, opts: Record<string, unknown>) => Promise<unknown>)
          | undefined;
        if (send) {
          await send(notifyTarget, message, {});
        }
        break;
      }
      default:
        console.warn(`lead-qualifier: unsupported notify channel "${notifyChannel}"`);
    }
  } catch (err) {
    console.error(`lead-qualifier: failed to send human notification: ${String(err)}`);
  }
}
