// LinkedIn OAuth2 helpers
// Scopes needed:
//   openid profile email  — identity
//   w_member_social       — post on behalf of member
//   r_organization_social rw_organization_admin — post to company pages (optional)

const LI_BASE = "https://www.linkedin.com";
const LI_API = "https://api.linkedin.com/v2";

export function getAuthorizationUrl(state: string, includeOrg = false): string {
  const scopes = ["openid", "profile", "email", "w_member_social"];
  if (includeOrg) scopes.push("r_organization_social", "rw_organization_admin");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI!,
    scope: scopes.join(" "),
    state,
  });

  return `${LI_BASE}/oauth/v2/authorization?${params}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI!,
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
  });

  const res = await fetch(`${LI_BASE}/oauth/v2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn token exchange failed: ${err}`);
  }

  return res.json() as Promise<TokenResponse>;
}

export interface LinkedInProfile {
  sub: string;          // person ID
  name: string;
  given_name: string;
  family_name: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

export async function fetchProfile(accessToken: string): Promise<LinkedInProfile> {
  const res = await fetch(`${LI_API}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch LinkedIn profile: ${res.status} ${body}`);
  }
  return res.json() as Promise<LinkedInProfile>;
}

export interface OrgPage {
  id: string;
  name: string;
  vanityName?: string;
  logoUrl?: string;
}

export async function fetchAdminOrgs(accessToken: string): Promise<OrgPage[]> {
  // Get organizations where the member is an admin
  const res = await fetch(
    `${LI_API}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    }
  );

  if (!res.ok) return [];

  const data = await res.json() as {
    elements?: Array<{ "organization~": { id: number; localizedName: string; vanityName?: string } }>;
  };

  return (data.elements ?? []).map((el) => ({
    id: String(el["organization~"].id),
    name: el["organization~"].localizedName,
    vanityName: el["organization~"].vanityName,
  }));
}
