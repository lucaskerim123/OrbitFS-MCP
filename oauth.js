import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SignJWT, decodeJwt } from "jose";

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "oauth_state.json");
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(SERVER_DIR, "logs");
const EVENT_LOG_FILE = path.join(LOG_DIR, "master-hive-events.jsonl");
const ERROR_LOG_FILE = path.join(LOG_DIR, "master-hive-errors.jsonl");

const clients = new Map();
const authSessions = new Map();
const authCodes = new Map();
const refreshTokens = new Map();

function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(EVENT_LOG_FILE, `${line}\n`, "utf-8");
  } catch {}
}

function logError(event, err, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err.message, ...fields });
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG_FILE, `${line}\n`, "utf-8");
  } catch {}
}

function classifyRedirect(uri = "") {
  if (uri.includes("chatgpt.com/connector/oauth")) return "chatgpt";
  if (uri.includes("claude.ai/api/mcp/auth_callback")) return "claude";
  return "other";
}

function redirectHost(uri = "") {
  try {
    return new URL(uri).host;
  } catch {
    return uri || null;
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    for (const [k, v] of data.clients || []) clients.set(k, v);
    for (const [k, v] of data.refreshTokens || []) refreshTokens.set(k, v);
    logEvent("oauth.state.loaded", { clients: clients.size, refreshTokens: refreshTokens.size });
  } catch (err) {
    logError("oauth.state.load_failed", err);
  }
}

function saveState() {
  try {
    const data = {
      clients: [...clients.entries()],
      refreshTokens: [...refreshTokens.entries()],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logError("oauth.state.save_failed", err);
  }
}

loadState();

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest();
}

// Read-only summary for the admin panel - client redirect URIs and which
// accounts hold a refresh token, but never the actual token/secret values.
export function getOAuthState() {
  return {
    clients: [...clients.entries()].map(([id, c]) => ({
      id,
      redirectUris: c.redirectUris,
      flow: classifyRedirect(c.redirectUris?.[0]),
    })),
    refreshTokens: [...refreshTokens.values()].map((v) => ({ email: v.email, flow: v.flow || "unknown" })),
  };
}

