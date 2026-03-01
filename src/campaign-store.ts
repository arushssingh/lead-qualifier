// Persistent campaign state using atomic JSON writes.
// One JSON file per stateDir, updated on every turn.

import fs from "node:fs/promises";
import path from "node:path";

export type CampaignStatus =
  | "outreach_sent"
  | "qualifying"
  | "warm_lead"
  | "cold_lead"
  | "booked"
  | "escalated";

export type ConversationTurn = {
  role: "agent" | "prospect";
  content: string;
  ts: number;
};

export type ProspectRecord = {
  id: string;
  channel: string;
  target: string;
  companyName?: string;
  contactName?: string;
  prospectEmail?: string;
  status: CampaignStatus;
  turns: ConversationTurn[];
  /** Whether we detected the other side is also an AI agent */
  a2aDetected: boolean;
  meetingUrl?: string;
  meetingStartTime?: string;
  hubspotContactId?: string;
  createdAt: number;
  updatedAt: number;
};

export type CampaignStore = {
  version: 1;
  prospects: Record<string, ProspectRecord>;
};

function storePath(stateDir: string): string {
  return path.join(stateDir, "lead-qualifier", "campaigns.json");
}

export async function loadStore(stateDir: string): Promise<CampaignStore> {
  const filePath = storePath(stateDir);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && "prospects" in parsed) {
      return parsed as CampaignStore;
    }
  } catch {
    // File missing or malformed — start fresh
  }
  return { version: 1, prospects: {} };
}

export async function saveStore(stateDir: string, store: CampaignStore): Promise<void> {
  const filePath = storePath(stateDir);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Atomic write via tmp file + rename
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

export function getProspect(store: CampaignStore, id: string): ProspectRecord | undefined {
  return store.prospects[id];
}

export function upsertProspect(store: CampaignStore, record: ProspectRecord): void {
  store.prospects[record.id] = record;
}

/** Find a prospect by the inbound from+channel combo */
export function findProspectByTarget(
  store: CampaignStore,
  channel: string,
  from: string,
): ProspectRecord | undefined {
  for (const prospect of Object.values(store.prospects)) {
    if (
      prospect.channel === channel &&
      prospect.target === from &&
      prospect.status !== "booked" &&
      prospect.status !== "cold_lead" &&
      prospect.status !== "escalated"
    ) {
      return prospect;
    }
  }
  return undefined;
}

export function newProspectId(): string {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
