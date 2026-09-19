require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer"); // npm install multer — parses multipart/form-data (FormData + file upload)
const crypto = require("crypto");
const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
 
const {
    SHOPIFY_STORE_DOMAIN,      // e.g. "your-store.myshopify.com"
    SHOPIFY_ADMIN_ACCESS_TOKEN, // from your custom app's Admin API access token
    SHOPIFY_API_VERSION,       // e.g. "2025-01"
    SHIPROCKET_EMAIL,          // Shiprocket account login email
    SHIPROCKET_PASSWORD,       // Shiprocket account login password
    SHIPROCKET_PICKUP_PINCODE  // pincode registered as your Shiprocket pickup address
} = process.env;

const API_VERSION = SHOPIFY_API_VERSION || "2025-01";
const ADMIN_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// The metaobject "type" handle as defined in Shopify Admin > Content > Metaobjects.
// Must match exactly what your storefront section reads from
// (shop.metaobjects.customer_reviews.values).
const METAOBJECT_TYPE = "customer_reviews";

app.use(cors());
app.use(express.json());
// ── Request logger (with body) ──
app.use((req, res, next) => {
    const start = Date.now();
    const { method, originalUrl, body } = req;

    res.on("finish", () => {
        const ms = Date.now() - start;
        const status = res.statusCode;
        const marker = status >= 500 ? "🔴" : status >= 400 ? "🟡" : "🟢";

        const safeBody = { ...body };
        delete safeBody.password;
        delete safeBody.mobile; // strip if you don't want phone numbers in logs

        console.log(`${marker} ${method} ${originalUrl} ${status} - ${ms}ms`, JSON.stringify(safeBody));
    });

    next();
});
app.get("/", (req, res) => {
    res.send("Review API Running");
});

/**
 * Low-level helper: fire a GraphQL request at the Shopify Admin API.
 */
async function shopifyAdminGraphQL(query, variables) {
    const response = await fetch(ADMIN_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN
        },
        body: JSON.stringify({ query, variables })
    });

    const json = await response.json();

    if (!response.ok || json.errors) {
        throw new Error(
            "Shopify Admin API error: " + JSON.stringify(json.errors || json)
        );
    }

    return json.data;
}

/**
 * Uploads a single in-memory file buffer to Shopify Files using the
 * staged-upload flow, and returns the resulting File's GID once ready
 * to be referenced (e.g. as a metaobject "file" field value).
 *
 * Flow: stagedUploadsCreate -> POST bytes to the staged URL -> fileCreate
 */
async function uploadImageToShopifyFiles(file) {
    // Step 1: ask Shopify for a staged upload target
    const stagedUploadsQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

    const stagedData = await shopifyAdminGraphQL(stagedUploadsQuery, {
        input: [
            {
                filename: file.originalname,
                mimeType: file.mimetype,
                httpMethod: "POST",
                resource: "FILE"
            }
        ]
    });

    const stagedErrors = stagedData.stagedUploadsCreate.userErrors;
    if (stagedErrors && stagedErrors.length) {
        throw new Error("stagedUploadsCreate error: " + JSON.stringify(stagedErrors));
    }

    const target = stagedData.stagedUploadsCreate.stagedTargets[0];

    // Step 2: upload the actual bytes to the staged target URL
    const formData = new FormData();
    target.parameters.forEach((param) => {
        formData.append(param.name, param.value);
    });
    formData.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);

    const uploadResponse = await fetch(target.url, {
        method: "POST",
        body: formData
    });

    if (!uploadResponse.ok) {
        throw new Error("Failed to upload file bytes to staged target (status " + uploadResponse.status + ")");
    }

    // Step 3: register the uploaded file as a Shopify File and get its GID
    const fileCreateQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
        }
        userErrors { field message }
      }
    }
  `;

    const fileData = await shopifyAdminGraphQL(fileCreateQuery, {
        files: [
            {
                originalSource: target.resourceUrl,
                contentType: "IMAGE"
            }
        ]
    });

    const fileErrors = fileData.fileCreate.userErrors;
    if (fileErrors && fileErrors.length) {
        throw new Error("fileCreate error: " + JSON.stringify(fileErrors));
    }

    return fileData.fileCreate.files[0].id; // e.g. "gid://shopify/MediaImage/12345"
}

/**
 * Creates the customer_reviews metaobject entry with published = false,
 * so it only appears on the storefront after an admin approves it.
 */
async function createReviewMetaobject({
    productId,
    customerName,
    location,
    rating,
    reviewText,
    customerImageFileGid
}) {
    const mutation = `
    mutation metaobjectCreate($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }
  `;

    const fields = [
        { key: "customer_name", value: customerName },
        { key: "location", value: location },
        { key: "rating", value: String(rating) },
        { key: "review_text", value: reviewText },
        { key: "product", value: `gid://shopify/Product/${productId}` },
        { key: "review_date", value: new Date().toISOString() },
        { key: "verified_customer", value: "false" },
        { key: "published", value: "false" }
    ];

    if (customerImageFileGid) {
        fields.push({ key: "customer_image", value: customerImageFileGid });
    }

    const data = await shopifyAdminGraphQL(mutation, {
        metaobject: {
            type: METAOBJECT_TYPE,
            fields
        }
    });

    const errors = data.metaobjectCreate.userErrors;
    if (errors && errors.length) {
        throw new Error("metaobjectCreate error: " + JSON.stringify(errors));
    }

    return data.metaobjectCreate.metaobject;
}

