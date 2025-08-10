// server.js — multi-platform rule engine with patterns_ref, fuzzy+proximity medical detection,
// tone-preserving rewrites, local receipts, optional local LLM assist (Ollama),
// and Image checks (URL token heuristics + MIME sniff + dimensions/aspect + data: URLs).
// Platforms supported: etsy, pinterest, shopify, youtube, tiktok, amazon, instagram,
// facebook, x, linkedin, reddit, snapchat, ebay

const express = require('express');
const fs = require('fs');
const path = require('path');
const { fileTypeFromBuffer } = require('file-type');
const imageSize = require('image-size');

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
  // name like "shared.medical.json" or "shared.global.json" or "shared.image.json"
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

  const tokens = s.split(/(\W+)/);
  for (let i=0;i<tokens.length;i++) {
    if (/^[a-z0-9]+$/i.test(tokens[i]) && fuzzyMatchAny(tokens[i], verbs, 1)) {
      const isPlural = /s$/i.test(tokens[i]);
      tokens[i] = isPlural ? 'supports' : neutralVerb;
    }
  }
  s = tokens.join('');

  const tokens2 = s.split(/(\W+)/);
  for (let i=0;i<tokens2.length;i++) {
    if (/^[a-z0-9]+$/i.test(tokens2[i]) && fuzzyMatchAny(tokens2[i], diseases, 1)) {
      tokens2[i] = neutralNoun;
    }
  }
  s = tokens2.join('');

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

/* -------------------- Image helpers -------------------- */
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
  const DATA_LIKE = /data:image\/[a-z0-9+.\-]+;base64,[a-z0-9+/=\s]+/ig;

  function collect(val, keyHint = '') {
    if (!val) return;

    if (typeof val === 'string') {
      const looksLikeUrl  = /^https?:\/\//i.test(val);
      const looksLikeData = /^data:image\//i.test(val);

      if (looksLikeUrl) {
        if (IMG_EXT.test(val) || KEY_HINTS.has(keyHint.toLowerCase())) urls.add(val);
      }
      if (looksLikeData) urls.add(val);

      const urlMatches = val.match(URL_LIKE) || [];
      for (const u of urlMatches) if (IMG_EXT.test(u)) urls.add(u);

      const dataMatches = val.match(DATA_LIKE) || [];
      for (const d of dataMatches) urls.add(d);
      return;
    }

    if (Array.isArray(val)) { for (const item of val) collect(item, keyHint); return; }

    if (typeof val === 'object') {
      if (seen.has(val)) return;
      seen.add(val);

      const candidate = val.url || val.src || val.href;
      if (typeof candidate === 'string') {
        if (/^https?:\/\//i.test(candidate)) {
          if (IMG_EXT.test(candidate) || KEY_HINTS.has(String(keyHint).toLowerCase())) urls.add(candidate);
        }
        if (/^data:image\//i.test(candidate)) urls.add(candidate);
      }

      for (const [k, v] of Object.entries(val)) collect(v, k);
      return;
    }
  }

  collect(fields, '');
  return Array.from(urls);
}

