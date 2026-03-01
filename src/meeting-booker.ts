// Cal.com v2 API integration for meeting booking.
// Direct HTTP fetch — no SDK dependency.

export type BookingRequest = {
  calApiKey: string;
  eventTypeId: string;
  prospectEmail: string;
  prospectName?: string;
  /** ISO 8601 datetime for the preferred slot, e.g. "2026-03-10T14:00:00Z" */
  preferredStartTime?: string;
  /** Timezone for the booking (default: "UTC") */
  timezone?: string;
  /** Short note to include in the booking */
  notes?: string;
};

export type BookingResult =
  | { ok: true; meetingUrl: string; startTime: string; bookingId: string }
  | { ok: false; error: string };

const CAL_API_BASE = "https://api.cal.com/v2";

/**
 * Find the next available slot for the given event type.
 * Returns the earliest available slot after `after` (defaults to now).
 */
async function findNextSlot(
  apiKey: string,
  eventTypeId: string,
  after?: Date,
): Promise<{ startTime: string } | null> {
  const start = (after ?? new Date()).toISOString();
  // Look 14 days ahead
  const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(`${CAL_API_BASE}/slots/available`);
  url.searchParams.set("eventTypeId", eventTypeId);
  url.searchParams.set("startTime", start);
  url.searchParams.set("endTime", end);

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "cal-api-version": "2024-09-04",
    },
  });

  if (!resp.ok) {
    return null;
  }

  const body = (await resp.json()) as { data?: { slots?: Array<{ time: string }> } };
  const slots = body.data?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    return null;
  }

  const first = slots[0];
  return first ? { startTime: first.time } : null;
}

/**
 * Create a booking on Cal.com.
 */
export async function bookMeeting(req: BookingRequest): Promise<BookingResult> {
  try {
    // If no preferred time, find the next available slot
    let startTime = req.preferredStartTime;
    if (!startTime) {
      const slot = await findNextSlot(req.calApiKey, req.eventTypeId);
      if (!slot) {
        return { ok: false, error: "No available slots found in the next 14 days" };
      }
      startTime = slot.startTime;
    }

    const payload = {
      eventTypeId: Number(req.eventTypeId),
      start: startTime,
      timeZone: req.timezone ?? "UTC",
      attendee: {
        name: req.prospectName ?? req.prospectEmail,
        email: req.prospectEmail,
        timeZone: req.timezone ?? "UTC",
      },
      ...(req.notes ? { metadata: { notes: req.notes } } : {}),
    };

    const resp = await fetch(`${CAL_API_BASE}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.calApiKey}`,
        "Content-Type": "application/json",
        "cal-api-version": "2024-08-13",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return { ok: false, error: `Cal.com booking failed (${resp.status}): ${errBody}` };
    }

    const data = (await resp.json()) as {
      data?: { uid?: string; meetingUrl?: string; start?: string };
    };
    const booking = data.data;
    if (!booking?.uid) {
      return { ok: false, error: "Cal.com returned unexpected response" };
    }

    return {
      ok: true,
      bookingId: booking.uid,
      meetingUrl: booking.meetingUrl ?? `https://cal.com/booking/${booking.uid}`,
      startTime: booking.start ?? startTime,
    };
  } catch (err) {
    return { ok: false, error: `Meeting booking error: ${String(err)}` };
  }
}
