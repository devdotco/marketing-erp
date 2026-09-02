import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const FROM = process.env.EMAIL_FROM ?? "noreply@erp.io";
const APP_NAME = "Marketing ERP";

export async function sendMagicLink(to: string, url: string) {
  await sgMail.send({
    to,
    from: FROM,
    subject: `Sign in to ${APP_NAME}`,
    html: emailTemplate({
      heading: "Your sign-in link",
      body: "Click the button below to sign in. This link expires in 24 hours and can only be used once.",
      ctaText: "Sign in",
      ctaUrl: url,
      footer: "If you didn't request this, you can safely ignore this email.",
    }),
    text: `Sign in to ${APP_NAME}: ${url}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendPasswordReset(to: string, url: string) {
  await sgMail.send({
    to,
    from: FROM,
    subject: `Reset your ${APP_NAME} password`,
    html: emailTemplate({
      heading: "Reset your password",
      body: "Click the button below to choose a new password. This link expires in 1 hour.",
      ctaText: "Reset password",
      ctaUrl: url,
      footer: "If you didn't request a password reset, you can safely ignore this email.",
    }),
    text: `Reset your ${APP_NAME} password: ${url}\n\nThis link expires in 1 hour.`,
  });
}

function emailTemplate({
  heading,
  body,
  ctaText,
  ctaUrl,
  footer,
}: {
  heading: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  footer: string;
}) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e4ec">
        <tr><td style="padding:32px 36px 0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:32px">
            <div style="width:26px;height:26px;background:#09090c;border-radius:5px;display:inline-flex;align-items:center;justify-content:center">
              <span style="color:#fff;font-size:12px;font-weight:700">M</span>
            </div>
            <span style="font-size:13px;font-weight:600;color:#09090c">marketing.erp.io</span>
          </div>
          <h1 style="font-size:20px;font-weight:700;color:#09090c;margin:0 0 12px;letter-spacing:-0.02em">${heading}</h1>
          <p style="font-size:14px;color:#5c6070;line-height:1.65;margin:0 0 28px">${body}</p>
          <a href="${ctaUrl}"
             style="display:inline-block;padding:11px 24px;background:#09090c;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:-0.01em">
            ${ctaText}
          </a>
        </td></tr>
        <tr><td style="padding:28px 36px 32px">
          <p style="font-size:12px;color:#9ea1b4;margin:0 0 8px">${footer}</p>
          <p style="font-size:12px;color:#9ea1b4;margin:0">Or copy this link: <span style="color:#5c6070;word-break:break-all">${ctaUrl}</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
