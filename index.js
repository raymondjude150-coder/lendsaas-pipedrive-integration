require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PIPEDRIVE_DOMAIN = process.env.PIPEDRIVE_DOMAIN;
const PIPEDRIVE_TOKEN = process.env.PIPEDRIVE_TOKEN;

// Basic health check
app.get("/", (req, res) => {
  res.send("LendSaaS Integration Running");
});

app.post("/webhook/lendsaas", async (req, res) => {
  try {
    const data = req.body;
    console.log("Received webhook:", JSON.stringify(data));

    if (!data || !data.DealId) {
      return res.status(400).json({ error: "DealId required" });
    }

    // TODO later: search/create/update deal in Pipedrive
    return res.status(200).json({ success: true, receivedDealId: data.DealId });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