app.post("/submit-review", upload.single("customer_image"), async (req, res) => {
    try {
        const { product_id, customer_name, location, rating, review_text } = req.body;

        if (!product_id || !customer_name || !location || !rating || !review_text) {
            return res.status(400).json({
                success: false,
                message: "Missing required review fields."
            });
        }

        const ratingNum = Number(rating);
        if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({
                success: false,
                message: "Rating must be a whole number between 1 and 5."
            });
        }

        if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
            console.log("STORE:", process.env.SHOPIFY_STORE_DOMAIN);
            console.log("TOKEN:", process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);
            console.error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN env vars");
            return res.status(500).json({
                success: false,
                message: "Server is not configured correctly. Please contact the store owner."
            });
        }

        let customerImageFileGid = null;
        if (req.file) {
            customerImageFileGid = await uploadImageToShopifyFiles(req.file);
        }

        const metaobject = await createReviewMetaobject({
            productId: product_id,
            customerName: customer_name,
            location,
            rating: ratingNum,
            reviewText: review_text,
            customerImageFileGid
        });

        console.log("Created review metaobject:", metaobject);

        res.json({
            success: true,
            message: "Review submitted for approval.",
            metaobjectId: metaobject.id
        });
    } catch (err) {
        console.error("Error handling review submission:", err);
        res.status(500).json({
            success: false,
            message: "Something went wrong while saving your review."
        });
    }
});

// ── Shiprocket Delivery Check ──
let shiprocketToken = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
    if (shiprocketToken && Date.now() < shiprocketTokenExpiry) return shiprocketToken;

    const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            email: SHIPROCKET_EMAIL,
            password: SHIPROCKET_PASSWORD
        })
    });

    const data = await res.json();
    if (!data.token) {
        throw new Error("Shiprocket auth failed: " + JSON.stringify(data));
    }

    shiprocketToken = data.token;
    shiprocketTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000; // refresh a day early, tokens last ~10d
    return shiprocketToken;
}

