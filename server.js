// server.js — multi-platform rule engine with patterns_ref, fuzzy+proximity medical detection,
// tone-preserving rewrites, local receipts, optional local LLM assist (Ollama),
// and starter Image checks (URL extraction + lightweight heuristics).
// Platforms supported: etsy, pinterest, shopify, youtube, tiktok, amazon, instagram, facebook, x, linkedin, reddit, snapchat, ebay

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/* -------------------- Optional fetch polyfill -------------------- */
let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  try { _fetch = require('node-fetch'); } catch { _fetch = null; }
}

/* -------------------- FS utils -------------------- */
function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function saveReceipt(platform, payload) {
  const dir = path.join(__dirname, 'data', 'receipts');
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `receipt-${platform}-${ts}.json`), JSON.stringify(payload, null, 2));
}
function loadRulebook(platform) {
  return readJSON(path.join(__dirname, 'rules', `${platform}.v1.json`));
}
function loadShared(name) {
  // name like "shared.medical.json" or "shared.global.json"
  return readJSON(path.join(__dirname, 'rules', name));
}

/* -------------------- string & style helpers -------------------- */
const normWS = s => String(s || '').replace(/\s+/g, ' ').trim();
function detectStyle(text='') {
  const t = text || '';
  const exclam = Math.min((t.match(/!/g) || []).length, 2);
  const words = t.trim().split(/\s+/).filter(Boolean);
  const isLower = t === t.toLowerCase();
  const titleish = words.length > 2 && words.filter(w => /^[A-Z]/.test(w)).length >= Math.floor(words.length * 0.6);
  const casing = isLower ? 'lower' : titleish ? 'title' : 'sentence';
  const usedModal = /\b(may|might|could|can)\b/i.test(t);
  return { exclam, casing, usedModal };
}
function applyStyle(text, style) {
  let out = text;
  if (style.casing === 'lower') out = out.toLowerCase();
  else if (style.casing === 'title') out = out.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  else out = out.charAt(0).toUpperCase() + out.slice(1);
  if (style.exclam > 0) out = out.replace(/\.*$/,'') + '!'.repeat(style.exclam);
  else out = out.replace(/[!]+$/,'');
  return out;
}
function escapeRegex(s='') { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* -------------------- Damerau-Levenshtein (edit distance) -------------------- */
function editDistance(a='', b='') {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
      if (i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2]+1);
      }
    }
  }
  return dp[m][n];
}

/* -------------------- tokens & proximity -------------------- */
function tokenize(text='') { return String(text).split(/[^a-z0-9]+/i).filter(Boolean); }
function fuzzyMatchAny(token, list, maxEd=1) { return list.some(term => editDistance(token, term) <= maxEd); }
function verbNearNoun(text, verbs, nouns, windowSize=6) {
  const toks = tokenize(text);
  const verbIdx = [], nounIdx = [];
  toks.forEach((t,i) => {
    if (fuzzyMatchAny(t, verbs, 1)) verbIdx.push(i);
    if (fuzzyMatchAny(t, nouns, 1)) nounIdx.push(i);
  });
  for (const iv of verbIdx) for (const inx of nounIdx) {
    if (Math.abs(iv - inx) <= windowSize) return true;
  }
  return false;
}

/* -------------------- patterns_ref resolver -------------------- */
function resolvePatternsRef(ref) {
  if (!ref) return [];
  const [file, section] = ref.split('#');
  const data = loadShared(file);
  if (!data) return [];
  if (!section) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.phrases)) return data.phrases;
    return Object.values(data).find(v => Array.isArray(v)) || [];
  } else {
    const val = data[section];
    return Array.isArray(val) ? val : [];
  }
}

