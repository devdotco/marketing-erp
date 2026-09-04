const X_API = "https://api.twitter.com/2";

export interface XPublishResult {
  id: string;
}

export async function publishXPost(opts: {
  accessToken: string;
  content: string;
}): Promise<XPublishResult> {
  const { accessToken, content } = opts;

  const res = await fetch(`${X_API}/tweets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: content }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X publish failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { data: { id: string; text: string } };
  return { id: data.data.id };
}

export async function refreshXToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: Date;
}> {
  const credentials = Buffer.from(
    `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.X_CLIENT_ID!,
  });

  const res = await fetch(`${X_API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });

  if (!res.ok) throw new Error("X token refresh failed");

  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}
