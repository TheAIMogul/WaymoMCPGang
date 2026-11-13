/**
 * Authentication for the private Waymo rider API in a Cloudflare Worker.
 * 1:1 port of src/waymo_mcp/auth.py using Web standard fetch().
 */

export const OAUTH_CLIENT_ID = "936475272427.apps.googleusercontent.com";
export const WAYMO_CLIENT_ID = "431988300665-qr3bvhc24trr8i3bb7laavu4qrs5on1r";
export const ANDROID_APP_ID = "com.waymo.carapp";
export const ANDROID_APP_SIG = "8cb0740811e55b4b260c8c62fc09283dfb47c484";
export const ANDROID_AUTH_SCOPES = "oauth2:https://www.googleapis.com/auth/chauffeur/hail";
export const FULL_SCOPES =
  "https://www.googleapis.com/auth/cclog " +
  "https://www.googleapis.com/auth/chauffeur/hail " +
  "https://www.googleapis.com/auth/experimentsandconfigs " +
  "profile email " +
  "https://www.googleapis.com/auth/supportcontent " +
  "https://www.googleapis.com/auth/account_settings_mobile";

export const USER_AGENT =
  "com.waymo.client/2.3.26081700 iSL/3.4 iPhone/26.6.1 hw/iPhone17_4 (gzip)";
export const RPC_USER_AGENT = USER_AGENT.replace(" iSL/3.4", "");
export const DEFAULT_DEVICE_ID = "F33B57DB-8668-40AD-A34E-9B2E0EE84F78";

async function postFormJson(url, data, extraHeaders = {}) {
  const body = new URLSearchParams(data).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": USER_AGENT,
      ...extraHeaders,
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Authentication failed (${response.status}): ${detail}`);
  }
  return await response.json();
}

async function postFormLines(url, data, extraHeaders = {}) {
  const body = new URLSearchParams(data).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/plain",
      "User-Agent": USER_AGENT,
      ...extraHeaders,
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Authentication failed (${response.status}): ${detail}`);
  }
  const text = await response.text();
  const fields = {};
  for (const line of text.trim().split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx !== -1) {
      fields[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return fields;
}

async function authenticateAndroidMaster(credentials) {
  if (!credentials.account_name) {
    throw new Error("account_name is required when using an aas_et master token");
  }
  const fields = await postFormLines("https://android.clients.google.com/auth", {
    account_name: credentials.account_name,
    Token: credentials.refresh_token,
    app: ANDROID_APP_ID,
    client_sig: ANDROID_APP_SIG,
    service: ANDROID_AUTH_SCOPES,
    device_country: "us",
    operatorCountryType: "home",
    simCountryType: "home",
    lang: "en-US",
    sdk_version: "34",
    google_play_services_version: "231818037",
    device: "Pixel 6",
  });
  const token = fields.Auth;
  if (!token) {
    const err = fields.Error || JSON.stringify(fields);
    throw new Error(`Android authentication failed: ${err}`);
  }
  const expiry = Number.parseInt(fields.Expiry || "0", 10);
  const expiresAt = Number.isFinite(expiry) && expiry > 0
    ? expiry
    : Math.floor(Date.now() / 1000) + 3600;
  return { chauffeur_token: token, expires_at: expiresAt };
}

export async function authenticate(credentials) {
  if (credentials.refresh_token.startsWith("aas_et/")) {
    return await authenticateAndroidMaster(credentials);
  }
  const oauth = await postFormJson("https://oauth2.googleapis.com/token", {
    client_id: OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
  });
  const chauffeur = await postFormJson(
    "https://oauthaccountmanager.googleapis.com/v1/issuetoken",
    {
      app_id: "com.waymo.client",
      client_id: WAYMO_CLIENT_ID,
      device_id: credentials.device_id || DEFAULT_DEVICE_ID,
      hl: "en-US",
      lib_ver: "3.4",
      response_type: "token",
      scope: FULL_SCOPES,
    },
    {
      "Authorization": `Bearer ${oauth.access_token}`,
      "X-OAuth-Client-ID": WAYMO_CLIENT_ID,
    }
  );
  const expiresIn = Number.parseInt(String(chauffeur.expiresIn ?? "3600"), 10) || 3600;
  return {
    chauffeur_token: chauffeur.token,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
}