/* -------------------- medical rewrite -------------------- */
function rewriteMedical(text, shared, rb) {
  const style = detectStyle(text || '');
  const verbs = shared?.claim_verbs || [];
  const diseases = shared?.diseases || [];
  const neutralNoun = (rb?.rewrite?.neutral_noun) || 'overall wellness';
  const neutralVerb = 'supports';

  let s = normWS(text || '');

  // soften verbs (typo-tolerant)
  const tokens = s.split(/(\W+)/);
  for (let i=0;i<tokens.length;i++) {
    if (/^[a-z0-9]+$/i.test(tokens[i]) && fuzzyMatchAny(tokens[i], verbs, 1)) {
      const isPlural = /s$/i.test(tokens[i]);
      tokens[i] = isPlural ? 'supports' : neutralVerb;
    }
  }
  s = tokens.join('');

  // neutralize diseases
  const tokens2 = s.split(/(\W+)/);
  for (let i=0;i<tokens2.length;i++) {
    if (/^[a-z0-9]+$/i.test(tokens2[i]) && fuzzyMatchAny(tokens2[i], diseases, 1)) {
      tokens2[i] = neutralNoun;
    }
  }
  s = tokens2.join('');

  // tidy awkward constructions
  s = s.replace(/\b(help|helps)\s+supports\b/ig, 'supports')
       .replace(/\bsupports\s+supports\b/ig, 'supports')
       .replace(/\bmay\s+supports\b/ig, 'may support')
       .replace(/\bmight\s+supports\b/ig, 'might support');

  if (!style.usedModal) s = s.replace(/\bsupports\b/ig, 'designed to support');
  if (s.length < 15) s = 'Designed to support everyday self-care and overall wellness';

  return applyStyle(s, style);
}

/* -------------------- per-platform checker using rulebook -------------------- */
function buildSearchText(fields) {
  return Object.values(fields).filter(v => typeof v === 'string').join(' ');
}
function primaryTextField(fields) {
  if (typeof fields.description === 'string') return 'description';
  if (typeof fields.caption === 'string') return 'caption';
  if (typeof fields.title === 'string') return 'title';
  return null;
}

/* -------------------- Image helpers (Step 3) -------------------- */
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)(\?.*)?$/i;


function extractImageUrls(fields) {
  const urls = new Set();
  const seen = new WeakSet();

  const KEY_HINTS = new Set([
    'image','image_url','imageurl','imageURL','imageUrl',
    'thumbnail','thumb','cover','banner','photo','picture','pic',
    'images','photos','media','media_url','mediaUrl','mediaURLs','mediaUrls'
  ]);

  const URL_LIKE = /https?:\/\/[^\s"'()<>]+/ig;

  function collect(val, keyHint = '') {
    if (!val) return;

    // Strings: add direct URLs and any URLs found inside the string
    if (typeof val === 'string') {
      // If it looks like a direct URL, add it (even without extension for hinted keys)
      const looksLikeUrl = /^https?:\/\//i.test(val);
      if (looksLikeUrl) {
        if (IMG_EXT.test(val) || KEY_HINTS.has(keyHint.toLowerCase())) {
          urls.add(val);
        }
      }
      // Also scan for any URLs embedded in the string
      const matches = val.match(URL_LIKE) || [];
      for (const u of matches) {
        if (IMG_EXT.test(u)) urls.add(u);
      }
      return;
    }

    // Arrays: recurse into each element
    if (Array.isArray(val)) {
      for (const item of val) collect(item, keyHint);
      return;
    }

    // Objects: avoid cycles, then recurse into values
    if (typeof val === 'object') {
      if (seen.has(val)) return;
      seen.add(val);

      // Common object shapes like { url, src, href }
      const candidate = val.url || val.src || val.href;
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        if (IMG_EXT.test(candidate) || KEY_HINTS.has(String(keyHint).toLowerCase())) {
          urls.add(candidate);
        }
      }

      for (const [k, v] of Object.entries(val)) {
        collect(v, k);
      }
      return;
    }
  }

  collect(fields, '');

  return Array.from(urls);
}

