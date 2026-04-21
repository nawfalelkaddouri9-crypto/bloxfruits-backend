const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

// Render API config (set these in your Render environment variables)
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

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

let stockState = loadCache();

// ── Dynamic Next-Action token ──────────────────────────────────────────────
// Stores the token and when it was last fetched so status page can display age
let nextActionToken = null;
let nextActionFetchedAt = null;

async function fetchNextActionToken() {
  console.log("[Token] Fetching Next-Action token from FruityBlox page...");
  try {
    const res = await axios.get("https://fruityblox.com/stock", {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
      }
    });

    const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

    // Next.js bakes server action IDs into the HTML as data-action-id or inside script tags
    // Pattern 1: "id":"<hash>" inside __NEXT_DATA__ or flight payload
    let token = null;

    // Try to find it in inline scripts / flight data — it's a 40-char hex string
    const patterns = [
      /["']Next-Action["']\s*:\s*["']([a-f0-9]{20,50})["']/i,
      /data-action(?:-id)?=["']([a-f0-9]{20,50})["']/i,
      /"id":"([a-f0-9]{20,50})"/,
      /([a-f0-9]{38,42})/,  // fallback: find any long hex string
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        token = match[1];
        console.log(`[Token] Found via pattern ${pattern}: ${token}`);
        break;
      }
    }

    if (token) {
      nextActionToken = token;
      nextActionFetchedAt = new Date().toISOString();
      console.log(`[Token] Token updated: ${token}`);
      return token;
    } else {
      console.warn("[Token] Could not extract token from page HTML.");
      return nextActionToken; // keep using old token if extraction fails
    }

  } catch (err) {
    console.error("[Token] Failed to fetch FruityBlox page:", err.message);
    return nextActionToken; // keep using old token
  }
}

// ── Bron 1: FruityBlox ─────────────────────────────────────────────────────
async function fetchFromFruityBlox() {
  console.log("[FruityBlox] Fetching...");

  // Always try to get a fresh token first
  const token = await fetchNextActionToken();

  if (!token) {
    console.warn("[FruityBlox] No token available, skipping.");
    return null;
  }

  try {
    const response = await axios.post(
      "https://fruityblox.com/stock",
      [],
      {
        timeout: 10000,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": token,
          "User-Agent": "Mozilla/5.0",
          "Origin": "https://fruityblox.com",
          "Referer": "https://fruityblox.com/stock",
        }
      }
    );

    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const lines = raw.split("\n");
    let stockData = null;

    for (const line of lines) {
      if (line.includes('"normal"')) {
        const jsonStr = line.replace(/^\d+:/, "");
        stockData = JSON.parse(jsonStr);
        break;
      }
    }

    if (!stockData) {
      console.warn("[FruityBlox] Geen 'normal' gevonden in response.");
      return null;
    }

    const normal = (stockData.normal || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    const mirage = (stockData.mirage || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    console.log("[FruityBlox] Normal:", normal.map(f => f.name));
    console.log("[FruityBlox] Mirage:", mirage.map(f => f.name));

    if (normal.length === 0) return null;
    return { normal, mirage };

  } catch (err) {
    console.error("[FruityBlox] Fout:", err.message);
    return null;
  }
}

// ── Bron 2: Wiki (fallback) ────────────────────────────────────────────────
async function fetchFromWiki() {
  console.log("[Wiki] Fetching...");
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );

    const wikitext = response.data?.parse?.wikitext?.["*"] || "";
    console.log("[Wiki] Snippet:", wikitext.slice(0, 300));

    let normalFruits = [];
    let mirageFruits = [];

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

    console.log("[Wiki] Normal:", normalFruits);
    console.log("[Wiki] Mirage:", mirageFruits);

    if (normalFruits.length === 0) {
      console.warn("[Wiki] Geen fruits gevonden — wiki formaat mogelijk veranderd.");
      return null;
    }

    return {
      normal: normalFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
      mirage: mirageFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
    };

  } catch (err) {
    console.error("[Wiki] Fout:", err.message);
    return null;
  }
}

