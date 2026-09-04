// LinkedIn UGC Posts API — publish text posts to personal profiles and company pages

const LI_API = "https://api.linkedin.com/v2";

export interface PublishResult {
  urn: string; // e.g. urn:li:share:7XXXXXXXXXXXXXXXXX
}

export async function publishLinkedInPost(opts: {
  accessToken: string;
  authorUrn: string; // urn:li:person:X or urn:li:organization:X
  content: string;
  imageAssetUrns?: string[]; // LinkedIn digitalmediaAsset URNs for carousel
  visibility?: "PUBLIC" | "CONNECTIONS";
}): Promise<PublishResult> {
  const { accessToken, authorUrn, content, imageAssetUrns, visibility = "PUBLIC" } = opts;

  const hasImages = imageAssetUrns && imageAssetUrns.length > 0;

  const shareContent = hasImages
    ? {
        shareCommentary: { text: content },
        shareMediaCategory: "IMAGE",
        media: imageAssetUrns.map((urn) => ({
          status: "READY",
          media: urn,
        })),
      }
    : {
        shareCommentary: { text: content },
        shareMediaCategory: "NONE",
      };

  const body = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": shareContent,
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": visibility,
    },
  };

  const res = await fetch(`${LI_API}/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn publish failed (${res.status}): ${err}`);
  }

  // LinkedIn returns the post URN in the X-RestLi-Id header
  const urn = res.headers.get("x-restli-id") ?? res.headers.get("X-RestLi-Id") ?? "";

  if (!urn) {
    // Fallback: try to get from body
    const data = await res.json() as { id?: string };
    return { urn: data.id ?? "unknown" };
  }

  return { urn };
}

export async function refreshLinkedInToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: Date;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error("Token refresh failed");

  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}