async function downloadImage(url) {
  if (!_fetch) throw new Error('fetch unavailable');
  const dir = path.join(__dirname, 'data', 'images', 'tmp');
  ensureDir(dir);
  const ts = Date.now();
  const safeName = url.replace(/[^a-z0-9]+/ig, '_').slice(0,120);
  const fp = path.join(dir, `${ts}_${safeName}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('img_timeout')), 5000);
  try {
    const res = await _fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(fp, buf);
    const ct = (res.headers && (res.headers.get?.('content-type') || res.headers['content-type'])) || '';
    return { path: fp, size: buf.length, contentType: String(ct) };
  } finally {
    clearTimeout(timer);
  }
}

function cleanupFiles(fileInfos) {
  for (const f of fileInfos) {
    try { if (f && f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
  }
}

/* Lightweight heuristics only (no ML yet) */
function detectImageIssues(url, fileInfo) {
  const issues = [];
  const pathish = `${url} ${fileInfo?.path || ''}`.toLowerCase();

  // Simple boundary-aware search (no lookbehind). We search for the token and
  // confirm the char before/after (if any) aren't [a-z0-9].
  function hasToken(token) {
    let idx = -1;
    while ((idx = pathish.indexOf(token, idx + 1)) !== -1) {
      const pre = idx > 0 ? pathish[idx - 1] : '';
      const post = idx + token.length < pathish.length ? pathish[idx + token.length] : '';
      const preOk = !/[a-z0-9]/i.test(pre);
      const postOk = !/[a-z0-9]/i.test(post);
      if (preOk && postOk) return true;
    }
    return false;
  }
  // RegExp helper for patterns with special chars (like 'super-copy', 'scan_me', '1-1', '1:1')
  function hasPattern(re) { return re.test(pathish); }

  // NSFW / adult hints (high)
  if (hasToken('nsfw') || hasToken('onlyfans') || hasToken('porn') || hasToken('xxx') ||
      hasToken('explicit') || hasToken('adult')) {
    issues.push({ severity: 'high', label: 'NSFW / Adult content (image hint)' });
  }

  // Violence / gore (high)
  if (hasToken('gore') || hasToken('blood') || hasToken('beheading') ||
      hasToken('decap') || hasToken('dismember')) {
    issues.push({ severity: 'high', label: 'Graphic violence (image hint)' });
  }

  // Counterfeit hint (medium) — support 'replica', 'super-copy/super_copy', and '1:1' or '1-1'
  if (hasToken('replica') || hasPattern(/super[-_]?copy/i) || hasPattern(/1[:\-_]1/i)) {
    issues.push({ severity: 'medium', label: 'Counterfeit / Replica (image hint)' });
  }

  // QR/code-scan bait (medium)
  if (hasToken('qrcode') || hasPattern(/\bscan[-_]?me\b/i) || hasToken('qr')) {
    issues.push({ severity: 'medium', label: 'QR / Scan code solicitation (image hint)' });
  }

  // Suspicious file type masquerading (high)
  const ct = (fileInfo?.contentType || '').toLowerCase();
  if (ct && !/^image\//.test(ct) && IMG_EXT.test(url)) {
    issues.push({ severity: 'high', label: 'Content-Type mismatch on image download' });
  }

  return issues;
}

async function scanImagesFromFields(fields, { enable = true } = {}) {
  if (!enable) return { issues: [], files: [] };
  const urls = extractImageUrls(fields);
  if (urls.length === 0) return { issues: [], files: [] };

  const downloaded = [];
  const found = [];

  // DEBUG (safe): show what we found so we can diagnose if needed
  console.log('IMG_SCAN urls:', urls);

  for (const url of urls) {
    // Always run URL-based heuristics first (no network needed)
    try {
      const urlOnlyHits = detectImageIssues(url, null);
      urlOnlyHits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch {}

    // Then attempt to download for extra checks
    try {
      const info = await downloadImage(url);
      downloaded.push(info);
      const hits = detectImageIssues(url, info);
      hits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch (e) {
      if (IMG_EXT.test(url)) {
        found.push({ url, severity: 'medium', label: 'Image fetch failed (non-blocking)' });
      }
    }
  }

  // Cleanup temp files
  cleanupFiles(downloaded);

  return { issues: found, files: downloaded };
}

/* -------------------- main text rule check -------------------- */
function checkWithRulebook(platform, fields, rb) {
  const issues = [];
  const fixes = [];
  let high = false;

  const title = fields.title || '';
  const desc  = fields.description || '';
  const caption = fields.caption || '';
  const link  = fields.link || '';
  const tags  = fields.tags || '';
  const hashtags = fields.hashtags || '';

  // ---- limits ----
  if (rb?.limits?.title_max && title && title.length > rb.limits.title_max) {
    issues.push(`Title exceeds ${rb.limits.title_max} characters.`);
    fixes.push({ field:'title', suggestion: title.slice(0, rb.limits.title_max) });
  }
  if (rb?.limits?.description_max && desc && desc.length > rb.limits.description_max) {
    issues.push(`Description exceeds ${rb.limits.description_max} characters.`);
    fixes.push({ field:'description', suggestion: desc.slice(0, rb.limits.description_max) });
  }
  if (rb?.limits?.caption_max && caption && caption.length > rb.limits.caption_max) {
    issues.push(`Caption exceeds ${rb.limits.caption_max} characters.`);
    fixes.push({ field:'caption', suggestion: caption.slice(0, rb.limits.caption_max) });
  }
  if (rb?.limits?.tags_max_count && tags) {
    const count = (tags.split(',').map(s=>s.trim()).filter(Boolean)).length;
    if (count > rb.limits.tags_max_count) {
      issues.push(`Tags exceed ${rb.limits.tags_max_count} allowed.`);
      fixes.push({ field:'tags', suggestion: tags.split(',').slice(0, rb.limits.tags_max_count).join(',') });
    }
  }
  if (rb?.limits?.hashtags_max_count && hashtags) {
    const count = (hashtags.split(/[#\s,]+/).map(s=>s.trim()).filter(Boolean)).length;
    if (count > rb.limits.hashtags_max_count) {
      issues.push(`Hashtags exceed ${rb.limits.hashtags_max_count} allowed.`);
      fixes.push({ field:'hashtags', suggestion: hashtags.split(/[#\s,]+/).slice(0, rb.limits.hashtags_max_count).join(' ') });
    }
  }

  // ---- link checks ----
  const platformsWithLinks = new Set(['pinterest','youtube','tiktok','amazon','instagram','facebook','x','linkedin','reddit','snapchat','ebay']);
  if (platformsWithLinks.has(platform) && link) {
    if (!/^https?:\/\//i.test(link)) {
      issues.push('Destination URL should start with http(s)://');
    }
  }

  // ---- category scanning ----
  const searchable = buildSearchText(fields);
  const mainFieldKey = primaryTextField(fields) || 'description';
  const mainText = fields[mainFieldKey] || '';

  (rb?.categories || []).forEach(cat => {
    // medical shared list (proximity logic)
    if (cat.patterns_ref && /shared\.medical\.json/i.test(cat.patterns_ref)) {
      const sharedMed = loadShared('shared.medical.json');
      const verbs    = (sharedMed?.claim_verbs || []).concat(['fdaapproved','fdacleared']);
      const diseases = sharedMed?.diseases || [];
      if (verbNearNoun(searchable, verbs, diseases, 6)) {
        high = high || cat.severity === 'high';
        issues.push(cat.label || 'Medical / Health Claims detected.');
        const suggestion = rewriteMedical(mainText, sharedMed, rb);
        if (suggestion && suggestion !== mainText) fixes.push({ field: mainFieldKey, suggestion });
        // Debug log
        console.log('RULE MATCHED:', cat.id, '=>', 'proximity(verbs~diseases)');
      }
      return;
    }

    // resolve patterns_ref to literal-safe strings
    let listPatterns = [];
    if (cat.patterns_ref) {
      listPatterns = resolvePatternsRef(cat.patterns_ref)
        .map(p => typeof p === 'string' ? escapeRegex(p) : '')
        .filter(Boolean);
    }

    // normalize inline patterns: support strings or objects {pattern, flags}
    const inline = (cat.patterns || []).filter(Boolean);

    // test each pattern individually so flags are honored and we can log precisely
    const all = [
      ...listPatterns.map(s => ({ pattern: s, flags: 'i', _source: 'ref' })),
      ...inline.map(p => {
        if (typeof p === 'string') return { pattern: p, flags: 'i', _source: 'inline:string' };
        if (p && typeof p === 'object' && typeof p.pattern === 'string') {
          return { pattern: p.pattern, flags: p.flags || 'i', _source: 'inline:object' };
        }
        return null;
      }).filter(Boolean)
    ];

    for (const entry of all) {
      try {
        const re = new RegExp(entry.pattern, entry.flags || 'i');
        if (re.test(searchable)) {
          if (cat.severity === 'high') high = true;
          // --- DEBUG: log exact category + pattern
          console.log('RULE MATCHED:', cat.id, '=>', `/${entry.pattern}/${entry.flags || 'i'}`);
          // push issue once per category label (avoid duplicates)
          if (!issues.some(x => x === (cat.label || 'Policy issue detected.'))) {
            issues.push(cat.label || 'Policy issue detected.');
          }
          if (cat.rewrite?.find) {
            const r = new RegExp(cat.rewrite.find, 'ig');
            const suggestion = (mainText || '').replace(r, cat.rewrite.replace ?? 'neutral');
            if (suggestion && suggestion !== mainText) {
              fixes.push({ field: mainFieldKey, suggestion });
            }
          }
        }
      } catch (e) {
        console.warn('Bad regex in category', cat.id, 'pattern:', entry && entry.pattern, 'flags:', entry && entry.flags, e.message);
      }
    }

    // run structured checks if any
    if (Array.isArray(cat.checks)) {
      cat.checks.forEach(chk => {
        if (chk === 'url_scheme_http_https' && link) {
          if (!/^https?:\/\//i.test(link)) {
            if (cat.severity === 'high') high = true;
            issues.push(cat.label || 'Link policy issue.');
            console.log('RULE MATCHED:', cat.id, '=>', 'check:url_scheme_http_https');
          }
        }
      });
    }
  });

  return { issues, fixes, high };
}

/* -------------------- router helpers -------------------- */
function runChecks({ platform, fields }) {
  const p = String(platform||'').toLowerCase();
  const rb = loadRulebook(p);
  if (!rb) {
    return { issues:[`No rulebook found for ${p}`], fixes:[], high:true };
  }
  // Merge global categories (applies to all platforms)
  const globalRules = loadShared('shared.global.json');
  if (globalRules && Array.isArray(globalRules.categories)) {
    rb.categories = [...(rb.categories || []), ...globalRules.categories];
  }
  return checkWithRulebook(p, fields, rb);
}

function degradeToNeutral(original) {
  const style = detectStyle(original || '');
  const safe = 'Designed for general use and compliant with platform guidelines.';
  return applyStyle(safe, style);
}

function buildModelPrompt(platform, fields, platformRules) {
  const textToCheck = Object.values(fields).filter(v => typeof v === 'string' && v.trim()).join('\n');
  return `
You are a TOS compliance checker for ${platform}.
Rules (JSON):
${JSON.stringify(platformRules, null, 2)}

Task:
1) Classify the content as "green" (safe), "yellow" (borderline), or "red" (violation).
2) Provide a single rewritten version that preserves the original tone but is fully compliant with the rules.

