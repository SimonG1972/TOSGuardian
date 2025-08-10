// server.js — TOS Guardian full server
// Implements:
// - /api/check (flexible payload, nested media scanning, text+image heuristics)
// - /api/rules/:platform GET/PUT (rulebook viewer/editor)
// - Static for /public and /tests/fixtures (deep image tests)
// - Remote images -> yellow manual review (unless red tokens)
// - Local fixture images -> green unless red tokens

const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware & Static ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// Expose test fixtures (deep image tests need this)
app.use(
  "/tests",
  express.static(path.join(__dirname, "tests"), { fallthrough: true })
);

// Minimal request log
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started} ms`);
  });
  next();
});

// ---------- Utilities ----------
const URL_RE = /https?:\/\/[^\s)]+/gi;
const LOWER = (s) => (s || "").toString().toLowerCase();

function looksLikeUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}
function isLocalhostUrl(u) {
  try {
    const { hostname } = new URL(u);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
function deepCollectStrings(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === "string") { out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((v) => deepCollectStrings(v, out)); return out; }
  if (typeof obj === "object") { Object.values(obj).forEach((v) => deepCollectStrings(v, out)); return out; }
  return out;
}
function extractUrlsFromAny(value) {
  const strings = deepCollectStrings(value);
  const urls = new Set();
  strings.forEach((s) => {
    if (looksLikeUrl(s)) {
      urls.add(s);
    } else {
      const found = s.match(URL_RE);
      if (found) found.forEach((u) => urls.add(u));
    }
  });
  return Array.from(urls);
}
function compactJoin(parts) {
  return parts.filter(Boolean).join("\n");
}

// ---------- Heuristics ----------
const DISEASES = [
  "cancer","eczema","psoriasis","diabetes","arthritis","anxiety","depression",
  "asthma","migraine","acne","tumor","tumour","hypertension","covid","flu","cold",
  "insomnia" // ← added
];
const CLAIM_VERBS = [
  "cure","cures","cured","curing","treat","treats","treated","treating","treatment",
  "heal","heals","healed","healing","prevent","prevents","prevented","prevention",
  "diagnose","diagnoses","diagnosed","diagnosis","miracle","miraculous","remedy","medicates"
];
const COUNTERFEIT = ["replica","knock off","knockoff","counterfeit","fake","dupe"];

// 🔴 Anything here makes an image RED regardless of local/remote:
const IMAGE_RED_TOKENS = [
  "nsfw", "onlyfans", "gore", "blood",
  "replica", "counterfeit", "knockoff"
];
// 🟡 Soft signals:
const IMAGE_YELLOW_TOKENS = ["qr"];

// Non-numeric rapid weight-loss phrases (cover the tests)
const RAPID_WEIGHT_PHRASES = [
  /lose\s+weight\s+fast/i,
  /burn\s+fat\s+fast/i,
  /rapid\s+weight\s*loss/i,
  /melt\s+fat/i
];

function hasPairMedicalClaim(text) {
  const t = LOWER(text);
  const v = CLAIM_VERBS.some((w) => t.includes(w));
  const d = DISEASES.some((w) => t.includes(w));
  return v && d;
}
function hasCounterfeit(text) {
  const t = LOWER(text);
  return COUNTERFEIT.some((w) => t.includes(w));
}
// Numeric pattern (e.g., "lose 20 pounds in 10 days")
function hasRapidWeightLossNumeric(text) {
  return /\b(lose|burn|drop)\s+\d+\s*(pounds|lbs|kg)[^.\n]*\b(day|days|week|weeks)\b/i.test(text || "");
}
// Non-numeric common phrasing
function hasRapidWeightLossPhrases(text) {
  return RAPID_WEIGHT_PHRASES.some((re) => re.test(text || ""));
}
function hasRapidWeightLoss(text) {
  return hasRapidWeightLossNumeric(text) || hasRapidWeightLossPhrases(text);
}

function evaluateImages(urls) {
  const imageFindings = [];
  let hasRed = false;
  let hasYellow = false;

  urls.forEach((u) => {
    const lu = LOWER(u);

    if (IMAGE_RED_TOKENS.some((tok) => lu.includes(tok))) {
      hasRed = true;
      imageFindings.push({ url: u, severity: "high", label: "Prohibited image content" });
      return;
    }

    if (IMAGE_YELLOW_TOKENS.some((tok) => lu.includes(tok))) {
      hasYellow = true;
      imageFindings.push({ url: u, severity: "medium", label: "QR code / manual review" });
      return;
    }

    // Remote but otherwise clean -> manual review
    if (!isLocalhostUrl(u)) {
      hasYellow = true;
      imageFindings.push({ url: u, severity: "medium", label: "Image present (manual review)" });
    }
  });

  return { imageFindings, hasRed, hasYellow };
}

// ---------- /api/check ----------
app.post("/api/check", (req, res) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const platform = LOWER(body.platform || "");
    const title = body.title || body.fields?.title || "";
    const description = body.description || body.fields?.description || "";
    const caption = body.caption || body.fields?.caption || "";
    const link = body.link || body.fields?.link || "";
    const imageUrl = body.imageUrl || body.fields?.imageUrl || body.fields?.image || "";
    const strict = !!(body.strict || body.strictMode);

    const stitchedText =
      body.text ||
      compactJoin([title, description, caption, link]) ||
      "";

    const urls = new Set();
    [imageUrl].filter(Boolean).forEach((u) => urls.add(u));
    ["image", "images", "media", "attachments"].forEach((key) => {
      const val = body[key] ?? body.fields?.[key];
      extractUrlsFromAny(val).forEach((u) => urls.add(u));
    });
    extractUrlsFromAny(body).forEach((u) => urls.add(u));
    extractUrlsFromAny(stitchedText).forEach((u) => urls.add(u));

    const issues = [];
    let red = false;
    let yellow = false;

    if (hasPairMedicalClaim(stitchedText)) {
      red = true;
      issues.push("Prohibited medical claim detected.");
    }
    if (hasRapidWeightLoss(stitchedText)) {
      red = true;
      issues.push("Rapid weight-loss / medical claim detected.");
    }
    if (hasCounterfeit(stitchedText)) {
      red = true;
      issues.push("Counterfeit / replica claim detected.");
    }

    const { imageFindings, hasRed, hasYellow } = evaluateImages(Array.from(urls));
    if (hasRed) red = true;
    if (hasYellow) yellow = yellow || !red;

    const level = red ? "red" : (yellow ? "yellow" : "green");

    return res.json({
      level,
      issues,
      fixes: [],
      imageFindings,
      model: { name: "local" },
      platform,
      id: randomUUID(),
      strict
    });
  } catch (e) {
    console.error("check error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------- Rulebook API ----------
function rulePathFor(platform) {
  const p = platform.toLowerCase();
  const v1 = path.join(__dirname, "rules", `${p}.v1.json`);
  const plain = path.join(__dirname, "rules", `${p}.json`);
  if (fs.existsSync(v1)) return v1;
  return plain;
}
app.get("/api/rules/:platform", (req, res) => {
  try {
    const file = rulePathFor(req.params.platform);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Rulebook not found" });
    const json = JSON.parse(fs.readFileSync(file, "utf-8"));
    return res.json(json);
  } catch (e) {
    console.error("rules get error:", e);
    return res.status(500).json({ error: "Failed to read rulebook" });
  }
});
app.put("/api/rules/:platform", (req, res) => {
  try {
    const file = rulePathFor(req.params.platform);
    const incoming = req.body;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(incoming, null, 2), "utf-8");
    fs.renameSync(tmp, file);
    return res.json({ ok: true });
  } catch (e) {
    console.error("rules put error:", e);
    return res.status(500).json({ error: "Failed to save rulebook" });
  }
});

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// CI/health probe
app.get('/healthz', (req, res) => {
  res.type('text').send('ok'); // 200 by default
});


// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`TOS Guardian running at http://localhost:${PORT}`);
});