function parseDataUrl(dataUrl) {
  // data:image/png;base64,AAAA...
  const m = /^data:(image\/[a-z0-9+.\-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  const buf = Buffer.from(m[2].replace(/\s+/g,''), 'base64');
  return { contentType, buffer: buf, size: buf.length };
}

async function downloadImage(url) {
  // Supports http(s) and data:image/*
  const dir = path.join(__dirname, 'data', 'images', 'tmp');
  ensureDir(dir);

  // data URL path (no IO, no network)
  if (/^data:image\//i.test(url)) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('bad_data_url');
    return {
      path: null,
      size: parsed.size,
      contentType: parsed.contentType,
      buffer: parsed.buffer,
      from: 'dataurl'
    };
  }

  if (!_fetch) throw new Error('fetch unavailable');
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
    return { path: fp, size: buf.length, contentType: String(ct).toLowerCase(), buffer: buf, from: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

function cleanupFiles(fileInfos) {
  for (const f of fileInfos) {
    try { if (f && f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
  }
}

async function awaitMaybeFileType(buf) {
  try { return await fileTypeFromBuffer(buf); } catch { return null; }
}

/* Image checks: URL tokens + Layers 2–4 (sniff, dimensions, simple heuristics) */
async function detectImageIssues(url, fileInfo, { urlOnly = false } = {}) {
  const issues = [];
  const pathish = `${url || ''} ${fileInfo?.path || ''}`.toLowerCase();

  // Boundary-ish simple search
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
  function hasPattern(re) { return re.test(pathish); }

  // URL token heuristics (Layer 1)
  if (hasToken('nsfw') || hasToken('onlyfans') || hasToken('porn') || hasToken('xxx') || hasToken('explicit') || hasToken('adult')) {
    issues.push({ severity: 'high', label: 'NSFW / Adult content (image hint)' });
  }
  if (hasToken('gore') || hasToken('blood') || hasToken('beheading') || hasToken('decap') || hasToken('dismember')) {
    issues.push({ severity: 'high', label: 'Graphic violence (image hint)' });
  }
  if (hasToken('replica') || hasPattern(/super[-_]?copy/i) || hasPattern(/1[:\-_]1/i)) {
    issues.push({ severity: 'high', label: 'Counterfeit / Replica (image hint)' });
  }
  if (hasToken('qrcode') || hasPattern(/\bscan[-_]?me\b/i) || hasToken('qr')) {
    issues.push({ severity: 'medium', label: 'QR / Scan code solicitation (image hint)' });
  }

  // Layers 2–4 only if we actually have bytes
  if (fileInfo?.buffer && fileInfo.buffer.length > 0) {
    const sharedImg = loadShared('shared.image.json') || {};
    const minW = Number(sharedImg.min_width || 300);
    const minH = Number(sharedImg.min_height || 300);
    const minAR = Number(sharedImg.min_aspect || 0.2);
    const maxAR = Number(sharedImg.max_aspect || 5.0);

    // Layer 2: MIME sniffing vs declared content-type and URL extension
    try {
      const ft = await awaitMaybeFileType(fileInfo.buffer);
      if (ft) {
        const sniffMime = String(ft.mime || '').toLowerCase();
        const declared = String(fileInfo.contentType || '').toLowerCase();
        if (declared && sniffMime && !declared.startsWith(sniffMime)) {
          issues.push({ severity: 'medium', label: `File signature (${sniffMime}) differs from declared (${declared})` });
        }
        // extension mismatch
        const urlExtMatch = (url || '').match(/\.(\w+)(?:\?.*)?$/i);
        if (urlExtMatch && ft.ext) {
          const ext = urlExtMatch[1].toLowerCase();
          const extMap = { jpg:'jpeg', jpeg:'jpeg', png:'png', webp:'webp', gif:'gif', bmp:'bmp', tiff:'tiff', tif:'tiff', svg:'svg' };
          const normUrl = extMap[ext] || ext;
          const normSniff = extMap[ft.ext] || ft.ext;
          if (normUrl && normSniff && normUrl !== normSniff) {
            issues.push({ severity: 'medium', label: `Extension (${ext}) doesn’t match file type (${ft.ext})` });
          }
        }
      }
    } catch (e) {
      // ignore sniff errors
    }

    // Layer 3: dimensions & aspect ratio
    try {
      const dim = imageSize(fileInfo.buffer);
      if (dim && dim.width && dim.height) {
        const { width, height } = dim;
        const ar = width / height;

        if (width < minW || height < minH) {
          issues.push({ severity: 'medium', label: `Image too small (${width}x${height}, min ${minW}x${minH})` });
        }
        if (ar < minAR || ar > maxAR) {
          issues.push({ severity: 'medium', label: `Extreme aspect ratio (${ar.toFixed(2)})` });
        }
      }
    } catch (e) {
      // ignore dimension errors
    }

    // Layer 4: simple “oddity” heuristics
    try {
      if (fileInfo.size > 0 && fileInfo.size < 1024) {
        issues.push({ severity: 'medium', label: 'Very small image payload (<1KB)' });
      }
    } catch {}
  } else if (!urlOnly) {
    // No bytes (and not URL-only pass) but looks like an image URL -> note
    if (url && IMG_EXT.test(url)) {
      issues.push({ severity: 'medium', label: 'Image fetch failed (non-blocking)' });
    }
  }

  return issues;
}

async function scanImagesFromFields(fields, { enable = true } = {}) {
  if (!enable) return { issues: [], files: [] };
  const urls = extractImageUrls(fields);
  if (urls.length === 0) return { issues: [], files: [] };

  const downloaded = [];
  const found = [];

  for (const url of urls) {
    // URL token checks first (do NOT add fetch-failed here)
    try {
      const urlOnlyHits = await detectImageIssues(url, null, { urlOnly: true });
      urlOnlyHits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch {}

    // Try to get bytes (http OR data URL)
    try {
      const info = await downloadImage(url);
      downloaded.push(info);
      const hits = await detectImageIssues(url, info);
      hits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch (e) {
      if (IMG_EXT.test(url)) {
        found.push({ url, severity: 'medium', label: 'Image fetch failed (non-blocking)' });
      }
    }
  }

  // Clean up temp http files
  cleanupFiles(downloaded.filter(f => f && f.from === 'http'));

  return { issues: found, files: downloaded };
}

/* -------------------- main text rule check -------------------- */
function checkWithRulebook(platform, fields, rb) {
  const issues = [];
  let fixes = [];
  let high = false;

  const title = fields.title || '';
  const desc  = fields.description || '';
  const caption = fields.caption || '';
  const link  = fields.link || '';
  const tags  = fields.tags || '';
  const hashtags = fields.hashtags || '';

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

  const platformsWithLinks = new Set(['pinterest','youtube','tiktok','amazon','instagram','facebook','x','linkedin','reddit','snapchat','ebay']);
  if (platformsWithLinks.has(platform) && link) {
    if (!/^https?:\/\//i.test(link)) issues.push('Destination URL should start with http(s)://');
  }

  const searchable = buildSearchText(fields);
  const mainFieldKey = primaryTextField(fields) || 'description';
  const mainText = fields[mainFieldKey] || '';

  (rb?.categories || []).forEach(cat => {
    if (cat.patterns_ref && /shared\.medical\.json/i.test(cat.patterns_ref)) {
      const sharedMed = loadShared('shared.medical.json');
      const verbs    = (sharedMed?.claim_verbs || []).concat(['fdaapproved','fdacleared']);
      const diseases = sharedMed?.diseases || [];
      if (verbNearNoun(searchable, verbs, diseases, 6)) {
        high = high || cat.severity === 'high';
        issues.push(cat.label || 'Medical / Health Claims detected.');
        const suggestion = rewriteMedical(mainText, sharedMed, rb);
        if (suggestion && suggestion !== mainText) fixes.push({ field: mainFieldKey, suggestion });
        console.log('RULE MATCHED:', cat.id, '=>', 'proximity(verbs~diseases)');
      }
      return;
    }

    let listPatterns = [];
    if (cat.patterns_ref) {
      listPatterns = resolvePatternsRef(cat.patterns_ref)
        .map(p => typeof p === 'string' ? escapeRegex(p) : '')
        .filter(Boolean);
    }

    const inline = (cat.patterns || []).filter(Boolean);
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
          console.log('RULE MATCHED:', cat.id, '=>', `/${entry.pattern}/${entry.flags || 'i'}`);
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
  if (!rb) return { issues:[`No rulebook found for ${p}`], fixes:[], high:true };

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

    // 2) Image checks
    let imageFindings = [];
    if (scanImages) {
      try {
        const imageScan = await scanImagesFromFields(fields, { enable: true });
        imageFindings = imageScan.issues || [];
        if (imageFindings.length > 0) {
          for (const hit of imageFindings) {
            issues.push(`${hit.label}${hit.url ? ` [${hit.url}]` : ''}`);
            if (hit.severity === 'high') high = true;
          }
          level = issues.length===0 ? 'green' : (high ? 'red' : 'yellow');
        }
      } catch (e) {
        console.warn('Image scan error:', e && e.message ? e.message : String(e));
      }
    }

    // 3) Re-check suggestion (strict mode can downgrade risk)
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

    // 4) Optional local model assist
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
            if (strictMode && reLevel !== 'green') finalRewrite = degradeToNeutral(parsed.rewrite);

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
