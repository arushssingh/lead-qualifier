// HubSpot CRM integration — creates or updates a contact + deal on warm leads.
// Uses direct HTTP fetch against the HubSpot Private App API.

const HUBSPOT_API_BASE = "https://api.hubapi.com";

export type CrmRecord = {
  email?: string;
  name?: string;
  company?: string;
  channel: string;
  status: "qualifying" | "warm_lead" | "booked" | "cold_lead" | "escalated";
  meetingUrl?: string;
  conversationSummary?: string;
  a2aDetected?: boolean;
};

export type CrmSyncResult =
  | { ok: true; contactId: string; dealId?: string }
  | { ok: false; error: string };

/** Create or update a HubSpot contact by email */
async function upsertContact(
  token: string,
  record: CrmRecord,
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  if (!record.email) {
    return { ok: false, error: "No prospect email — cannot upsert HubSpot contact" };
  }

  const nameParts = (record.name ?? "").trim().split(/\s+/);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ");

  const properties: Record<string, string> = {
    email: record.email,
    ...(firstName ? { firstname: firstName } : {}),
    ...(lastName ? { lastname: lastName } : {}),
    ...(record.company ? { company: record.company } : {}),
    lead_qualifier_channel: record.channel,
    lead_qualifier_status: record.status,
    ...(record.a2aDetected ? { lead_qualifier_a2a: "true" } : {}),
  };

  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: [
        {
          idProperty: "email",
          id: record.email,
          properties,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    return { ok: false, error: `HubSpot contact upsert failed (${resp.status}): ${errBody}` };
  }

  const body = (await resp.json()) as { results?: Array<{ id: string }> };
  const contactId = body.results?.[0]?.id;
  if (!contactId) {
    return { ok: false, error: "HubSpot returned unexpected response" };
  }

  return { ok: true, contactId };
}

/** Create a deal in HubSpot and associate it with a contact */
async function createDeal(
  token: string,
  contactId: string,
  record: CrmRecord,
): Promise<{ ok: true; dealId: string } | { ok: false; error: string }> {
  const dealName = record.company
    ? `Lead Qualifier — ${record.company}`
    : `Lead Qualifier — ${record.email ?? "unknown"}`;

  const properties: Record<string, string> = {
    dealname: dealName,
    dealstage: record.status === "booked" ? "appointmentscheduled" : "qualifiedtobuy",
    pipeline: "default",
    ...(record.meetingUrl ? { meeting_url: record.meetingUrl } : {}),
    ...(record.conversationSummary
      ? { description: record.conversationSummary.slice(0, 1000) }
      : {}),
    lead_qualifier_channel: record.channel,
  };

  const resp = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/deals`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    return { ok: false, error: `HubSpot deal create failed (${resp.status}): ${errBody}` };
  }

  const deal = (await resp.json()) as { id?: string };
  if (!deal.id) {
    return { ok: false, error: "HubSpot deal create returned unexpected response" };
  }

  // Associate the deal with the contact
  await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  return { ok: true, dealId: deal.id };
}

/**
 * Sync a qualified/booked lead to HubSpot.
 * Creates/updates a contact and optionally creates a deal on "booked" status.
 */
export async function syncToHubSpot(token: string, record: CrmRecord): Promise<CrmSyncResult> {
  try {
    const contactResult = await upsertContact(token, record);
    if (!contactResult.ok) return contactResult;

    if (record.status === "booked" || record.status === "warm_lead") {
      const dealResult = await createDeal(token, contactResult.contactId, record);
      if (!dealResult.ok) {
        // Non-fatal: contact was created, just log the deal failure
        return { ok: true, contactId: contactResult.contactId };
      }
      return { ok: true, contactId: contactResult.contactId, dealId: dealResult.dealId };
    }

    return { ok: true, contactId: contactResult.contactId };
  } catch (err) {
    return { ok: false, error: `HubSpot sync error: ${String(err)}` };
  }
}
