/**
 * The SocialAccount fields safe to return to a browser. Never accessToken /
 * refreshToken / scopes: those are OAuth bearer credentials that post as the
 * connected LinkedIn/X account, and every workspace member (VIEWER included)
 * can call the social API routes.
 */
export const PUBLIC_SOCIAL_ACCOUNT_SELECT = {
  id: true,
  platform: true,
  accountType: true,
  displayName: true,
  username: true,
  avatarUrl: true,
  companyName: true,
  expiresAt: true,
} as const;
