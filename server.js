const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000; 
const POLL_INTERVAL_MS = 2 * 60 * 1000; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const FRUIT_PRICES = { /* ... behoud de prijslijst uit je huidige script ... */ };

// Model herstellen naar de structuur met 'last'
let stockState = { 
    current: null, 
    last: null, 
    lastUpdated: null 
};

async function fetchFromWiki() {
    try {
        const response = await axios.get("https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json", { timeout: 10000 });
        const wikitext = response.data?.parse?.wikitext?.["*"] || "";
        const currentMatch = wikitext.match(/\|Current\s*=\s*([^\n|]+)/);
        if (!currentMatch) return null;
        return currentMatch[1].split(",").map(s => s.trim()).filter(n => FRUIT_PRICES[n]).map(n => ({ name: n, price: FRUIT_PRICES[n] }));
    } catch (err) { return null; }
}

async function updateStock() {
    const newStock = await fetchFromWiki();
    if (newStock && JSON.stringify(stockState.current) !== JSON.stringify(newStock)) {
        stockState.last = stockState.current; // Vorige stock bewaren voor de UI
        stockState.current = newStock;
        stockState.lastUpdated = new Date().toISOString();
    }
}

app.get("/api/stock", (req, res) => res.json(stockState));

app.listen(PORT, async () => {
    await updateStock();
    setInterval(updateStock, POLL_INTERVAL_MS);
});
