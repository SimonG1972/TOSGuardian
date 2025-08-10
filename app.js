// app.js — platform-aware form + call real /api/check (with toggles) and render result
const $ = (s, r = document) => r.querySelector(s);

/* =========================
   Platform Schemas
========================= */
const PLATFORM_SCHEMAS = {
  etsy: {
    name: "Etsy",
    fields: [
      { key: "title", label: "Product Title", type: "text", max: 140, required: true, help: "Max 140 chars." },
      { key: "description", label: "Description", type: "textarea", max: 10000, required: true },
      { key: "tags", label: "Tags", type: "text", help: "Up to 13, comma-separated." },
      { key: "price", label: "Price", type: "number", step: "0.01" },
      { key: "image", label: "Primary Image", type: "file", accept: "image/*" }
    ]
  },

  pinterest: {
    name: "Pinterest",
    fields: [
      { key: "title", label: "Pin Title", type: "text", max: 100, required: true },
      { key: "description", label: "Pin Description", type: "textarea", max: 500, required: true },
      { key: "link", label: "Destination URL", type: "url", required: true },
      { key: "board", label: "Board (optional)", type: "text" },
      { key: "image", label: "Pin Image", type: "file", accept: "image/*", required: true }
    ]
  },

  shopify: {
    name: "Shopify",
    fields: [
      { key: "title", label: "Product Title", type: "text", max: 255, required: true },
      { key: "description", label: "Description", type: "textarea", max: 16000, required: true },
      { key: "sku", label: "SKU (optional)", type: "text" },
      { key: "price", label: "Price", type: "number", step: "0.01", required: true },
      { key: "image", label: "Primary Image", type: "file", accept: "image/*" }
    ]
  },

  youtube: {
    name: "YouTube",
    fields: [
      { key: "title", label: "Video Title", type: "text", max: 100, required: true },
      { key: "description", label: "Description", type: "textarea", max: 5000, required: true },
      { key: "tags", label: "Tags (optional)", type: "text", help: "Comma-separated." },
      { key: "thumb", label: "Thumbnail", type: "file", accept: "image/*" },
      { key: "link", label: "Video URL (optional)", type: "url" }
    ]
  },

  tiktok: {
    name: "TikTok",
    fields: [
      { key: "title", label: "Video Title (idea)", type: "text", max: 100, required: false },
      { key: "caption", label: "Caption", type: "textarea", max: 2200, required: true },
      { key: "hashtags", label: "Hashtags (space or comma-separated)", type: "text", help: "Up to 30 total." },
      { key: "link", label: "Link (optional)", type: "url" },
      { key: "thumb", label: "Cover Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  amazon: {
    name: "Amazon",
    fields: [
      { key: "title", label: "Product Title", type: "text", max: 200, required: true },
      { key: "description", label: "Description", type: "textarea", max: 2000, required: true },
      { key: "bullets", label: "Bullet Points (one per line)", type: "textarea", max: 1000, required: false },
      { key: "search_terms", label: "Search Terms (hidden keywords)", type: "text", max: 250, required: false },
      { key: "price", label: "Price", type: "number", step: "0.01" }
    ]
  },

  instagram: {
    name: "Instagram",
    fields: [
      { key: "caption", label: "Caption", type: "textarea", max: 2200, required: true },
      { key: "hashtags", label: "Hashtags (space or comma-separated)", type: "text", help: "Up to 30 total." },
      { key: "link", label: "Link (optional)", type: "url" },
      { key: "thumb", label: "Cover Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  facebook: {
    name: "Facebook",
    fields: [
      { key: "caption", label: "Post Text", type: "textarea", max: 2000, required: true },
      { key: "hashtags", label: "Hashtags (optional)", type: "text" },
      { key: "link", label: "Link (optional)", type: "url" },
      { key: "thumb", label: "Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  x: {
    name: "X",
    fields: [
      { key: "caption", label: "Post", type: "textarea", max: 280, required: true },
      { key: "hashtags", label: "Hashtags (optional)", type: "text" },
      { key: "link", label: "Link (optional)", type: "url" },
      { key: "thumb", label: "Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  linkedin: {
    name: "LinkedIn",
    fields: [
      { key: "caption", label: "Post Text", type: "textarea", max: 3000, required: true },
      { key: "link", label: "Link (optional)", type: "url" },
      { key: "thumb", label: "Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  reddit: {
    name: "Reddit",
    fields: [
      { key: "title", label: "Post Title", type: "text", max: 300, required: true },
      { key: "description", label: "Body (optional)", type: "textarea", max: 40000 },
      { key: "link", label: "URL (for link post)", type: "url" },
      { key: "thumb", label: "Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  snapchat: {
    name: "Snapchat",
    fields: [
      { key: "caption", label: "Caption", type: "textarea", max: 250, required: true },
      { key: "hashtags", label: "Hashtags (optional)", type: "text" },
      { key: "link", label: "Link (optional, if enabled)", type: "url" },
      { key: "thumb", label: "Snap Image (optional)", type: "file", accept: "image/*" }
    ]
  },

  ebay: {
    name: "eBay",
    fields: [
      { key: "title", label: "Listing Title", type: "text", max: 80, required: true },
      { key: "description", label: "Description", type: "textarea", max: 50000, required: true },
      { key: "price", label: "Price", type: "number", step: "0.01" },
      { key: "image", label: "Primary Image", type: "file", accept: "image/*" }
    ]
  }
};

/* =========================
   Dynamic Form Rendering
========================= */
const mount = $("#formMount");
const select = $("#platformSelect");
select.addEventListener("change", () => renderForm(select.value));
renderForm(select.value);

function renderForm(platform) {
  const schema = PLATFORM_SCHEMAS[platform];
  if (!schema) {
    mount.innerHTML = `<div class="hint">Unknown platform.</div>`;
    return;
  }
  mount.innerHTML = `
    <h3>${schema.name} — Smart Pre-Flight</h3>
    <div class="hint">Only the fields that matter for ${schema.name} appear here.</div>
    <form id="dynForm" novalidate></form>
  `;
  const form = $("#dynForm", mount);

  schema.fields.forEach(f => {
    const id = `f_${f.key}`;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <label for="${id}" class="lbl">${f.label}${f.required ? " *" : ""}</label>
      <div class="fld">
        ${renderInput(f, id)}
        ${f.max && f.type !== "file" ? `<div class="counter" data-for="${id}">0 / ${f.max}</div>` : ""}
        ${f.help ? `<div class="help">${f.help}</div>` : ""}
      </div>
    `;
    form.appendChild(row);

    if (f.max && f.type !== "file") {
      const el = row.querySelector(`#${id}`);
      const counter = row.querySelector(`.counter[data-for="${id}"]`);
      const update = () => {
        const val = el.value || "";
        counter.textContent = `${val.length} / ${f.max}`;
        el.classList.toggle("bad", val.length > f.max);
      };
      el.addEventListener("input", update);
      update();
    }
  });
}

function renderInput(f, id) {
  const attrs = [
    `id="${id}"`,
    f.required ? "required" : "",
    f.max && f.type !== "number" ? `maxlength="${f.max}"` : "",
    f.step ? `step="${f.step}"` : "",
    f.accept ? `accept="${f.accept}"` : ""
  ].filter(Boolean).join(" ");
  if (f.type === "textarea") return `<textarea ${attrs}></textarea>`;
  if (f.type === "file") return `<input type="file" ${attrs} />`;
  return `<input type="${f.type}" ${attrs} />`;
}

/* =========================
   Toggles + Model Chip Helpers
========================= */
function getToggles() {
  const strictModeEl = $("#strictModeToggle");
  const saveReceiptsEl = $("#saveReceiptsToggle");
  return {
    strictMode: !!(strictModeEl && strictModeEl.checked),
    saveReceipts: !!(saveReceiptsEl && saveReceiptsEl.checked)
  };
}

function setModelChip(name) {
  const chip = $("#modelChip");
  const label = $("#modelName");
  if (name) {
    if (label) label.textContent = name;
    if (chip) chip.style.display = "inline-flex";
  } else {
    if (chip) chip.style.display = "none";
  }
}

/* =========================
   API Call + Rendering
========================= */
$("#btnCheck").addEventListener("click", async () => {
  const platform = select.value;
  const schema = PLATFORM_SCHEMAS[platform];
  const fields = {};
  let valid = true;

  schema.fields.forEach(f => {
    const el = document.querySelector(`#f_${f.key}`);
    if (!el) return;

    if (f.type === "file") {
      fields[f.key] = el.files && el.files[0] ? el.files[0].name : "";
    } else {
      const v = (el.value || "").trim();
      fields[f.key] = v;

      if (f.required && !v) {
        el.classList.add("bad");
        valid = false;
      } else {
        el.classList.remove("bad");
      }
      if (f.max && v.length > f.max) valid = false;
    }
  });

  if (!valid) {
    showResult({ level: "yellow", issues: ["Please fill required fields and fix length limits."], fixes: [] });
    return;
  }

  const toggles = getToggles();

  try {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, fields, ...toggles })
    });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    const data = await r.json();
    showResult(data);
  } catch (err) {
    console.error(err);
    showResult({ level: "red", issues: ["Could not reach local API. Is the server running?"], fixes: [] });
  }
});

$("#btnReset").addEventListener("click", () => {
  renderForm(select.value);
  $("#results").hidden = true;
  setModelChip(null);
  const modelBlock = $("#modelBlock");
  if (modelBlock) modelBlock.hidden = true;
});

/* =========================
   Results UI
========================= */
function showResult(resObj) {
  const { level = "green", issues = [], fixes = [], model = null } = resObj || {};
  const res = $("#results");
  res.hidden = false;

  const tl = $("#trafficLight");
  tl.className = "traffic " + (
    level === "green" ? "traffic-green" :
    level === "yellow" ? "traffic-yellow" : "traffic-red"
  );
  tl.textContent =
    level === "green" ? "GREEN — Looks good" :
    level === "yellow" ? "CHECK — Review suggested fixes" :
    "STOP — High risk";

  $("#issues").innerHTML =
    (issues || []).map(i => `<div class="issue">• ${escapeHtml(i)}</div>`).join("") ||
    `<div class="issue muted">No issues.</div>`;

  const fixesBox = $("#fixes");
  const fixesBody = $("#fixesBody");
  if (fixes && fixes.length) {
    fixesBox.hidden = false;
    fixesBody.innerHTML = fixes.map(f =>
      `<div class="fix">
         <div><strong>${escapeHtml(f.field || "field")}</strong></div>
         <div>${escapeHtml(f.suggestion || "")}</div>
       </div>`
    ).join("");

    $("#applyFixes").onclick = () => {
      fixes.forEach(f => {
        const el = document.querySelector(`#f_${f.field}`);
        if (!el) return;
        if (el.tagName === "TEXTAREA" || el.type === "text" || el.type === "url" || el.type === "number") {
          el.value = f.suggestion || "";
          el.dispatchEvent(new Event("input"));
        }
      });
      fixesBox.hidden = true;
    };
  } else {
    fixesBox.hidden = true;
    fixesBody.innerHTML = "";
  }

  if (model && (model.name || model.rewrite)) {
    setModelChip(model.name || "Local Model");
    const block = $("#modelBlock");
    const rewriteEl = $("#modelRewrite");
    if (block && rewriteEl) {
      block.hidden = false;
      rewriteEl.textContent = model.rewrite ? model.rewrite : "—";
    }
  } else {
    setModelChip(null);
    const block = $("#modelBlock");
    if (block) block.hidden = true;
    const rewriteEl = $("#modelRewrite");
    if (rewriteEl) rewriteEl.textContent = "—";
  }
}

function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
