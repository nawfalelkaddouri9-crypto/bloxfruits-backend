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
  "Ghost": 850000, "Diamond": 600000, "Light": 650000, "Rubber": 750000, "Magma": 850000,
  "Quake": 1000000, "Buddha": 1200000, "Love": 1300000, "Spider": 1500000, "Sound": 1700000, a
  "Gravity": 2500000, "Mammoth": 2700000, "T-Rex": 2700000, "Dough": 2800000,
  "Shadow": 2900000, "Venom": 3000000, "Control": 10000000, "Spirit": 3400000,
  "Kitsune": 8000000, "Dragon": 15000000,
  "Lightning": 2000000, "Pain": 2200000, "Gas": 2300000,
  "Tiger": 5000000, "Yeti": 5000000,
};

// ── Cache loader ───────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

let stockState = loadCache();

// ── Source health tracking ─────────────────────────────────────────────────
const sourceHealth = {
  fruityblox: {
    consecutiveFailures: 0,
    lastSuccess: null,
    lastAttempt: null,
    lastResponseMs: null,
    status: "unknown",
    skippedUntil: null,
  },
  wiki: {
    consecutiveFailures: 0,
    lastSuccess: null,
    lastAttempt: null,
    lastResponseMs: null,
    status: "unknown",
    skippedUntil: null,
  }
};

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

function shouldSkipSource(source) {
  const h = sourceHealth[source];
  if (h.skippedUntil && Date.now() < h.skippedUntil) {
    const minsLeft = Math.ceil((h.skippedUntil - Date.now()) / 60000);
    console.log(`[RateLimit] Skipping ${source} — backed off for ${minsLeft} more min`);
    h.status = "skipped";
    return true;
  }
  if (h.skippedUntil && Date.now() >= h.skippedUntil) {
    console.log(`[RateLimit] Backoff expired for ${source} — retrying`);
    h.skippedUntil = null;
    h.consecutiveFailures = 0;
  }
  return false;
}

function recordSuccess(source, responseMs) {
  const h = sourceHealth[source];
  h.consecutiveFailures = 0;
  h.lastSuccess = new Date().toISOString();
  h.lastResponseMs = responseMs;
  h.skippedUntil = null;
  h.status = "ok";
}

function recordFailure(source) {
  const h = sourceHealth[source];
  h.consecutiveFailures++;
  h.status = h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? "offline" : "degraded";
  if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    h.skippedUntil = Date.now() + BACKOFF_MS;
    console.warn(`[RateLimit] ${source} hit ${MAX_CONSECUTIVE_FAILURES} failures — backing off 10 min`);
  }
}

// ── Smart token system ─────────────────────────────────────────────────────
let tokenState = {
  value: null,
  fetchedAt: null,
  worksConfirmed: false,
  fetchAttempts: 0,
};