export function mountOAuth(app, cfg) {
  const { publicBaseUrl, cfAuthEndpoint, cfTokenEndpoint, cfClientId, cfClientSecret, secretKey } = cfg;

  async function mintAccessToken(email, flow = "unknown") {
    return new SignJWT({ email, flow })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(publicBaseUrl)
      .setAudience(`${publicBaseUrl}/mcp`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretKey);
  }

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.json({
      issuer: publicBaseUrl,
      authorization_endpoint: `${publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${publicBaseUrl}/oauth/token`,
      registration_endpoint: `${publicBaseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
    });
  });

  app.post("/oauth/register", express.json(), (req, res) => {
    const clientId = "hive-" + crypto.randomBytes(12).toString("hex");
    const redirectUris = req.body.redirect_uris || [];
    clients.set(clientId, { redirectUris });
    saveState();
    logEvent("oauth.register.ok", {
      clientId,
      flow: classifyRedirect(redirectUris[0]),
      redirectHost: redirectHost(redirectUris[0]),
      redirectCount: redirectUris.length,
    });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
    const client = clients.get(client_id);
    const flow = classifyRedirect(redirect_uri);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      logEvent("oauth.authorize.rejected", {
        clientId: client_id || null,
        flow,
        redirectUri: redirect_uri || null,
        reason: !client ? "unknown_client" : "redirect_uri_mismatch",
        registeredRedirectUris: client ? client.redirectUris : null,
        knownClients: clients.size,
      });
      return res.status(400).send("Unknown client or redirect_uri");
    }
    const ourState = crypto.randomBytes(16).toString("hex");
    const cfVerifier = b64url(crypto.randomBytes(32));
    const cfChallenge = b64url(sha256(cfVerifier));
    authSessions.set(ourState, {
      redirect_uri,
      flow,
      state,
      code_challenge,
      code_challenge_method: code_challenge_method || "S256",
      cfVerifier,
    });
    logEvent("oauth.authorize.ok", {
      clientId: client_id,
      flow,
      redirectHost: redirectHost(redirect_uri),
      pkce: !!code_challenge,
      codeChallengeMethod: code_challenge_method || "S256",
    });
    const cfUrl = new URL(cfAuthEndpoint);
    cfUrl.searchParams.set("response_type", "code");
    cfUrl.searchParams.set("client_id", cfClientId);
    cfUrl.searchParams.set("redirect_uri", `${publicBaseUrl}/oauth/cf-callback`);
    cfUrl.searchParams.set("scope", "openid email profile");
    cfUrl.searchParams.set("state", ourState);
    cfUrl.searchParams.set("code_challenge", cfChallenge);
    cfUrl.searchParams.set("code_challenge_method", "S256");
    res.redirect(cfUrl.toString());
  });

  app.get("/oauth/cf-callback", async (req, res) => {
    const { code, state } = req.query;
    logEvent("oauth.cf_callback.start", { stateKnown: authSessions.has(state), hasCode: !!code });
    const session = authSessions.get(state);
    if (!session) {
      logEvent("oauth.cf_callback.rejected", { reason: "unknown_or_expired_session" });
      return res.status(400).send("Unknown or expired session");
    }
    authSessions.delete(state);

    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("code", code);
    params.set("redirect_uri", `${publicBaseUrl}/oauth/cf-callback`);
    params.set("client_id", cfClientId);
    params.set("client_secret", cfClientSecret);
    params.set("code_verifier", session.cfVerifier);

    const tokenResp = await fetch(cfTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!tokenResp.ok) {
      const upstreamText = await tokenResp.text();
      logError("oauth.cf_token_exchange.failed", new Error(`HTTP ${tokenResp.status}`), {
        upstreamStatus: tokenResp.status,
        upstreamMessage: upstreamText.slice(0, 200),
      });
      return res.status(502).send("Upstream auth failed");
    }
    const tokens = await tokenResp.json();
    const claims = decodeJwt(tokens.id_token || tokens.access_token);
    const email = claims.email || claims.sub;
    logEvent("oauth.cf_token_exchange.ok", { email, flow: classifyRedirect(session.redirect_uri) });

    const ourAccessToken = await mintAccessToken(email, session.flow);
    const ourRefreshToken = crypto.randomBytes(24).toString("hex");
    refreshTokens.set(ourRefreshToken, { email, flow: session.flow });
    saveState();

    const ourCode = crypto.randomBytes(24).toString("hex");
    authCodes.set(ourCode, {
      accessToken: ourAccessToken,
      refreshToken: ourRefreshToken,
      code_challenge: session.code_challenge,
      expires: Date.now() + 60000,
    });

    const backUrl = new URL(session.redirect_uri);
    backUrl.searchParams.set("code", ourCode);
    if (session.state) backUrl.searchParams.set("state", session.state);
    logEvent("oauth.cf_callback.redirect", {
      flow: classifyRedirect(session.redirect_uri),
      redirectHost: redirectHost(session.redirect_uri),
    });
    res.redirect(backUrl.toString());
  });

  app.post("/oauth/token", express.urlencoded({ extended: true }), async (req, res) => {
    const { grant_type, code, code_verifier, refresh_token } = req.body;
    logEvent("oauth.token.start", { grantType: grant_type });

    if (grant_type === "refresh_token") {
      const entry = refreshTokens.get(refresh_token);
      if (!entry) {
        logEvent("oauth.token.refresh_rejected", { reason: "unknown_refresh_token" });
        return res.status(400).json({ error: "invalid_grant" });
      }
      const accessToken = await mintAccessToken(entry.email, entry.flow || "unknown");
      logEvent("oauth.token.refresh_ok", { email: entry.email, flow: entry.flow || "unknown" });
      return res.json({
        access_token: accessToken,
        refresh_token,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }
    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) {
      logEvent("oauth.token.code_rejected", { reason: "invalid_or_expired_code" });
      return res.status(400).json({ error: "invalid_grant" });
    }
    authCodes.delete(code);

    if (entry.code_challenge) {
      const expected = b64url(sha256(code_verifier || ""));
      if (expected !== entry.code_challenge) {
        logEvent("oauth.token.code_rejected", { reason: "pkce_mismatch" });
        return res.status(400).json({ error: "invalid_grant" });
      }
    }

    logEvent("oauth.token.code_ok", { refreshIssued: !!entry.refreshToken });
    res.json({
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
}
