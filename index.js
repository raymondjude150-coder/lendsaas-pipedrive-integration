require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// IMPORTANT: Use subdomain only, e.g. "fundprollc" (not fundprollc.pipedrive.com)
const PIPEDRIVE_DOMAIN = process.env.PIPEDRIVE_DOMAIN;
const PIPEDRIVE_TOKEN = process.env.PIPEDRIVE_TOKEN;

// v1 base for create/update/move
const PD_V1 = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/v1`;
// v2 base for search
const PD_V2 = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v2`;

// ====== Your confirmed IDs ======
const PIPELINE_ID = 3;
const STAGE_NEW_SUBMISSION = 11;
const STAGE_FUNDED = 18;

// ====== Your confirmed Deal custom field keys ======
const FIELDS = {
  dealId: "56cb809cf0009cc189b968c54231dc32529b1ed3",
  amount: "02d50bd14fd4bbc20a07e72727dc96762a89f7ec",
  factorRate: "cd0317ac6d05f9d1f370a48c9f741bc0c664e591",
  termDays: "0585cd0555bdfcd14e9bdeeac660487096fcbbfe",
  payFreq: "7d9cb77d0d9a2245678c4973d5907b383fa501ea",
  origFee: "efb0a2350341e08af9e14a3cce1996be6ba933f8",
  isoCommission: "625d0abbd2dc7125fff559117ee1f019ceadbf8e",
  payStatus: "234193038359da67c9b84d74996ad5de101e658c",
  offerId: "84eca0981d035197e686b51932f4265aad2ed6ea"
};

// ====== Small retry helper for 429/timeouts ======
async function requestWithRetry(fn, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const status = err.response?.status;

      // Retry only for rate limit or network-ish errors
      const isRateLimit = status === 429;
      const isNetwork =
        !status && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND");

      if (attempt > retries || (!isRateLimit && !isNetwork)) throw err;

      const waitMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log(`[retry] attempt ${attempt}/${retries} waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ====== Pipedrive helpers ======
async function searchDealByDealId(dealId) {
  const res = await requestWithRetry(() =>
    axios.get(`${PD_V2}/deals/search`, {
      params: {
        api_token: PIPEDRIVE_TOKEN,
        term: dealId,
        fields: "custom_fields",
        exact_match: true
      }
    })
  );

  const items = res.data?.data?.items || [];
  // items look like: { item: { id, ... } }
  return items.length ? items[0].item : null;
}

async function getDeal(dealId) {
  const res = await requestWithRetry(() =>
    axios.get(`${PD_V1}/deals/${dealId}`, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function createDeal(body) {
  const res = await requestWithRetry(() =>
    axios.post(`${PD_V1}/deals`, body, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function updateDeal(dealId, body) {
  const res = await requestWithRetry(() =>
    axios.put(`${PD_V1}/deals/${dealId}`, body, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function moveDealStage(dealId, stageId) {
  return updateDeal(dealId, { stage_id: stageId });
}

// ====== Routes ======
app.get("/", (req, res) => res.send("LendSaaS Integration Running"));

// Webhook endpoint (works now; later client points LendSaaS to this URL)
app.post("/webhook/lendsaas", async (req, res) => {
  const data = req.body || {};

  try {
    if (!data.DealId) {
      return res.status(400).json({ error: "DealId required" });
    }

    // Build deal field payload (top-level keys, NOT custom_fields wrapper)
    const amount = Number(data.Amount || 0);

    const dealFields = {
      title: `${data.BorrowerName || "New Deal"} - $${amount}`,
      value: amount,
      pipeline_id: PIPELINE_ID,

      // Custom fields:
      [FIELDS.dealId]: String(data.DealId),
      [FIELDS.amount]: amount,
      [FIELDS.factorRate]: data.FactorRate != null ? String(data.FactorRate) : undefined,
      [FIELDS.termDays]: data.Term != null ? Number(data.Term) : undefined,
      [FIELDS.payFreq]: data.PaymentFrequency != null ? String(data.PaymentFrequency) : undefined,
      [FIELDS.origFee]: data.OriginationFee != null ? Number(data.OriginationFee) : undefined,
      [FIELDS.isoCommission]: data.CommissionPercentage != null ? Number(data.CommissionPercentage) : undefined,
      [FIELDS.payStatus]: data.PaymentStatus != null ? String(data.PaymentStatus) : undefined,
      [FIELDS.offerId]: data.OfferId != null ? Number(data.OfferId) : undefined
    };

    // Remove undefined values so we don't overwrite fields with null/undefined accidentally
    Object.keys(dealFields).forEach((k) => dealFields[k] === undefined && delete dealFields[k]);

    // Find existing
    const found = await searchDealByDealId(String(data.DealId));

    let pdDealId;
    let action;

    if (!found) {
      // CREATE
      const created = await createDeal({
        ...dealFields,
        stage_id: STAGE_NEW_SUBMISSION
      });
      pdDealId = created.id;
      action = "created";
      console.log(`[created] DealId=${data.DealId} PipedriveDealId=${pdDealId} Amount=${amount}`);
    } else {
      // UPDATE (keep stage unless we need to move to Funded)
      pdDealId = found.id;
      await updateDeal(pdDealId, dealFields);
      action = "updated";
      console.log(`[updated] DealId=${data.DealId} PipedriveDealId=${pdDealId}`);
    }

    // Stage movement: only "Performing" moves to Funded, never demote
    if (String(data.PaymentStatus || "").trim() === "Performing") {
      const current = await getDeal(pdDealId);
      if (current?.stage_id !== STAGE_FUNDED) {
        await moveDealStage(pdDealId, STAGE_FUNDED);
        console.log(`[stage] moved DealId=${data.DealId} ${current?.stage_id} -> ${STAGE_FUNDED}`);
      } else {
        console.log(`[stage] already funded DealId=${data.DealId}`);
      }
    }

    return res.status(200).json({ success: true, action, dealId: pdDealId });
  } catch (err) {
    const status = err.response?.status;
    const details = err.response?.data || err.message;

    console.error("[error]", status || "", details);

    // 401/403 usually means token invalid / permissions
    if (status === 401 || status === 403) {
      return res.status(500).json({ error: "Pipedrive auth failed (check token)", details });
    }

    return res.status(500).json({ error: "Processing failed", details });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
