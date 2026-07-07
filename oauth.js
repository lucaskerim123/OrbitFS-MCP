import crypto from "crypto";
import express from "express";
import { SignJWT, decodeJwt } from "jose";

const clients = new Map();
const authSessions = new Map();
const authCodes = new Map();
const refreshTokens = new Map();

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest();
}

export function mountOAuth(app, cfg) {
  const { publicBaseUrl, cfAuthEndpoint, cfTokenEndpoint, cfClientId, cfClientSecret, secretKey } = cfg;

  async function mintAccessToken(email) {
    return new SignJWT({ email })
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
    console.log("REGISTER:", JSON.stringify(req.body), "-> issued", clientId);
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
    console.log("AUTHORIZE query:", JSON.stringify(req.query));
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      console.log("AUTHORIZE REJECTED. known clients:", JSON.stringify([...clients.keys()]));
      return res.status(400).send("Unknown client or redirect_uri");
    }
    const ourState = crypto.randomBytes(16).toString("hex");
    const cfVerifier = b64url(crypto.randomBytes(32));
    const cfChallenge = b64url(sha256(cfVerifier));
    authSessions.set(ourState, {
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method: code_challenge_method || "S256",
      cfVerifier,
    });
    console.log("AUTHORIZE OK, redirecting to CF, ourState:", ourState);
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
    console.log("CF-CALLBACK hit, state:", state, "hasCode:", !!code);
    const session = authSessions.get(state);
    if (!session) {
      console.log("CF-CALLBACK: unknown/expired session for state", state);
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
      console.error("CF token exchange failed:", await tokenResp.text());
      return res.status(502).send("Upstream auth failed");
    }
    const tokens = await tokenResp.json();
    const claims = decodeJwt(tokens.id_token || tokens.access_token);
    const email = claims.email || claims.sub;
    console.log("CF token exchange OK. authenticated as:", email);

    const ourAccessToken = await mintAccessToken(email);
    const ourRefreshToken = crypto.randomBytes(24).toString("hex");
    refreshTokens.set(ourRefreshToken, { email });

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
    console.log("CF-CALLBACK: redirecting back to caller:", backUrl.toString());
    res.redirect(backUrl.toString());
  });

  app.post("/oauth/token", express.urlencoded({ extended: true }), async (req, res) => {
    const { grant_type, code, code_verifier, refresh_token } = req.body;
    console.log("TOKEN request grant_type:", grant_type);

    if (grant_type === "refresh_token") {
      const entry = refreshTokens.get(refresh_token);
      if (!entry) {
        console.log("TOKEN refresh: unknown refresh_token");
        return res.status(400).json({ error: "invalid_grant" });
      }
      const accessToken = await mintAccessToken(entry.email);
      console.log("TOKEN refresh OK for", entry.email);
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
      console.log("TOKEN: invalid or expired code");
      return res.status(400).json({ error: "invalid_grant" });
    }
    authCodes.delete(code);

    if (entry.code_challenge) {
      const expected = b64url(sha256(code_verifier || ""));
      if (expected !== entry.code_challenge) {
        console.log("TOKEN: PKCE mismatch");
        return res.status(400).json({ error: "invalid_grant" });
      }
    }

    console.log("TOKEN: issuing access token to caller");
    res.json({
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
}
