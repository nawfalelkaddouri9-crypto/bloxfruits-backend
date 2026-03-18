const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const FRUITYBLOX_APP_ID = "1086680940423434380"; // FruityBlox Stock Bot app ID

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to read cache:", e.message);
  }
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to write cache:", e.message);
  }
}

let stockState = loadCache();

// ─── Parse Discord embed ──────────────────────────────────────────────────────

function parseStockEmbed(embeds) {
  const result = { normal: [], mirage: [] };
  if (!embeds || embeds.length === 0) return null;

  const embed = embeds[0];
  const description = embed.description || "";
  const fields = embed.fields || [];

  // Try parsing from fields first
  let currentSection = null;
  for (const field of fields) {
    const name = field.name?.toLowerCase() || "";
    if (name.includes("normal")) currentSection = "normal";
    else if (name.includes("mirage")) currentSection = "mirage";

    if (currentSection && field.value) {
      const lines = field.value.split("\n");
      for (const line of lines) {
        const match = line.match(/([A-Za-z]+)\s*[-–]\s*\$?\s*([\d,]+)/);
        if (match) {
          result[currentSection].push({
            name: match[1].trim(),
            price: parseInt(match[2].replace(/,/g, "")),
          });
        }
      }
    }
  }

  // Try parsing from description if fields didn't work
  if (result.normal.length === 0 && result.mirage.length === 0 && description) {
    const lines = description.split("\n");
    currentSection = null;
    for (const line of lines) {
      if (line.toLowerCase().includes("normal stock")) { currentSection = "normal"; continue; }
      if (line.toLowerCase().includes("mirage stock")) { currentSection = "mirage"; continue; }
      if (currentSection) {
        const match = line.match(/([A-Za-z]+)\s*[-–]\s*\$?\s*([\d,]+)/);
        if (match) {
          result[currentSection].push({
            name: match[1].trim(),
            price: parseInt(match[2].replace(/,/g, "")),
          });
        }
      }
    }
  }

  if (result.normal.length === 0 && result.mirage.length === 0) return null;
  return result;
}

function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  if (!newStock) return false;
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

// ─── Discord client ───────────────────────────────────────────────────────────

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function fetchStockFromDiscord() {
  console.log(`[${new Date().toISOString()}] Fetching stock from Discord...`);
  try {
    const channel = await discordClient.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error("Channel not found!");
      return;
    }

    // Send /stock command by posting a message that triggers the bot
    // Instead, read the last 20 messages and find the most recent stock embed
    const messages = await channel.messages.fetch({ limit: 20 });
    
    let latestStock = null;
    let latestTimestamp = 0;

    for (const msg of messages.values()) {
      // Look for messages from the FruityBlox bot with embeds
      if (msg.embeds && msg.embeds.length > 0) {
        const embed = msg.embeds[0];
        const isStockEmbed = 
          embed.title?.toLowerCase().includes("stock") ||
          embed.description?.toLowerCase().includes("normal stock") ||
          embed.author?.name?.toLowerCase().includes("fruityblox");

        if (isStockEmbed && msg.createdTimestamp > latestTimestamp) {
          const parsed = parseStockEmbed(msg.embeds);
          if (parsed) {
            latestStock = parsed;
            latestTimestamp = msg.createdTimestamp;
          }
        }
      }
    }

    if (!latestStock) {
      console.log(`[${new Date().toISOString()}] No stock embed found in last 20 messages.`);
      return;
    }

    if (!stockHasChanged(stockState.current, latestStock)) {
      console.log(`[${new Date().toISOString()}] Stock unchanged — skipping.`);
      return;
    }

    console.log(`[${new Date().toISOString()}] New stock detected! Saving...`);
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = latestStock;
    stockState.lastUpdated = new Date().toISOString();
    saveCache(stockState);
    console.log(`[${new Date().toISOString()}] Stock updated:`, JSON.stringify(latestStock));

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Discord fetch failed:`, err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/stock", (req, res) => {
  if (!stockState.current) {
    return res.status(503).json({
      error: "Stock data not yet available.",
      lastUpdated: stockState.lastUpdated,
    });
  }
  res.json({
    current: stockState.current,
    last: stockState.last,
    beforeLast: stockState.beforeLast,
    lastUpdated: stockState.lastUpdated,
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    hasData: !!stockState.current,
    lastUpdated: stockState.lastUpdated,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

discordClient.once("ready", async () => {
  console.log(`Discord bot logged in as ${discordClient.user.tag}`);
  await fetchStockFromDiscord();
  setInterval(fetchStockFromDiscord, POLL_INTERVAL_MS);
});

discordClient.login(DISCORD_TOKEN).catch(err => {
  console.error("Failed to login to Discord:", err.message);
});

app.listen(PORT, () => {
  console.log(`Blox Fruits Stock Server running on port ${PORT}`);
});
