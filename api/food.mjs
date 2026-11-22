export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fmkmrrqseijcgcawqzoj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable__fM5rGKVNvICUJCoAJL6Jg_xZHtp9ES";
const SOURCE = "Open Food Facts";
const CACHE_TTL = 10 * 60_000;
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;
const CACHE = new Map();
const RATE = new Map();

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function rateLimited(userId) {
  const now = Date.now();
  const entry = RATE.get(userId);
  if (!entry || now - entry.start > RATE_WINDOW) {
    RATE.set(userId, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function singular(name) {
  return name.replace(/\b([a-z]{3,})s\b/g, "$1");
}

function scoreProduct(product, query) {
  const name = normalize(product.product_name || product.generic_name || "");
  if (!name) return -1;
  const q = normalize(query);
  if (!q) return -1;
  if (name === q) return 100;
  if (name.includes(q)) return 80 + Math.min(10, q.length / 4) - Math.min(8, name.length / 60);
  const queryTokens = [...new Set(q.split(" ").filter((token) => token.length > 2))];
  const nameTokens = new Set(name.split(" "));
  if (!queryTokens.length) return -1;
  const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
  return (overlap / queryTokens.length) * 60 - Math.min(8, name.length / 60);
}

function nutrition(product) {
  const n = product?.nutriments || {};
  let kcal = number(n["energy-kcal_100g"]);
  if (kcal == null) {
    const kj = number(n["energy-kj_100g"] ?? n.energy_100g);
    if (kj != null) kcal = kj / 4.184;
  }
  const protein = number(n.proteins_100g);
  const carbs = number(n.carbohydrates_100g);
  const fat = number(n.fat_100g);
  if ([kcal, protein, carbs, fat].some((value) => value == null) || kcal <= 0) return null;
  return { kcal: round1(kcal), protein: round1(protein), carbs: round1(carbs), fat: round1(fat) };
}

async function fetchProducts(query) {
  const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", "50");
  const upstream = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Viva/2.8 (https://viva-rouge-omega.vercel.app)" },
    signal: AbortSignal.timeout(8000)
  });
  if (!upstream.ok) return [];
  const payload = await upstream.json().catch(() => null);
  return Array.isArray(payload?.products) ? payload.products : [];
}

async function searchOpenFoodFacts(name) {
  const queries = [...new Set([name, singular(name)])].filter(Boolean);
  let best = null;
  for (const query of queries) {
    let products = await fetchProducts(query);
    if (!products.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      products = await fetchProducts(query);
    }
    for (const product of products) {
      const values = nutrition(product);
      if (!values) continue;
      const score = scoreProduct(product, query);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        const productName = String(product.product_name || product.generic_name || "").trim().slice(0, 120);
        const code = String(product.code || "").trim();
        best = {
          score,
          food: {
            code,
            name: productName,
            brand: String(product.brands || "").split(",")[0].trim().slice(0, 80),
            ...values,
            source: SOURCE,
            url: code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}` : "https://world.openfoodfacts.org"
          }
        };
      }
    }
    if (best?.score >= 100) break;
  }
  return best?.food || null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET") return json(res, 200, { configured: true, source: SOURCE });
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" });

  let userId = "anon";
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth }
    });
    if (!userRes.ok) return json(res, 401, { error: "unauthorized" });
    const user = await userRes.json().catch(() => null);
    userId = user?.id || "anon";
  } catch {
    return json(res, 503, { error: "supabase_unavailable" });
  }
  if (rateLimited(userId)) return json(res, 429, { error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};
  const name = String(body.name || "").trim().slice(0, 120);
  if (name.length < 2) return json(res, 400, { error: "missing_name" });

  const key = normalize(name);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return json(res, 200, { found: true, food: cached.food });

  let food = null;
  try {
    food = await searchOpenFoodFacts(name);
  } catch {
    return json(res, 502, { error: "lookup_unavailable" });
  }
  if (!food) return json(res, 404, { found: false });
  CACHE.set(key, { at: Date.now(), food });
  if (CACHE.size > 200) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  return json(res, 200, { found: true, food });
}