// Patterns tried in order — most specific first
const TOKEN_PATTERNS = [
  /["']([a-f0-9]{40})["']/g,
  /data-action(?:-id)?=["']([a-f0-9]{20,50})["']/gi,
  /"id"\s*:\s*"([a-f0-9]{38,42})"/g,
  /Next-Action['":\s]+([a-f0-9]{30,50})/gi,
  /\b([a-f0-9]{38,42})\b/g,
];

async function extractTokenFromPage() {
  console.log("[Token] Fetching FruityBlox page...");
  const start = Date.now();
  try {
    const res = await axios.get("https://fruityblox.com/stock", {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      }
    });

    const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.log(`[Token] Page fetched in ${Date.now() - start}ms (${html.length} chars)`);

    const candidates = new Map();
    for (const pattern of TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const c = match[1];
        if (c && /^[a-f0-9]{36,44}$/.test(c)) {
          candidates.set(c, (candidates.get(c) || 0) + 1);
        }
      }
    }

    if (candidates.size === 0) {
      console.warn("[Token] No candidates found in page HTML");
      return null;
    }

    const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
    const best = sorted[0][0];
    console.log(`[Token] Best candidate: ${best.slice(0,12)}... (seen ${sorted[0][1]}x out of ${candidates.size} candidates)`);
    return best;

  } catch (err) {
    console.error("[Token] Page fetch failed:", err.message);
    return null;
  }
}

async function getToken(forceRefresh = false) {
  if (tokenState.value && tokenState.worksConfirmed && !forceRefresh) {
    return tokenState.value;
  }
  if (tokenState.fetchAttempts >= 3) {
    console.warn("[Token] Max fetch attempts this cycle — using cached token");
    return tokenState.value;
  }

  tokenState.fetchAttempts++;
  const newToken = await extractTokenFromPage();

  if (newToken) {
    if (newToken !== tokenState.value) {
      console.log(`[Token] Token changed: ${tokenState.value?.slice(0,8) || "none"} → ${newToken.slice(0,8)}`);
      tokenState.worksConfirmed = false;
    }
    tokenState.value = newToken;
    tokenState.fetchedAt = new Date().toISOString();
  }

  return tokenState.value;
}

function resetTokenAttempts() {
  tokenState.fetchAttempts = 0;
}

// ── FruityBlox fetch ───────────────────────────────────────────────────────
async function fetchFromFruityBlox() {
  if (shouldSkipSource("fruityblox")) return null;

  sourceHealth.fruityblox.lastAttempt = new Date().toISOString();
  console.log("[FruityBlox] Fetching...");

  let token = await getToken(false);
  if (!token) {
    console.warn("[FruityBlox] No token — skipping");
    recordFailure("fruityblox");
    return null;
  }

  const start = Date.now();
  try {
    const response = await axios.post(
      "https://fruityblox.com/stock", [],
      {
        timeout: 10000,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": token,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Origin": "https://fruityblox.com",
          "Referer": "https://fruityblox.com/stock",
        }
      }
    );

    const responseMs = Date.now() - start;
    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    let stockData = null;

    for (const line of raw.split("\n")) {
      if (line.includes('"normal"')) {
        try { stockData = JSON.parse(line.replace(/^\d+:/, "")); break; }
        catch(e) { /* try next */ }
      }
    }

    if (!stockData?.normal) {
      console.warn("[FruityBlox] No 'normal' in response — token likely stale");
      tokenState.worksConfirmed = false;
      recordFailure("fruityblox");
      return null;
    }

    tokenState.worksConfirmed = true;
    recordSuccess("fruityblox", responseMs);

    const normal = (stockData.normal || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    const mirage = (stockData.mirage || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    console.log(`[FruityBlox] OK in ${responseMs}ms — Normal: ${normal.map(f=>f.name).join(", ")}`);
    if (normal.length === 0) { recordFailure("fruityblox"); return null; }
    return { normal, mirage };

  } catch (err) {
    const responseMs = Date.now() - start;
    console.error(`[FruityBlox] Error after ${responseMs}ms:`, err.message);
    sourceHealth.fruityblox.lastResponseMs = responseMs;
    recordFailure("fruityblox");
    if (tokenState.worksConfirmed) {
      console.log("[FruityBlox] Token was working but now fails — will re-extract next cycle");
      tokenState.worksConfirmed = false;
    }
    return null;
  }
}

// ── Wiki fetch ─────────────────────────────────────────────────────────────
async function fetchFromWiki() {
  if (shouldSkipSource("wiki")) return null;

  sourceHealth.wiki.lastAttempt = new Date().toISOString();
  console.log("[Wiki] Fetching...");

  const start = Date.now();
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );

    const responseMs = Date.now() - start;
    const wikitext = response.data?.parse?.wikitext?.["*"] || "";

    let normalFruits = [], mirageFruits = [];
    const currentMatch = wikitext.match(/\|\s*[Cc]urrent\s*=\s*([^\n|\]]+)/);
    if (currentMatch) {
      normalFruits = currentMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => name && name !== "Rocket" && name !== "Spin" && FRUIT_PRICES[name]);
    }
    const mirageMatch = wikitext.match(/\|\s*[Mm]irage\s*=\s*([^\n|\]]+)/);
    if (mirageMatch) {
      mirageFruits = mirageMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => name && name !== "Rocket" && name !== "Spin" && FRUIT_PRICES[name]);
    }

    if (normalFruits.length === 0) {
      console.warn("[Wiki] No fruits found");
      recordFailure("wiki");
      return null;
    }

    recordSuccess("wiki", responseMs);
    console.log(`[Wiki] OK in ${responseMs}ms — Normal: ${normalFruits.join(", ")}`);
    return {
      normal: normalFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
      mirage: mirageFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
    };

  } catch (err) {
    const responseMs = Date.now() - start;
    console.error(`[Wiki] Error after ${responseMs}ms:`, err.message);
    sourceHealth.wiki.lastResponseMs = responseMs;
    recordFailure("wiki");
    return null;
  }
}

