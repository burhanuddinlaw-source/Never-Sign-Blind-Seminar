// Vercel Serverless Function — receives a lead from the funnel.
// Lives at /api/lead because the file is at /api/lead.js.
//
// Integrations:
//   1. HubSpot CRM  — creates or updates a Contact using standard fields only.
//      Uses POST /crm/v3/objects/contacts to create; on 409 (already exists)
//      it fetches the contact ID by email then PATCHes the existing record.
//   2. Email alert  — sends an HTML notification to NOTIFY_EMAIL via Resend.
//
// Both run in parallel via Promise.allSettled — failure in one never
// blocks the other, and the browser always gets 200 OK.

export default async function handler(req, res) {
        if (req.method !== "POST") {
                  return res.status(405).json({ ok: false, error: "Method not allowed" });
        }

  try {
            const lead = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

          if (!lead || !lead.email || !lead.name) {
                      return res.status(400).json({ ok: false, error: "Missing name or email" });
          }

          const [hubspotResult, emailResult] = await Promise.allSettled([
                      pushToHubSpot(lead),
                      sendEmailNotification(lead),
                    ]);

          if (hubspotResult.status === "rejected") {
                      console.error("[lead] HubSpot error:", hubspotResult.reason);
          } else {
                      console.log("[lead] HubSpot OK:", hubspotResult.value);
          }

          if (emailResult.status === "rejected") {
                      console.error("[lead] Email error:", emailResult.reason);
          } else {
                      console.log("[lead] Email OK:", emailResult.value);
          }

          return res.status(200).json({ ok: true });
  } catch (err) {
            console.error("[lead] Unexpected error:", err);
            return res.status(200).json({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// HubSpot — create contact, fall back to PATCH on 409 conflict
// Only sends standard HubSpot properties (no custom fields needed)
// ---------------------------------------------------------------------------
async function pushToHubSpot(lead) {
        const token = process.env.HUBSPOT_API_TOKEN;
        if (!token) throw new Error("HUBSPOT_API_TOKEN is not set");

  // Only standard HubSpot contact properties — no custom fields required
  const properties = {
            email: lead.email,
            firstname: (lead.name || "").split(" ")[0] || "",
            lastname: (lead.name || "").split(" ").slice(1).join(" ") || "",
            phone: lead.phone || "",
  };

  const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
  };

  // Step 1: try to CREATE the contact
  const createResp = await fetch(
            "https://api.hubapi.com/crm/v3/objects/contacts",
        {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ properties }),
        }
          );

  if (createResp.ok) {
            const json = await createResp.json();
            return json.id ?? "created";
  }

  // Step 2: if 409 (contact already exists), look up by email then PATCH
  if (createResp.status === 409) {
            const searchResp = await fetch(
                        `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(lead.email)}?idProperty=email`,
                  { headers: { Authorization: `Bearer ${token}` } }
                      );
            if (!searchResp.ok) {
                        const t = await searchResp.text();
                        throw new Error(`HubSpot lookup ${searchResp.status}: ${t}`);
            }
            const existing = await searchResp.json();
            const contactId = existing.id;

          const patchResp = await fetch(
                      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                {
                              method: "PATCH",
                              headers,
                              body: JSON.stringify({ properties }),
                }
                    );
            if (!patchResp.ok) {
                        const t = await patchResp.text();
                        throw new Error(`HubSpot PATCH ${patchResp.status}: ${t}`);
            }
            return contactId;
  }

  // Any other error
  const text = await createResp.text();
        throw new Error(`HubSpot ${createResp.status}: ${text}`);
}

// ---------------------------------------------------------------------------
// Email notification via Resend
// ---------------------------------------------------------------------------
async function sendEmailNotification(lead) {
        const resendKey = process.env.RESEND_API_KEY;
        const notifyEmail = process.env.NOTIFY_EMAIL || "ally@burhanuddinlaw.com";

  if (!resendKey) {
            console.log("[lead] RESEND_API_KEY not set — lead data:", JSON.stringify(lead));
            return "logged-only";
  }

  const answersHtml = lead.answers
          ? Object.entries(lead.answers)
                .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:bold">${k}</td><td style="padding:4px 8px">${v}</td></tr>`)
                .join("")
            : "<tr><td colspan='2'>No quiz answers captured</td></tr>";

  const html = `
  <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
    <h2 style="color:#1a1a2e">New Strategy Session Lead</h2>
      <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:4px 8px;font-weight:bold">Name</td><td style="padding:4px 8px">${lead.name}</td></tr>
              <tr><td style="padding:4px 8px;font-weight:bold">Email</td><td style="padding:4px 8px">${lead.email}</td></tr>
                  <tr><td style="padding:4px 8px;font-weight:bold">Phone</td><td style="padding:4px 8px">${lead.phone || "—"}</td></tr>
                      <tr><td style="padding:4px 8px;font-weight:bold">Path</td><td style="padding:4px 8px">${lead.path || "—"}</td></tr>
                          <tr><td style="padding:4px 8px;font-weight:bold">Tier</td><td style="padding:4px 8px">${lead.tier || "—"}</td></tr>
                              <tr><td style="padding:4px 8px;font-weight:bold">Score</td><td style="padding:4px 8px">${lead.score ?? "—"}</td></tr>
                                </table>
                                  <h3 style="margin-top:24px">Quiz Answers</h3>
                                    <table style="border-collapse:collapse;width:100%">${answersHtml}</table>
                                      <p style="color:#888;font-size:12px;margin-top:24px">Sent by ineedastrategysession.com</p>
                                      </div>`;

  const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${resendKey}`,
            },
            body: JSON.stringify({
                        from: "Strategy Session Funnel <noreply@updates.burhanuddinlaw.com>",
                        to: [notifyEmail],
                        subject: `New Lead: ${lead.name} (${lead.email})`,
                        html,
            }),
  });

  if (!response.ok) {
            const text = await response.text();
            throw new Error(`Resend ${response.status}: ${text}`);
  }

  const json = await response.json();
        return json.id ?? "sent";
}
