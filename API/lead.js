// Vercel Serverless Function — receives a lead from the funnel and forwards it.
// Lives at /api/lead because the file is at /api/lead.js.
//
// SETUP: in Vercel → your project → Settings → Environment Variables, add:
//   LEAD_WEBHOOK_URL = <your Zapier "Catch Hook" URL or Make.com webhook URL>
// (Optional second destination, e.g. a backup or Slack: LEAD_WEBHOOK_URL_2)
//
// No secrets ever touch the browser. The funnel posts here same-origin, so there
// are no CORS issues, and this function relays the lead server-side.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const lead = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // Minimal validation — don't forward empty junk.
    if (!lead || !lead.email || !lead.name) {
      return res.status(400).json({ ok: false, error: "Missing name or email" });
    }

    const targets = [process.env.LEAD_WEBHOOK_URL, process.env.LEAD_WEBHOOK_URL_2].filter(Boolean);

    if (targets.length === 0) {
      // Not configured yet — log so you can see it in Vercel's function logs,
      // and still return success so the funnel UX is never broken.
      console.log("LEAD (no webhook configured yet):", JSON.stringify(lead));
      return res.status(200).json({ ok: true, forwarded: false });
    }

    await Promise.allSettled(
      targets.map((url) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lead),
        })
      )
    );

    return res.status(200).json({ ok: true, forwarded: true });
  } catch (err) {
    console.error("lead handler error:", err);
    // Still 200 so the visitor's experience never breaks; you'll see the error in logs.
    return res.status(200).json({ ok: true, forwarded: false });
  }
}
