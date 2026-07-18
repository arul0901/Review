require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer"); // npm install multer — parses multipart/form-data (FormData + file upload)

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const {
    SHOPIFY_STORE_DOMAIN,      // e.g. "your-store.myshopify.com"
    SHOPIFY_ADMIN_ACCESS_TOKEN, // from your custom app's Admin API access token
    SHOPIFY_API_VERSION        // e.g. "2025-01"
} = process.env;

const API_VERSION = SHOPIFY_API_VERSION || "2025-01";
const ADMIN_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// The metaobject "type" handle as defined in Shopify Admin > Content > Metaobjects.
// Must match exactly what your storefront section reads from
// (shop.metaobjects.customer_reviews.values).
const METAOBJECT_TYPE = "customer_reviews";

app.use(cors());
app.use(express.json());

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

app.listen(process.env.PORT || 3000, () => {
    console.log("Review API listening");
});