// ── Stock updater ──────────────────────────────────────────────────────────
async function updateStock() {
  let stock = await fetchFromFruityBlox();

  if (!stock) {
    console.log("[Updater] FruityBlox mislukt, probeer Wiki...");
    stock = await fetchFromWiki();
  }

  if (!stock) {
    console.error("[Updater] Beide bronnen mislukt. Stock ongewijzigd.");
    return;
  }

  const newStockJSON = JSON.stringify(stock);
  if (JSON.stringify(stockState.current) !== newStockJSON) {
    console.log("[Updater] Nieuwe stock gedetecteerd — geschiedenis bijgewerkt.");
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = stock;
    stockState.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(stockState, null, 2));
  } else {
    console.log("[Updater] Stock ongewijzigd.");
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/stock", (req, res) => {
  res.json(stockState);
});

// Meta: token info for status page
app.get("/api/meta", (req, res) => {
  res.json({
    nextActionToken: nextActionToken ? nextActionToken.slice(0, 8) + "..." : null,
    nextActionFetchedAt: nextActionFetchedAt,
    renderConfigured: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
  });
});

// Debug: bekijk ruwe wiki tekst
app.get("/api/debug-wiki", async (req, res) => {
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );
    res.json({ wikitext: response.data?.parse?.wikitext?.["*"]?.slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: bekijk ruwe FruityBlox response
app.get("/api/debug-fruityblox", async (req, res) => {
  try {
    const token = await fetchNextActionToken();
    const response = await axios.post(
      "https://fruityblox.com/stock",
      [],
      {
        timeout: 10000,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": token || "",
          "User-Agent": "Mozilla/5.0",
          "Origin": "https://fruityblox.com",
          "Referer": "https://fruityblox.com/stock",
        }
      }
    );
    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    res.json({ raw: raw.slice(0, 3000), token: token ? token.slice(0, 8) + "..." : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clear cache
app.post("/api/clear-cache", (req, res) => {
  try {
    stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log("[Cache] Cache cleared via API");
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Force fetch
app.post("/api/force-fetch", async (req, res) => {
  try {
    await updateStock();
    res.json({ ok: true, message: "Stock fetch completed" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Render API routes ──────────────────────────────────────────────────────

// Restart server (Render: suspend then resume = restart)
app.post("/api/render-restart", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    return res.status(503).json({ error: "Render API not configured. Set RENDER_API_KEY and RENDER_SERVICE_ID env vars." });
  }
  try {
    console.log("[Render] Restarting service...");
    const response = await axios.post(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`,
      {},
      {
        timeout: 15000,
        headers: {
          "Authorization": `Bearer ${RENDER_API_KEY}`,
          "Accept": "application/json",
        }
      }
    );
    console.log("[Render] Restart triggered:", response.status);
    res.json({ ok: true, message: "Server restart triggered" });
  } catch (e) {
    console.error("[Render] Restart failed:", e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Trigger redeploy
app.post("/api/render-redeploy", async (req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    return res.status(503).json({ error: "Render API not configured. Set RENDER_API_KEY and RENDER_SERVICE_ID env vars." });
  }
  try {
    console.log("[Render] Triggering redeploy...");
    const response = await axios.post(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`,
      { clearCache: "do_not_clear" },
      {
        timeout: 15000,
        headers: {
          "Authorization": `Bearer ${RENDER_API_KEY}`,
          "Accept": "application/json",
          "Content-Type": "application/json",
        }
      }
    );
    console.log("[Render] Redeploy triggered:", response.status);
    res.json({ ok: true, message: "Redeploy triggered", deployId: response.data?.id });
  } catch (e) {
    console.error("[Render] Redeploy failed:", e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server draait op poort ${PORT}`);
  await updateStock();
  setInterval(updateStock, POLL_INTERVAL_MS);
});
