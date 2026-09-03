import sgMail from "@sendgrid/mail";

const ALERT_RECIPIENTS = ["nate@dev.co", "info@seo.co", "eric@dev.co"];

interface SignupData {
  name: string;
  email: string;
  workspaceName: string;
  referralSource?: string | null;
}

export async function notifyNewSignup(data: SignupData): Promise<void> {
  const results = await Promise.allSettled([
    pushToCrm(data),
    sendAlertEmail(data),
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[notify-signup] task ${i} failed:`, r.reason);
    }
  });
}

async function pushToCrm(data: SignupData): Promise<void> {
  const url = process.env.CRM_WEBHOOK_URL;
  const secret = process.env.CRM_WEBHOOK_SECRET;
  if (!url || !secret) return;

  const [firstName, ...rest] = data.name.trim().split(" ");
  const lastName = rest.join(" ") || undefined;

  const tags = ["erp-marketing-signup"];
  if (data.referralSource) tags.push(`ref:${data.referralSource}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "digital.marketing",
      email: data.email,
      firstName,
      lastName,
      company: data.workspaceName,
      tags,
    }),
  });

  if (!res.ok) {
    console.error("[notify-signup] CRM webhook failed:", res.status, await res.text().catch(() => ""));
  }
}

async function sendAlertEmail(data: SignupData): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM ?? "noreply@erp.io";
  if (!apiKey) {
    console.warn("[notify-signup] SENDGRID_API_KEY not set — skipping alert email");
    return;
  }
  console.log(`[notify-signup] sending alert email to ${ALERT_RECIPIENTS.join(", ")} from ${from}`);

  sgMail.setApiKey(apiKey);

  const subject = `New erp.io signup — ${data.name} (${data.workspaceName})`;
  const html = `
    <div style="font-family:sans-serif;max-width:480px;padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px">New marketing.erp.io account</h2>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 0;color:#666;width:110px">Name</td><td style="padding:6px 0;font-weight:600">${esc(data.name)}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0"><a href="mailto:${esc(data.email)}">${esc(data.email)}</a></td></tr>
        <tr><td style="padding:6px 0;color:#666">Workspace</td><td style="padding:6px 0">${esc(data.workspaceName)}</td></tr>
        ${data.referralSource ? `<tr><td style="padding:6px 0;color:#666">Referral</td><td style="padding:6px 0">${esc(data.referralSource)}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#666">Signed up</td><td style="padding:6px 0">${new Date().toUTCString()}</td></tr>
      </table>
      <p style="margin:20px 0 0"><a href="https://crm.vb.co" style="color:#2563eb">View in CRM →</a></p>
    </div>
  `;

  await sgMail.sendMultiple({
    to: ALERT_RECIPIENTS,
    from,
    subject,
    html,
    text: `New erp.io signup\n\nName: ${data.name}\nEmail: ${data.email}\nWorkspace: ${data.workspaceName}${data.referralSource ? `\nReferral: ${data.referralSource}` : ""}\n`,
  });
  console.log("[notify-signup] alert email sent ok");
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
