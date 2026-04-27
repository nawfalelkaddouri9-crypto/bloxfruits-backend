const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const RENDER_API_KEY = process.env.RENDER_API_KEY || "";
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || "";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const FRUIT_PRICES = {
  "Spring": 60000, "Bomb": 80000, "Smoke": 100000,
  "Spike": 180000, "Flame": 250000, "Ice": 350000, "Sand": 420000, "Dark": 500000,
  "Ghost": 550000, "Diamond": 600000, "Light": 650000, "Rubber": 750000, "Magma": 850000,
  "Quake": 1000000, "Buddha": 1200000, "Love": 1300000, "Spider": 1500000, "Sound": 1700000,
  "Phoenix": 1800000, "Portal": 1900000, "Rumble": 2100000, "Blizzard": 2400000,
  "Gravity": 2500000, "Mammoth": 2700000, "T-Rex": 2700000, "Dough": 2800000,
  "Shadow": 2900000, "Venom": 3000000, "Control": 3200000, "Spirit": 3400000,
  "Kitsune": 8000000, "Dragon": 10000000,
  "Blade": 600000, "Eagle": 650000, "Creation": 3000000,
  "Lightning": 2000000, "Pain": 2200000, "Gas": 2300000,
  "Tiger": 2000000, "Yeti": 2100000,
};

const BLOCKED = new Set(["Rocket", "Spin"]);

// ── Cache ──────────────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE))
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

let stockState = loadCache();

// ── Source health ──────────────────────────────────────────────────────────
const sourceHealth = {
  fruityblox: { status: "unknown", lastSuccess: null, lastAttempt: null, lastResponseMs: null, consecutiveFailures: 0 },
  wiki:        { status: "unknown", lastSuccess: null, lastAttempt: null, lastResponseMs: null, consecutiveFailures: 0 },
};

function recordSuccess(src, ms) {
  const h = sourceHealth[src];
  h.status = "ok";
  h.consecutiveFailures = 0;
  h.lastSuccess = new Date().toISOString();
  h.lastResponseMs = ms;
}

function recordFailure(src, ms) {
  const h = sourceHealth[src];
  h.consecutiveFailures++;
  h.lastResponseMs = ms ?? null;
  h.status = h.consecutiveFailures >= 5 ? "offline" : "degraded";
}

// ── Token: scrape fresh from page every time ───────────────────────────────
let cachedToken = null;
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 5 * 60 * 1000; // hergebruik max 5 min

async function fetchToken() {
  // Gebruik gecachte token als hij recent is
  if (cachedToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) {
    console.log(`[Token] Using cached token: ${cachedToken.slice(0, 10)}...`);
    return cachedToken;
  }

  console.log("[Token] Scraping fresh token from FruityBlox...");
  try {
    const res = await axios.get("https://fruityblox.com/stock", {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });

    const html = res.data;

    // Zoek alle Next-Action achtige tokens (hex strings 30-60 chars)
    const matches = [...html.matchAll(/([a-f0-9]{38,50})/g)]
      .map(m => m[1]);

    // Tel frequentie — meest voorkomende is het meest betrouwbaar
    const freq = {};
    for (const m of matches) freq[m] = (freq[m] || 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
      console.warn("[Token] No token candidates found in HTML");
      return null;
    }

    const token = sorted[0][0];
    console.log(`[Token] Found: ${token.slice(0, 10)}... (${sorted[0][1]}x in page)`);
    cachedToken = token;
    tokenFetchedAt = Date.now();
    return token;

  } catch (err) {
    console.error("[Token] Scrape failed:", err.message);
    return cachedToken || null; // val terug op oude token
  }
}

