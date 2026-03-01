// CLI commands for managing lead qualification campaigns.
// Registers as: `openclaw lead-qualifier <command>`

import type { OpenClawPluginCliRegistrar } from "openclaw/plugin-sdk";
import {
  loadStore,
  saveStore,
  upsertProspect,
  type CampaignStatus,
  type ProspectRecord,
} from "./campaign-store.js";

const STATUS_EMOJI: Record<CampaignStatus, string> = {
  outreach_sent: "📤",
  qualifying: "🔄",
  warm_lead: "🔥",
  cold_lead: "❌",
  booked: "✅",
  escalated: "⚡",
};

function formatProspectRow(p: ProspectRecord): string {
  const emoji = STATUS_EMOJI[p.status] ?? "?";
  const who = [p.contactName, p.companyName].filter(Boolean).join(" @ ") || p.target;
  const turns = p.turns.length;
  const updated = new Date(p.updatedAt).toLocaleString();
  return `${emoji}  ${p.id.padEnd(22)}  ${p.status.padEnd(16)}  ${who.padEnd(30)}  ${String(turns).padStart(5)} turns  ${updated}`;
}

export const leadQualifierCli: OpenClawPluginCliRegistrar = ({ program, logger }) => {
  const cmd = program
    .command("lead-qualifier")
    .description("Manage B2B lead qualification campaigns");

  // ── list ──────────────────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List all prospect campaigns")
    .option("--status <status>", "Filter by status (qualifying, booked, cold_lead, escalated, ...)")
    .option("--stateDir <dir>", "Override state directory")
    .action(async (opts: { status?: string; stateDir?: string }) => {
      const stateDir = opts.stateDir ?? process.env["OPENCLAW_STATE_DIR"] ?? process.cwd();
      const store = await loadStore(stateDir);
      let prospects = Object.values(store.prospects);

      if (opts.status) {
        prospects = prospects.filter((p) => p.status === opts.status);
      }

      if (prospects.length === 0) {
        console.log("No campaigns found.");
        return;
      }

      prospects.sort((a, b) => b.updatedAt - a.updatedAt);

      console.log(
        `${"ID".padEnd(22)}  ${"STATUS".padEnd(16)}  ${"WHO".padEnd(30)}  ${"TURNS".padStart(5)}  UPDATED`,
      );
      console.log("─".repeat(110));
      for (const p of prospects) {
        console.log(formatProspectRow(p));
      }
      console.log(`\n${prospects.length} campaign(s)`);
    });

  // ── status ────────────────────────────────────────────────────────────────
  cmd
    .command("status <campaignId>")
    .description("Show full conversation history for a campaign")
    .option("--stateDir <dir>", "Override state directory")
    .action(async (campaignId: string, opts: { stateDir?: string }) => {
      const stateDir = opts.stateDir ?? process.env["OPENCLAW_STATE_DIR"] ?? process.cwd();
      const store = await loadStore(stateDir);
      const prospect = store.prospects[campaignId];

      if (!prospect) {
        console.error(`Campaign ${campaignId} not found.`);
        process.exit(1);
      }

      const emoji = STATUS_EMOJI[prospect.status] ?? "?";
      console.log(`Campaign: ${prospect.id}`);
      console.log(`Status:   ${emoji} ${prospect.status}`);
      console.log(`Channel:  ${prospect.channel} → ${prospect.target}`);
      if (prospect.companyName) console.log(`Company:  ${prospect.companyName}`);
      if (prospect.contactName) console.log(`Contact:  ${prospect.contactName}`);
      if (prospect.prospectEmail) console.log(`Email:    ${prospect.prospectEmail}`);
      if (prospect.meetingUrl) console.log(`Meeting:  ${prospect.meetingUrl}`);
      if (prospect.a2aDetected) console.log(`A2A:      Agent-to-agent conversation detected`);
      console.log(`Created:  ${new Date(prospect.createdAt).toLocaleString()}`);
      console.log(`Updated:  ${new Date(prospect.updatedAt).toLocaleString()}`);
      console.log(`\n${"─".repeat(60)}\nConversation (${prospect.turns.length} turns):\n`);

      for (const turn of prospect.turns) {
        const label = turn.role === "agent" ? "[You]" : "[Prospect]";
        const time = new Date(turn.ts).toLocaleTimeString();
        console.log(`${time}  ${label}`);
        console.log(turn.content);
        console.log();
      }
    });

  // ── escalate ──────────────────────────────────────────────────────────────
  cmd
    .command("escalate <campaignId>")
    .description("Manually mark a campaign as escalated to human")
    .option("--reason <reason>", "Reason for escalation", "Manual CLI escalation")
    .option("--stateDir <dir>", "Override state directory")
    .action(async (campaignId: string, opts: { reason?: string; stateDir?: string }) => {
      const stateDir = opts.stateDir ?? process.env["OPENCLAW_STATE_DIR"] ?? process.cwd();
      const store = await loadStore(stateDir);
      const prospect = store.prospects[campaignId];

      if (!prospect) {
        console.error(`Campaign ${campaignId} not found.`);
        process.exit(1);
      }

      prospect.status = "escalated";
      prospect.updatedAt = Date.now();
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      console.log(`Campaign ${campaignId} escalated. Reason: ${opts.reason}`);
      logger.info(`lead-qualifier: campaign ${campaignId} manually escalated via CLI`);
    });

  // ── close ─────────────────────────────────────────────────────────────────
  cmd
    .command("close <campaignId>")
    .description("Mark a campaign as cold lead (disqualified)")
    .option("--stateDir <dir>", "Override state directory")
    .action(async (campaignId: string, opts: { stateDir?: string }) => {
      const stateDir = opts.stateDir ?? process.env["OPENCLAW_STATE_DIR"] ?? process.cwd();
      const store = await loadStore(stateDir);
      const prospect = store.prospects[campaignId];

      if (!prospect) {
        console.error(`Campaign ${campaignId} not found.`);
        process.exit(1);
      }

      prospect.status = "cold_lead";
      prospect.updatedAt = Date.now();
      upsertProspect(store, prospect);
      await saveStore(stateDir, store);

      console.log(`Campaign ${campaignId} closed as cold lead.`);
    });

  // ── stats ─────────────────────────────────────────────────────────────────
  cmd
    .command("stats")
    .description("Show pipeline statistics")
    .option("--stateDir <dir>", "Override state directory")
    .action(async (opts: { stateDir?: string }) => {
      const stateDir = opts.stateDir ?? process.env["OPENCLAW_STATE_DIR"] ?? process.cwd();
      const store = await loadStore(stateDir);
      const prospects = Object.values(store.prospects);

      const counts: Record<string, number> = {};
      for (const p of prospects) {
        counts[p.status] = (counts[p.status] ?? 0) + 1;
      }

      const a2aCount = prospects.filter((p) => p.a2aDetected).length;

      console.log("Lead Qualification Pipeline Stats");
      console.log("─".repeat(40));
      for (const [status, count] of Object.entries(counts).sort()) {
        const emoji = STATUS_EMOJI[status as CampaignStatus] ?? "?";
        console.log(`${emoji}  ${status.padEnd(20)}  ${count}`);
      }
      console.log("─".repeat(40));
      console.log(`Total: ${prospects.length} campaigns`);
      console.log(`A2A detected: ${a2aCount} (${Math.round((a2aCount / (prospects.length || 1)) * 100)}%)`);
    });
};
