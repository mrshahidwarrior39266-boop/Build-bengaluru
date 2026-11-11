/**
 * Google Sign-In (OAuth 2.0 authorization-code flow), no dependencies.
 *
 * Only used when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured; the
 * app then requires a session and each account gets its own shop ledger. The
 * endpoints are overridable so the whole flow can be tested against a local
 * stub without a Google project.
 */

export class GoogleAuth {
  constructor({
    clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET,
    authUrl = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    userInfoUrl = process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.clientId = typeof clientId === 'string' ? clientId.trim() : '';
    this.clientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.userInfoUrl = userInfoUrl;
    this.fetchImpl = fetchImpl;
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizationUrl({ redirectUri, state }) {
    if (!this.enabled) throw new Error('Google sign-in is not configured');
    const url = new URL(this.authUrl);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('access_type', 'online');
    return url.toString();
  }

  /** Exchange the one-time code and return the identity Google vouches for. */
  async exchange({ code, redirectUri }) {
    if (!this.enabled) throw new Error('Google sign-in is not configured');
    const tokenRes = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('Google token exchange failed');
    const token = await tokenRes.json();
    if (!token?.access_token) throw new Error('Google token exchange returned no access token');

    const userRes = await this.fetchImpl(this.userInfoUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error('Google profile lookup failed');
    const profile = await userRes.json();
    if (!profile?.sub) throw new Error('Google profile has no subject id');

    return {
      sub: String(profile.sub),
      email: typeof profile.email === 'string' ? profile.email : '',
      name: typeof profile.name === 'string' ? profile.name : '',
    };
  }
}