// ── FruityBlox ─────────────────────────────────────────────────────────────
async function fetchFromFruityBlox() {
  sourceHealth.fruityblox.lastAttempt = new Date().toISOString();
  console.log("[FruityBlox] Fetching...");

  const token = await fetchToken();
  if (!token) {
    console.warn("[FruityBlox] No token available — skipping");
    recordFailure("fruityblox");
    return null;
  }

  const start = Date.now();
  try {
    const res = await axios.post("https://fruityblox.com/stock", [], {
      timeout: 10000,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Next-Action": token,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124",
        "Origin": "https://fruityblox.com",
        "Referer": "https://fruityblox.com/stock",
        "Accept": "*/*",
      }
    });

    const ms = Date.now() - start;
    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

    // Parse Next.js server action response
    // Formaat: "0:{...meta...}\n1:{...stockdata...}\n"
    let stockData = null;
    for (const line of raw.split("\n")) {
      const clean = line.replace(/^\d+:/, "").trim();
      if (!clean.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(clean);
        if (parsed.normal || parsed.mirage) {
          stockData = parsed;
          break;
        }
      } catch (_) {}
    }

    if (!stockData) {
      // Token is verlopen — invalideert cache zodat volgende call opnieuw scrapet
      console.warn("[FruityBlox] No stock data in response — token may be stale, clearing cache");
      cachedToken = null;
      recordFailure("fruityblox", ms);
      return null;
    }

    const normal = (stockData.normal || [])
      .filter(f => f?.name && !BLOCKED.has(f.name))
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    const mirage = (stockData.mirage || [])
      .filter(f => f?.name && !BLOCKED.has(f.name))
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    if (normal.length === 0) {
      console.warn("[FruityBlox] Parsed data has 0 normal fruits — suspicious, skipping");
      recordFailure("fruityblox", ms);
      return null;
    }

    recordSuccess("fruityblox", ms);
    console.log(`[FruityBlox] ✓ ${ms}ms — Normal: ${normal.map(f => f.name).join(", ")}`);
    if (mirage.length) console.log(`[FruityBlox] Mirage: ${mirage.map(f => f.name).join(", ")}`);
    return { normal, mirage };

  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[FruityBlox] ✗ ${ms}ms — ${err.message}`);
    // Bij 4xx/5xx: token waarschijnlijk verlopen
    if (err.response?.status >= 400) {
      console.log("[FruityBlox] HTTP error — clearing token cache");
      cachedToken = null;
    }
    recordFailure("fruityblox", ms);
    return null;
  }
}

// ── Wiki (altijd secondary) ────────────────────────────────────────────────
async function fetchFromWiki() {
  sourceHealth.wiki.lastAttempt = new Date().toISOString();
  console.log("[Wiki] Fetching (secondary/fallback)...");

  const start = Date.now();
  try {
    const res = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 12000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );

    const ms = Date.now() - start;
    const wikitext = res.data?.parse?.wikitext?.["*"] || "";

    let normalFruits = [], mirageFruits = [];

    const normalMatch = wikitext.match(/\|\s*[Cc]urrent\s*=\s*([^\n|\]]+)/);
    if (normalMatch) {
      normalFruits = normalMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(n => n && !BLOCKED.has(n) && FRUIT_PRICES[n]);
    }

    const mirageMatch = wikitext.match(/\|\s*[Mm]irage\s*=\s*([^\n|\]]+)/);
    if (mirageMatch) {
      mirageFruits = mirageMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(n => n && !BLOCKED.has(n) && FRUIT_PRICES[n]);
    }

    if (normalFruits.length === 0) {
      console.warn("[Wiki] No fruits parsed — wiki format may have changed");
      recordFailure("wiki", ms);
      return null;
    }

    recordSuccess("wiki", ms);
    console.log(`[Wiki] ✓ ${ms}ms — Normal: ${normalFruits.join(", ")}`);
    return {
      normal: normalFruits.map(n => ({ name: n, price: FRUIT_PRICES[n] })),
      mirage: mirageFruits.map(n => ({ name: n, price: FRUIT_PRICES[n] })),
    };

  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[Wiki] ✗ ${ms}ms — ${err.message}`);
    recordFailure("wiki", ms);
    return null;
  }
}