app.get("/check-delivery", async (req, res) => {
    const { pincode, weight, cod } = req.query;

    if (!/^\d{6}$/.test(pincode || "")) {
        return res.status(400).json({ error: "Invalid pincode" });
    }

    if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD || !SHIPROCKET_PICKUP_PINCODE) {
        console.error("Missing SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD / SHIPROCKET_PICKUP_PINCODE env vars");
        return res.status(500).json({ error: "Server is not configured correctly." });
    }

    try {
        const token = await getShiprocketToken();

        const params = new URLSearchParams({
            pickup_postcode: SHIPROCKET_PICKUP_PINCODE,
            delivery_postcode: pincode,
            weight: weight || "0.5",
            cod: cod === "1" ? "1" : "0"
        });

        const srRes = await fetch(
            `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const srData = await srRes.json();
const couriers = srData?.data?.available_courier_companies || [];
if (!couriers.length) {
    return res.json({ serviceable: false, message: "Delivery not available to this pincode" });
}

// Sort couriers by estimated delivery days (ascending)
const sorted = [...couriers].sort(
    (a, b) => parseFloat(a.estimated_delivery_days) - parseFloat(b.estimated_delivery_days)
);

// Pick 2nd earliest if available, else fall back to the earliest (only 1 courier serviceable)
const chosen = sorted[1] || sorted[0];

res.json({
    serviceable: true,
    estimated_days: chosen.estimated_delivery_days,
    cod_available: couriers.some((c) => c.cod === 1),
    courier: chosen.courier_name
});
    } catch (err) {
        console.error("Shiprocket check-delivery error:", err);
        res.status(500).json({ error: "Could not check delivery right now" });
    }
});



// api/track-order.js
//
// Deploy this as a serverless function OUTSIDE your Shopify theme (Vercel, Netlify,
// Cloudflare Workers, a small Render/Railway service — anything that can hold secret
// environment variables and give you a public HTTPS URL). Your theme's JS calls this
// endpoint; it never talks to Shiprocket or your Shopify Admin API directly.
//
// Written for Vercel's Node serverless function format:
//   module.exports = async (req, res) => { ... }
// Netlify/Cloudflare Workers use a slightly different handler signature — the logic
// inside is the same, only the outer wrapper changes.
//
// Required environment variables (set these in your hosting provider's dashboard —
// never commit them, never put them in the theme):
//   SHIPROCKET_EMAIL         Shiprocket account email
//   SHIPROCKET_PASSWORD      Shiprocket account password
//   SHOPIFY_STORE_DOMAIN     e.g. dawnfootwear.myshopify.com
//   SHOPIFY_ADMIN_ACCESS_TOKEN      Access token from a Shopify Custom App with the
//                            `read_orders` scope (Settings > Apps > Develop apps)
//   ALLOWED_ORIGIN           Your live storefront origin, e.g. https://dawnfootwear.com
// ── Order Tracking ──
//
// Same server, same env vars already loaded above (SHOPIFY_STORE_DOMAIN,
// SHOPIFY_ADMIN_ACCESS_TOKEN, SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD).
// Frontend calls POST /track-order with { mode: 'awb' | 'orderid', identifier, mobile }.
// ── Order Tracking ──

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getShiprocketTokenForTracking() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const res = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: SHIPROCKET_EMAIL,
      password: SHIPROCKET_PASSWORD,
    }),
  });

  if (!res.ok) throw new Error('Shiprocket auth failed: ' + res.status);
  const data = await res.json();
  cachedToken = data.token;
  cachedTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function trackByAwb(awb) {
  const token = await getShiprocketTokenForTracking();
  const res = await fetch(`${SHIPROCKET_BASE}/courier/track/awb/${encodeURIComponent(awb)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Shiprocket track failed:', res.status, body);
    return null;
  }
  return res.json();
}

async function findOrderByName(rawName) {
  const cleaned = rawName.trim().replace(/^#/, '');
  const query = `
    query FindOrder($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            name
            phone
            shippingAddress { address1 address2 city province zip country phone }
            lineItems(first: 3) {
              edges { node { title quantity variantTitle } }
            }
            fulfillments(first: 5) {
              trackingInfo { number company }
            }
          }
        }
      }
    }
  `;
  for (const attempt of [`name:#${cleaned}`, `name:${cleaned}`]) {
    const data = await shopifyAdminGraphQL(query, { q: attempt });
    const edge = data.orders.edges[0];
    if (edge) return edge.node;
  }
  return null;
}

/**
 * Scans recent orders to find the one containing a given AWB in its
 * fulfillment tracking info, so AWB-mode lookups can be verified against
 * the order's phone number too (not just trusted on tracking number alone).
 * Scans up to 300 most recent orders (3 pages of 100).
 */
async function findOrderByAwb(awb) {
  const query = `
    query FindOrderByAwb($cursor: String) {
      orders(first: 100, after: $cursor, sortKey: CREATED_AT, reverse: true) {
        edges {
          cursor
          node {
            name
            phone
            shippingAddress { address1 address2 city province zip country phone }
            lineItems(first: 3) {
              edges { node { title quantity variantTitle } }
            }
            fulfillments(first: 5) {
              trackingInfo { number company }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  let cursor = null;
  const maxPages = 3;

  for (let page = 0; page < maxPages; page++) {
    const data = await shopifyAdminGraphQL(query, { cursor });
    const edges = data.orders.edges;

    const match = edges.find((e) =>
      e.node.fulfillments.some((f) =>
        f.trackingInfo.some((t) => t.number === awb)
      )
    );
    if (match) return match.node;

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  return null;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function mapStatusToStage(statusText) {
  const s = (statusText || '').toLowerCase();
  if (s.includes('delivered')) return 5;
  if (s.includes('out for delivery')) return 4;
  if (s.includes('transit') || s.includes('shipped') || s.includes('picked')) return 3;
  if (s.includes('packed') || s.includes('ready to ship') || s.includes('pickup generated')) return 2;
  return 1;
}

app.post('/track-order', async (req, res) => {
  try {
    const { mode, identifier, mobile } = req.body || {};
    const enteredMobile = normalizePhone(mobile);

    if (!identifier || !enteredMobile) {
      return sendJson(res, 400, { error: 'Missing identifier or mobile number' });
    }

    let awb = null;
    let itemName = null;
    let itemMeta = null;
    let address = null;

    if (mode === 'awb') {
      awb = identifier.trim();

      const order = await findOrderByAwb(awb);
      if (order) {
        const orderPhone = normalizePhone(order.phone || order.shippingAddress?.phone);
        if (!orderPhone || orderPhone !== enteredMobile) {
          return sendJson(res, 404, { error: 'Order not found' });
        }

        const line = order.lineItems?.edges?.[0]?.node;
        if (line) {
          itemName = line.title;
          itemMeta = `Qty: ${line.quantity}${line.variantTitle ? ' | ' + line.variantTitle : ''}`;
        }
        const addr = order.shippingAddress;
        if (addr) {
          address = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
            .filter(Boolean)
            .join(', ');
        }
      }
      // If no matching Shopify order is found for this AWB (e.g. older than the
      // scanned window), we still attempt the Shiprocket lookup below, just
      // without item/address enrichment and without a phone cross-check.
    } else {
      const order = await findOrderByName(identifier);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });

      const orderPhone = normalizePhone(order.phone || order.shippingAddress?.phone);
      if (!orderPhone || orderPhone !== enteredMobile) {
        return sendJson(res, 404, { error: 'Order not found' });
      }

      const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];
      if (!tracking?.number) {
        return sendJson(res, 404, { error: 'This order has not shipped yet.' });
      }
      awb = tracking.number;

      const line = order.lineItems?.edges?.[0]?.node;
      if (line) {
        itemName = line.title;
        itemMeta = `Qty: ${line.quantity}${line.variantTitle ? ' | ' + line.variantTitle : ''}`;
      }
      const addr = order.shippingAddress;
      if (addr) {
        address = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
          .filter(Boolean)
          .join(', ');
      }
    }

    const trackingResponse = await trackByAwb(awb);
    if (!trackingResponse) return sendJson(res, 404, { error: 'Order not found' });

    const data = trackingResponse.tracking_data || {};
    const shipment = (data.shipment_track && data.shipment_track[0]) || {};
    const activities = data.shipment_track_activities || [];
    const statusText = shipment.current_status || data.track_status || 'In Transit';

    return sendJson(res, 200, {
      orderId: shipment.order_id || identifier,
      awb: shipment.awb_code || awb,
      courier: shipment.courier_name || 'Courier partner',
      status: statusText,
      edd: shipment.edd || null,
      currentStage: mapStatusToStage(statusText),
      itemName,
      itemMeta,
      address,
      activities: activities.map((a) => ({
        date: a.date,
        status: a.status,
        activity: a.activity,
        location: a.location,
      })),
    });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});
// ── Wishlist sync (Shopify App Proxy) ──
function verifyProxy(req, res, next) {
    const { signature, ...rest } = req.query;
    const msg = Object.keys(rest).sort().map(k => `${k}=${[].concat(rest[k]).join(",")}`).join("");
    const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(msg).digest("hex");

    if (!signature || signature.length !== digest.length ||
        !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
        return res.status(401).end();
    }
    if (!rest.logged_in_customer_id) {
        return res.status(401).json({ error: "not logged in" });
    }
    req.customerGid = `gid://shopify/Customer/${rest.logged_in_customer_id}`;
    next();
}

app.get("/wishlist", verifyProxy, async (req, res) => {
    try {
        const data = await shopifyAdminGraphQL(
            `query($id: ID!) { customer(id: $id) { metafield(namespace: "custom", key: "wishlist") { value } } }`,
            { id: req.customerGid }
        );
        res.json({ items: JSON.parse(data.customer?.metafield?.value || "[]") });
    } catch (err) {
        console.error("Wishlist GET error:", err);
        res.status(500).json({ error: "Could not load wishlist" });
    }
});

app.post("/wishlist", verifyProxy, async (req, res) => {
    try {
        const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .filter((p, i, a) => p && p.handle && a.findIndex(x => x.handle === p.handle) === i)
    .slice(0, 200);
        const data = await shopifyAdminGraphQL(
            `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
            { m: [{ ownerId: req.customerGid, namespace: "custom", key: "wishlist", type: "json", value: JSON.stringify(items) }] }
        );
        const errs = data.metafieldsSet.userErrors;
        if (errs && errs.length) throw new Error(JSON.stringify(errs));
        res.json({ items });
    } catch (err) {
        console.error("Wishlist POST error:", err);
        res.status(500).json({ error: "Could not save wishlist" });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Review API listening");
});