// ── Stock updater ──────────────────────────────────────────────────────────
async function updateStock() {
  resetTokenAttempts();
  let stock = await fetchFromFruityBlox();
  if (!stock) {
    console.log("[Updater] FruityBlox failed, trying Wiki...");
    stock = await fetchFromWiki();
  }
  if (!stock) { console.error("[Updater] Both sources failed."); return; }

  const newStockJSON = JSON.stringify(stock);
  if (JSON.stringify(stockState.current) !== newStockJSON) {
    console.log("[Updater] New stock detected — updating history.");
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = stock;
    stockState.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(stockState, null, 2));
  } else {
    console.log("[Updater] Stock unchanged.");
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/api/stock", (req, res) => res.json(stockState));

app.get("/api/meta", (req, res) => {
  res.json({
    nextActionToken: tokenState.value ? tokenState.value.slice(0, 8) + "..." : null,
    nextActionFetchedAt: tokenState.fetchedAt,
    nextActionConfirmed: tokenState.worksConfirmed,
    renderConfigured: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
    sources: {
      fruityblox: { ...sourceHealth.fruityblox },
      wiki: { ...sourceHealth.wiki },
    }
  });
});

app.get("/api/debug-wiki", async (req, res) => {
  try {
    const r = await axios.get("https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json", { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
    res.json({ wikitext: r.data?.parse?.wikitext?.["*"]?.slice(0, 2000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug-fruityblox", async (req, res) => {
  try {
    const token = await getToken(false);
    const r = await axios.post("https://fruityblox.com/stock", [], { timeout: 10000, headers: { "Content-Type": "text/plain;charset=UTF-8", "Next-Action": token || "", "User-Agent": "Mozilla/5.0", "Origin": "https://fruityblox.com", "Referer": "https://fruityblox.com/stock" } });
    const raw = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    res.json({ raw: raw.slice(0, 3000), token: token ? token.slice(0, 8) + "..." : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/clear-cache", (req, res) => {
  try {
    stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/force-fetch", async (req, res) => {
  try {
    await updateStock();
    res.json({ ok: true, message: "Stock fetch completed", sourceUsed: sourceHealth.fruityblox.status === "ok" ? "fruityblox" : "wiki" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/refresh-token", async (req, res) => {
  try {
    tokenState.worksConfirmed = false;
    tokenState.fetchAttempts = 0;
    const token = await getToken(true);
    res.json({ ok: !!token, token: token ? token.slice(0, 8) + "..." : null, fetchedAt: tokenState.fetchedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/reset-source/:source", (req, res) => {
  const src = req.params.source;
  if (!sourceHealth[src]) return res.status(400).json({ error: "Unknown source" });
  sourceHealth[src].consecutiveFailures = 0;
  sourceHealth[src].skippedUntil = null;
  sourceHealth[src].status = "unknown";
  console.log(`[RateLimit] Source ${src} manually reset`);
  res.json({ ok: true, message: `${src} backoff cleared` });
});

app.post("/api/render-restart", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(503).json({ error: "Render API not configured." });
  try {
    await axios.post(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`, {}, { timeout: 15000, headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Accept": "application/json" } });
    res.json({ ok: true, message: "Server restart triggered" });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post("/api/render-redeploy", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return res.status(503).json({ error: "Render API not configured." });
  try {
    const r = await axios.post(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`, { clearCache: "do_not_clear" }, { timeout: 15000, headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Accept": "application/json", "Content-Type": "application/json" } });
    res.json({ ok: true, message: "Redeploy triggered", deployId: r.data?.id });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[Server] Running on port ${PORT}`);
  await updateStock();
  setInterval(updateStock, POLL_INTERVAL_MS);
});
