"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT || 12000);
const USER_A = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "ana@example.com",
  user_metadata: { full_name: "Ana Souza", avatar_url: "" }
};
const USER_B = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "bruno@example.com",
  user_metadata: { full_name: "Bruno Lima", avatar_url: "" }
};
const USERS = new Map([[USER_A.id, USER_A], [USER_B.id, USER_B]]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8"
};

const state = {
  rows: new Map(),
  tokens: new Map(),
  refresh: new Map(),
  codes: new Map(),
  requests: [],
  tokenGrants: [],
  lastAuthorize: null,
  lastVerifier: null,
  aiCalls: 0,
  aiQuestions: [],
  aiBodies: [],
  aiMode: "ok",
  aiAnswer: "Uma dieta equilibrada combina variedade, regularidade e água ao longo do dia.",
  aiVisionAnswer: JSON.stringify({
    items: [
      { name: "Arroz branco", grams: 120, kcal: 154, protein: 3, carbs: 33.7, fat: 0.2 },
      { name: "Feijão", grams: 100, kcal: 76, protein: 4.8, carbs: 13.6, fat: 0.5 }
    ],
    confidence: "media",
    note: "Estimativa visual de teste."
  }),
  aiEndpoint: "",
  aiServer: null,
  lastAI: null,
  authorizeMode: "redirect"
};

function reset() {
  state.rows.clear();
  state.tokens.clear();
  state.refresh.clear();
  state.codes.clear();
  state.requests = [];
  state.tokenGrants = [];
  state.lastAuthorize = null;
  state.lastVerifier = null;
  state.aiCalls = 0;
  state.aiQuestions = [];
  state.aiBodies = [];
  state.aiMode = "ok";
  state.aiAnswer = "Uma dieta equilibrada combina variedade, regularidade e água ao longo do dia.";
  state.aiVisionAnswer = JSON.stringify({
    items: [
      { name: "Arroz branco", grams: 120, kcal: 154, protein: 3, carbs: 33.7, fat: 0.2 },
      { name: "Feijão", grams: 100, kcal: 76, protein: 4.8, carbs: 13.6, fat: 0.5 }
    ],
    confidence: "media",
    note: "Estimativa visual de teste."
  });
  state.aiEndpoint = "";
  state.aiServer = null;
  state.lastAI = null;
  state.authorizeMode = "redirect";
}

function json(res, body, status = 200, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
    ...extra
  });
  res.end(text);
}

function html(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function issue(user) {
  const accessToken = `at_${crypto.randomUUID()}`;
  const refreshToken = `rt_${crypto.randomUUID()}`;
  state.tokens.set(accessToken, user.id);
  state.refresh.set(refreshToken, user.id);
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    user
  };
}

function clientSession(user) {
  const payload = issue(user);
  return { ...payload, expires_at: Date.now() + 3600 * 1000 };
}

function authUserId(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return state.tokens.get(token) || null;
}

