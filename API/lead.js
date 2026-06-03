// Vercel Serverless Function — receives a lead from the funnel.
// Lives at /api/lead because the file is at /API/lead.js.
//
// Integrations:
//   1. HubSpot CRM  — upserts a Contact using the Private App token in
//      HUBSPOT_API_TOKEN environment variable.
//   2. Email alert  — sends an HTML notification to NOTIFY_EMAIL using
//      the Resend API (RESEND_API_KEY env var).  If RESEND_API_KEY is
//      absent the lead is still logged to Vercel runtime logs so nothing
//      is ever silently lost.
//
// Both integrations run in parallel via Promise.allSettled so a failure
// in one never blocks the other, and the browser always gets 200 OK so
// the funnel UX is never broken.

export default async function handler(req, res) {
    if (req.method !== "POST") {
          return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

  try {
        const lead = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      // Minimal validation — reject obviously empty submissions.
      if (!lead || !lead.email || !lead.name) {
              return res.status(400).json({ ok: false, error: "Missing name or email" });
      }

      // Run HubSpot upsert + email notification concurrently.
      const [hubspotResult, emailResult] = await Promise.allSettled([
              pushToHubSpot(lead),
              sendEmailNotification(lead),
            ]);

      // Log outcomes server-side (visible in Vercel Function Logs).
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

      // Always return 200 so the funnel redirects the user normally.
      return res.status(200).json({ ok: true });
  } catch (err) {
        console.error("[lead] Unexpected error:", err);
        // Still return 200 — never break the funnel UX on backend errors.
      return res.status(200).json({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// HubSpot — upsert Contact by email
// ---------------------------------------------------------------------------
async function pushToHubSpot(lead) {
    const token = process.env.HUBSPOT_API_TOKEN;
    if (!token) throw new Error("HUBSPOT_API_TOKEN is not set");

  const properties = {
        email: lead.email,
        firstname: (lead.name || "").split(" ")[0] || "",
        lastname: (lead.name || "").split(" ").slice(1).join(" ") || "",
        phone: lead.phone || "",
  };

  // Attach any extra quiz fields that the funnel sends through.
  if (lead.answers) properties.lead_answers = JSON.stringify(lead.answers);
    if (lead.path)    properties.lead_path    = lead.path;
    if (lead.tier)    properties.lead_tier    = String(lead.tier);
    if (lead.score !== undefined) properties.lead_score = String(lead.score);

  const body = {
        inputs: [
          {
                    idProperty: "email",
                    properties,
          },
              ],
  };

  const response = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/upsert",
    {
            method: "POST",
            headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
    }
      );

  if (!response.ok) {
        const text = await response.text();
        throw new Error(`HubSpot ${response.status}: ${text}`);
  }

  const json = await response.json();
    return json.results?.[0]?.id ?? "upserted";
}

// ---------------------------------------------------------------------------
// Email notification via Resend
// ---------------------------------------------------------------------------
async function sendEmailNotification(lead) {
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL || "ally@burhanuddinlaw.com";

  if (!resendKey) {
        // Graceful degradation: log the lead so it is never silently lost.
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
                from: "Strategy Session Funnel <noreply@ineedastrategysession.com>",
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