Strict format (exactly):
Label: <green|yellow|red>
Rewrite: <one safe line>

Content:
${textToCheck}
`.trim();
}

async function callOllama(prompt, modelName = 'llama3.1:8b', timeoutMs = 2500) {
  if (!_fetch) throw new Error('No fetch available; install node-fetch or use Node 18+.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ollama_timeout')), timeoutMs);
  try {
    const res = await _fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt, stream: false }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.response) ? String(data.response).trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

function parseModelOutput(text='') {
  const labelMatch = text.match(/Label:\s*(green|yellow|red)/i);
  const rewriteMatch = text.match(/Rewrite:\s*([\s\S]*)$/i);
  return {
    label: labelMatch ? labelMatch[1].toLowerCase() : 'unknown',
    rewrite: rewriteMatch ? rewriteMatch[1].trim() : null
  };
}

/* -------------------- router -------------------- */
app.post('/api/check', async (req,res)=>{
  try{
    const { platform, fields, strictMode = false, saveReceipts, scanImages = true } = req.body || {};
    if (!platform || !fields) return res.status(400).json({ error:'Missing platform or fields' });

    // 1) Text checks
    let { issues, fixes, high } = runChecks({ platform, fields });
    let level = issues.length===0 ? 'green' : (high ? 'red' : 'yellow');

    // 2) Image checks (Step 3)
    let imageFindings = [];
    if (scanImages) {
      try {
        const imageScan = await scanImagesFromFields(fields, { enable: true });
        imageFindings = imageScan.issues || [];
        // Merge image issues into overall
        if (imageFindings.length > 0) {
          for (const hit of imageFindings) {
            issues.push(`${hit.label}${hit.url ? ` [${hit.url}]` : ''}`);
            if (hit.severity === 'high') high = true;
          }
          level = issues.length===0 ? 'green' : (high ? 'red' : 'yellow');
        }
      } catch (e) {
        // Image scanner error should not block text checks
        console.warn('Image scan error:', e && e.message ? e.message : String(e));
      }
    }

    // 3) re-check suggestion (level change only in strict mode)
    const mainField = primaryTextField(fields);
    const suggested = fixes.find(f => mainField && f.field === mainField);
    if (suggested && suggested.suggestion) {
      const second = runChecks({ platform, fields: { ...fields, [mainField]: suggested.suggestion } });
      const secondLevel = second.issues.length===0 ? 'green' : (second.high ? 'red' : 'yellow');
      if (strictMode) {
        const rank = { red:3, yellow:2, green:1 };
        if (rank[secondLevel] <= rank[level]) {
          level = secondLevel;
          issues = second.issues;
        }
      }
    }

    // 4) local LLM augmentation (borderline/high)
    let model = null;
    if (level !== 'green') {
      try {
        const rb = loadRulebook(String(platform).toLowerCase());
        if (rb) {
          const prompt = buildModelPrompt(platform, fields, rb);
          const output = await callOllama(prompt);
          const parsed = parseModelOutput(output);

          if (parsed.rewrite) {
            const key = mainField || 'description';
            const recheck = runChecks({ platform, fields: { ...fields, [key]: parsed.rewrite } });
            const reLevel = recheck.issues.length===0 ? 'green' : (recheck.high ? 'red' : 'yellow');

            let finalRewrite = parsed.rewrite;
            if (strictMode && reLevel !== 'green') {
              finalRewrite = degradeToNeutral(parsed.rewrite);
            }

            model = { name: 'Llama 3.1 (local)', label: parsed.label || 'unknown', rewrite: finalRewrite };

            if (strictMode) {
              const rank = { red:3, yellow:2, green:1 };
              if (rank[reLevel] < rank[level]) {
                level = reLevel;
                issues = recheck.issues;
              }
            } else {
              if (mainField && finalRewrite) {
                fixes = [...(fixes||[]), { field: mainField, suggestion: finalRewrite, source: 'model' }];
              }
            }
          } else {
            model = { name: 'Llama 3.1 (local)', label: parsed.label || 'unknown', rewrite: null };
          }
        }
      } catch (e) {
        model = { name: 'Llama 3.1 (local)', error: String(e.message || e) };
      }
    }

    const shouldSave = (typeof saveReceipts === 'boolean') ? saveReceipts : true;
    if (shouldSave) {
      saveReceipt(platform, {
        timestamp: new Date().toISOString(),
        platform, level, issues,
        fixesCount: (fixes || []).length,
        rulebookVersion: loadRulebook(String(platform).toLowerCase())?.version || 'unknown',
        fieldsSnapshot: { ...fields, image: undefined, thumb: undefined },
        imageFindings,
        model: model ? { name: model.name, label: model.label, hadError: !!model.error } : null,
        strictMode
      });
    }

    res.json({ level, issues, fixes, model, imageFindings });

  }catch(e){
    console.error(e);
    res.status(500).json({ error:'Server error' });
  }
});

app.listen(PORT, ()=>console.log(`TOS Guardian running at http://localhost:${PORT}`));