function userById(id) {
  return USERS.get(id) || null;
}

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (error, buffer) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/"
    });
    res.end(buffer);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, apikey, content-type, prefer");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/config.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`window.VIVA_CONFIG = { SUPABASE_URL: "/sb", SUPABASE_ANON_KEY: "test-anon", AI_FUNCTION: "assistente", AI_ENDPOINT: ${JSON.stringify(state.aiEndpoint)} };`);
    return;
  }

  if (pathname === "/api/ai" && req.method === "GET") {
    json(res, state.aiServer || { configured: false });
    return;
  }

  if (pathname === "/api/ai" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    state.lastAI = {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      question: body.question,
      hasImage: !!body.image,
      imagePrefix: body.image ? String(body.image).slice(0, 30) : ""
    };
    json(res, { answer: body.image ? state.aiVisionAnswer : (state.aiServer ? "Resposta do servidor de teste." : "Resposta BYOK de teste.") });
    return;
  }

  if (pathname === "/__test/reset" && req.method === "POST") {
    reset();
    json(res, { ok: true });
    return;
  }

  if (pathname === "/__test/config" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    if (body.authorizeMode) state.authorizeMode = body.authorizeMode;
    if (body.aiMode) state.aiMode = body.aiMode;
    if (typeof body.aiAnswer === "string") state.aiAnswer = body.aiAnswer;
    if (typeof body.aiEndpoint === "string") state.aiEndpoint = body.aiEndpoint;
    if ("aiServer" in body) state.aiServer = body.aiServer;
    json(res, { ok: true });
    return;
  }

  if (pathname === "/__test/seed" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    const target = body.user === "B" ? USER_B : USER_A;
    state.rows.set(target.id, {
      user_id: target.id,
      data: body.data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    json(res, { ok: true });
    return;
  }

  if (pathname === "/__test/session" && req.method === "GET") {
    const target = url.searchParams.get("user") === "B" ? USER_B : USER_A;
    json(res, clientSession(target));
    return;
  }

  if (pathname === "/__test/expire" && req.method === "POST") {
    state.tokens.clear();
    json(res, { ok: true });
    return;
  }

  if (pathname === "/__test/state" && req.method === "GET") {
    json(res, {
      rows: [...state.rows.values()],
      requests: state.requests,
      tokenGrants: state.tokenGrants,
      lastAuthorize: state.lastAuthorize,
      lastVerifier: state.lastVerifier,
      aiCalls: state.aiCalls,
      aiQuestions: state.aiQuestions,
      aiBodies: state.aiBodies,
      lastAI: state.lastAI,
      tokens: [...state.tokens.keys()],
      refreshTokens: [...state.refresh.keys()]
    });
    return;
  }

  if (pathname === "/__test/login" && req.method === "GET") {
    const target = url.searchParams.get("user") === "B" ? USER_B : USER_A;
    const session = clientSession(target);
    html(res, `<script>localStorage.setItem("viva.session.v2", ${JSON.stringify(JSON.stringify(session))});location.replace("/?sw=0");</script>`);
    return;
  }

  if (pathname === "/sb/auth/v1/signup" && req.method === "POST") {
    const body = (await readJson(req)) || {};
    if (body.email || body.password) {
      json(res, { error: "email_signup_not_supported" }, 400);
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      email: null,
      is_anonymous: true,
      user_metadata: {},
      app_metadata: { provider: "anonymous", providers: ["anonymous"] }
    };
    USERS.set(user.id, user);
    json(res, issue(user));
    return;
  }

  if (pathname === "/sb/auth/v1/authorize") {
    state.lastAuthorize = Object.fromEntries(url.searchParams.entries());
    const redirectTo = url.searchParams.get("redirect_to") || `http://127.0.0.1:${PORT}/`;
    const code = `code_${crypto.randomUUID()}`;
    state.codes.set(code, {
      challenge: url.searchParams.get("code_challenge"),
      method: url.searchParams.get("code_challenge_method"),
      provider: url.searchParams.get("provider")
    });
    if (state.authorizeMode === "page") {
      html(res, "<!doctype html><title>Google</title><h1>Conta Google (simulada)</h1>");
      return;
    }
    const target = new URL(redirectTo);
    target.searchParams.set("code", code);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (pathname === "/sb/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    const body = (await readJson(req)) || {};
    state.tokenGrants.push(grant);
    if (grant === "pkce") {
      const entry = state.codes.get(body.auth_code);
      state.lastVerifier = body.code_verifier || null;
      if (!entry) {
        json(res, { error: "invalid_grant", error_description: "code not found" }, 400);
        return;
      }
      const digest = crypto.createHash("sha256").update(body.code_verifier || "").digest("base64url");
      if (entry.method !== "s256" || digest !== entry.challenge) {
        json(res, { error: "invalid_grant", error_description: "code verifier mismatch" }, 400);
        return;
      }
      state.codes.delete(body.auth_code);
      json(res, issue(USER_A));
      return;
    }
    if (grant === "refresh_token") {
      const userId = state.refresh.get(body.refresh_token);
      if (!userId) {
        json(res, { error: "invalid_grant" }, 400);
        return;
      }
      json(res, issue(userById(userId)));
      return;
    }
    json(res, { error: "unsupported_grant_type" }, 400);
    return;
  }

  if (pathname === "/sb/auth/v1/user") {
    const userId = authUserId(req);
    if (!userId) {
      json(res, { message: "invalid claim: missing sub claim" }, 401);
      return;
    }
    json(res, userById(userId));
    return;
  }

  if (pathname === "/sb/auth/v1/logout") {
    state.tokens.delete((req.headers.authorization || "").replace("Bearer ", ""));
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/sb/rest/v1/viva_data") {
    const userId = authUserId(req);
    if (!userId) {
      json(res, { message: "JWT expired or missing" }, 401);
      return;
    }
    if (req.method === "GET") {
      const rows = [...state.rows.values()]
        .filter((row) => row.user_id === userId)
        .map((row) => ({ user_id: row.user_id, data: row.data, updated_at: row.updated_at }));
      json(res, rows);
      return;
    }
    if (req.method === "POST") {
      const body = (await readJson(req)) || {};
      if (body.user_id !== userId) {
        json(res, { code: "42501", message: "new row violates row-level security policy" }, 403);
        return;
      }
      const existing = state.rows.get(userId);
      state.rows.set(userId, {
        user_id: userId,
        data: body.data,
        created_at: existing ? existing.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      state.requests.push({ type: "save", userId, data: body.data });
      res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end("[]");
      return;
    }
    if (req.method === "DELETE") {
      state.rows.delete(userId);
      state.requests.push({ type: "delete", userId });
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    json(res, { message: "method not allowed" }, 405);
    return;
  }

  if (pathname === "/sb/functions/v1/assistente") {
    const userId = authUserId(req);
    if (!userId) {
      json(res, { error: "unauthorized" }, 401);
      return;
    }
    const body = (await readJson(req)) || {};
    state.aiCalls += 1;
    state.aiQuestions.push(body.question || body.message || "");
    state.aiBodies.push(body);
    if (state.aiMode === "fail") {
      json(res, { error: "upstream_error" }, 502);
      return;
    }
    if (state.aiMode === "slow") await new Promise((resolve) => setTimeout(resolve, 1200));
    if (state.aiMode === "reply") {
      json(res, { reply: state.aiAnswer });
      return;
    }
    json(res, { answer: state.aiAnswer, model: "test-model" });
    return;
  }

  if (pathname.startsWith("/sb/")) {
    json(res, { error: "not_found" }, 404);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, pathname);
    return;
  }

  json(res, { error: "not_found" }, 404);
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Viva test server on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server, state, reset, USER_A, USER_B, PORT };