// ── Core updater ───────────────────────────────────────────────────────────
async function updateStock() {
  // Altijd FruityBlox eerst, Wiki altijd als fallback
  let stock = await fetchFromFruityBlox();
  let usedSource = "fruityblox";

  if (!stock) {
    console.log("[Updater] FruityBlox failed — falling back to Wiki");
    stock = await fetchFromWiki();
    usedSource = "wiki";
  }

  if (!stock) {
    console.error("[Updater] Both sources failed — stock unchanged");
    return false;
  }

  const newJSON = JSON.stringify(stock);
  if (JSON.stringify(stockState.current) !== newJSON) {
    console.log(`[Updater] New stock from ${usedSource} — updating history`);
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = stock;
    stockState.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(stockState, null, 2));
  } else {
    console.log(`[Updater] Stock unchanged (source: ${usedSource})`);
  }

  return true;
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/stock", (req, res) => {
  res.json(stockState);
});

app.get("/api/meta", (req, res) => {
  res.json({
    token: cachedToken ? cachedToken.slice(0, 10) + "..." : null,
    tokenFetchedAt: tokenFetchedAt ? new Date(tokenFetchedAt).toISOString() : null,
    tokenAgeMs: cachedToken ? Date.now() - tokenFetchedAt : null,
    sources: sourceHealth,
    renderConfigured: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
  });
});

// Echte refresh: forceert fetch + stuurt nieuwe stock terug
app.post("/api/refresh", async (req, res) => {
  console.log("[Refresh] Manual refresh triggered");
  cachedToken = null; // forceer nieuwe token scrape
  const ok = await updateStock();
  res.json({
    ok,
    stock: stockState,
    sources: sourceHealth,
  });
});

app.post("/api/clear-cache", (req, res) => {
  try {
    stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log("[Cache] Cleared via API");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/force-fetch", async (req, res) => {
  cachedToken = null;
  const ok = await updateStock();
  res.json({
    ok,
    message: ok ? "Fetch completed" : "Both sources failed",
    usedSource: sourceHealth.fruityblox.status === "ok" ? "fruityblox" : "wiki",
    sources: sourceHealth,
  });
});

app.post("/api/refresh-token", async (req, res) => {
  cachedToken = null;
  tokenFetchedAt = 0;
  const token = await fetchToken();
  res.json({ ok: !!token, token: token ? token.slice(0, 10) + "..." : null });
});

app.post("/api/reset-source/:source", (req, res) => {
  const src = req.params.source;
  if (!sourceHealth[src]) return res.status(400).json({ error: "Unknown source" });
  sourceHealth[src].consecutiveFailures = 0;
  sourceHealth[src].status = "unknown";
  console.log(`[Reset] Source ${src} manually reset`);
  res.json({ ok: true });
});

app.get("/api/debug-wiki", async (req, res) => {
  try {
    const r = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    res.json({ wikitext: r.data?.parse?.wikitext?.["*"]?.slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/debug-fruityblox", async (req, res) => {
  try {
    const token = await fetchToken();
    const r = await axios.post("https://fruityblox.com/stock", [], {
      timeout: 10000,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Next-Action": token || "",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Origin": "https://fruityblox.com",
        "Referer": "https://fruityblox.com/stock",
      }
    });
    const raw = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    res.json({ raw: raw.slice(0, 3000), token: token ? token.slice(0, 10) + "..." : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/render-restart", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID)
    return res.status(503).json({ error: "Render API not configured" });
  try {
    await axios.post(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`, {},
      { timeout: 15000, headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Accept": "application/json" } }
    );
    res.json({ ok: true, message: "Restart triggered" });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.post("/api/render-redeploy", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID)
    return res.status(503).json({ error: "Render API not configured" });
  try {
    const r = await axios.post(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`,
      { clearCache: "do_not_clear" },
      { timeout: 15000, headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Accept": "application/json", "Content-Type": "application/json" } }
    );
    res.json({ ok: true, deployId: r.data?.id });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[Server] Running on port ${PORT}`);
  await updateStock();
  setInterval(updateStock, POLL_INTERVAL_MS);
});
