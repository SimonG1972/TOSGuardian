// server.js — multi-platform rule engine + uploads + rulebook mgmt + receipts viewer
// Features: text+image checks, image heuristics, optional Ollama assist, file uploads,
// rulebook read/write, receipts listing, health/metrics, static UI.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { fileTypeFromBuffer } = require('file-type');
const imageSize = require('image-size');

const platformConfig = require('./lib/platformConfig');
const logger = require('./lib/logger');

const app = express();
const PORT = 3000;

// ---------- metrics ----------
const metrics = {
  start_time: Date.now(),
  requests_total: 0,
  checks_total: 0,
  image_checks_total: 0,
  last_error_ts: 0
};

// ---------- utils ----------
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function writeJSON(fp, obj) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}
function saveReceipt(platform, payload) {
  const dir = path.join(__dirname, 'data', 'receipts');
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `receipt-${platform}-${ts}.json`;
  fs.writeFileSync(path.join(dir, id), JSON.stringify(payload, null, 2));
  return id;
}
function loadRulebook(platform) {
  return readJSON(path.join(__dirname, 'rules', `${platform}.v1.json`));
}
function loadShared(name) {
  return readJSON(path.join(__dirname, 'rules', name));
}

// ---------- static + json ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- request logging ----------
app.use((req, res, next) => {
  metrics.requests_total += 1;
  const start = process.hrtime.bigint();
  const reqId = (Math.random().toString(36).slice(2) + Date.now().toString(36));
  req.id = reqId;
  logger.info('req.start', { reqId, method: req.method, path: req.path });
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('req.finish', { reqId, status: res.statusCode, ms: Math.round(durMs) });
  });
  next();
});

// ---------- fetch polyfill ----------
let _fetch = global.fetch;
if (typeof _fetch !== 'function') {
  try { _fetch = require('node-fetch'); } catch { _fetch = null; }
}

// ---------- engine helpers ----------
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
function buildSearchText(fields) {
  return Object.values(fields).filter(v => typeof v === 'string').join(' ');
}
function primaryTextField(fields) {
  if (typeof fields.description === 'string') return 'description';
  if (typeof fields.caption === 'string') return 'caption';
  if (typeof fields.title === 'string') return 'title';
  return null;
}

// ---------- image helpers ----------
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)(\?.*)?$/i;

function extractImageUrls(fields) {
  const urls = new Set();
  const seen = new WeakSet();
  const KEY_HINTS = new Set(['image','image_url','thumbnail','thumb','cover','banner','photo','picture','pic','images','photos','media','media_url']);
  const URL_LIKE = /https?:\/\/[^\s"'()<>]+/ig;
  const DATA_LIKE = /data:image\/[a-z0-9+.\-]+;base64,[a-z0-9+/=\s]+/ig;

  function collect(val, keyHint='') {
    if (!val) return;
    if (typeof val === 'string') {
      const looksLikeUrl = /^https?:\/\//i.test(val);
      const looksLikeData = /^data:image\//i.test(val);
      if (looksLikeUrl) {
        if (IMG_EXT.test(val) || KEY_HINTS.has(keyHint.toLowerCase())) urls.add(val);
      }
      if (looksLikeData) urls.add(val);
      (val.match(URL_LIKE)||[]).forEach(u => { if (IMG_EXT.test(u)) urls.add(u); });
      (val.match(DATA_LIKE)||[]).forEach(d => urls.add(d));
      return;
    }
    if (Array.isArray(val)) { val.forEach(v=>collect(v, keyHint)); return; }
    if (typeof val === 'object') {
      if (seen.has(val)) return; seen.add(val);
      const candidate = val.url || val.src || val.href;
      if (typeof candidate === 'string') {
        if (/^https?:\/\//i.test(candidate)) {
          if (IMG_EXT.test(candidate) || KEY_HINTS.has(String(keyHint).toLowerCase())) urls.add(candidate);
        }
        if (/^data:image\//i.test(candidate)) urls.add(candidate);
      }
      for (const [k,v] of Object.entries(val)) collect(v, k);
    }
  }
  collect(fields, '');
  return Array.from(urls);
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9+.\-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  const buf = Buffer.from(m[2].replace(/\s+/g,''), 'base64');
  return { contentType, buffer: buf, size: buf.length };
}

async function downloadImage(url) {
  // also support local uploaded files served at /files/:id
  if (/^data:image\//i.test(url)) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('bad_data_url');
    return { path: null, size: parsed.size, contentType: parsed.contentType, buffer: parsed.buffer, from: 'dataurl' };
  }
  if (/^\/files\//i.test(url)) {
    const fp = path.join(__dirname, url.replace(/^\//,''));
    const buf = fs.readFileSync(fp);
    const stat = fs.statSync(fp);
    const ct = 'application/octet-stream';
    return { path: fp, size: stat.size, contentType: ct, buffer: buf, from: 'local' };
  }
  if (!_fetch) throw new Error('fetch unavailable');
  const res = await _fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers && (res.headers.get?.('content-type') || res.headers['content-type'])) || '';
  return { path: null, size: buf.length, contentType: String(ct).toLowerCase(), buffer: buf, from: 'http' };
}
async function awaitMaybeFileType(buf) {
  try { return await fileTypeFromBuffer(buf); } catch { return null; }
}
async function detectImageIssues(url, fileInfo, cfg, { urlOnly = false } = {}) {
  const issues = [];
  const pathish = `${url || ''} ${fileInfo?.path || ''}`.toLowerCase();
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
  const configuredTerms = (cfg?.urlHeuristics?.blockTerms || []);
  const defaultTerms = ['nsfw','onlyfans','porn','xxx','explicit','adult','gore','blood','beheading','decap','dismember','replica','counterfeit'];
  const blockTerms = configuredTerms.length ? configuredTerms : defaultTerms;

  for (const term of blockTerms) {
    if (hasToken(term.toLowerCase())) {
      const label =
        /gore|blood|beheading|decap|dismember/.test(term) ? 'Graphic violence (image hint)'
      : /replica|counterfeit/.test(term) ? 'Counterfeit / Replica (image hint)'
      : 'NSFW / Adult content (image hint)';
      issues.push({ severity: 'high', label });
    }
  }
  if (hasToken('qrcode') || hasPattern(/\bscan[-_]?me\b/i) || hasToken('qr')) {
    issues.push({ severity: 'medium', label: 'QR / Scan code solicitation (image hint)' });
  }

  if (fileInfo?.buffer && fileInfo.buffer.length > 0) {
    try {
      const ft = await awaitMaybeFileType(fileInfo.buffer);
      if (ft) {
        const sniffMime = String(ft.mime || '').toLowerCase();
        const declared = String(fileInfo.contentType || '').toLowerCase();
        if (declared && sniffMime && !declared.startsWith(sniffMime)) {
          issues.push({ severity: 'medium', label: `File signature (${sniffMime}) differs from declared (${declared})` });
        }
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
    } catch {}
    try {
      const dim = imageSize(fileInfo.buffer);
      if (dim && dim.width && dim.height) {
        const { width, height } = dim;
        const ar = width / height;
        const minW = Number(cfg?.image?.minWidth ?? 300);
        const minH = Number(cfg?.image?.minHeight ?? 300);
        const minAR = Number(cfg?.image?.minAspectRatio ?? 0.2);
        const maxAR = Number(cfg?.image?.maxAspectRatio ?? 5.0);
        if (width < minW || height < minH) {
          issues.push({ severity: 'medium', label: `Image too small (${width}x${height}, min ${minW}x${minH})` });
        }
        if (ar < minAR || ar > maxAR) {
          issues.push({ severity: 'medium', label: `Extreme aspect ratio (${ar.toFixed(2)})` });
        }
      }
    } catch {}
    try {
      const smallCutoff = Number(cfg?.smallPayloadCutoffBytes ?? 1024);
      if (fileInfo.size > 0 && fileInfo.size < smallCutoff) {
        issues.push({ severity: 'medium', label: `Very small image payload (<${smallCutoff}B)` });
      }
    } catch {}
  } else if (!urlOnly) {
    if (url && IMG_EXT.test(url)) {
      issues.push({ severity: 'medium', label: 'Image fetch failed (non-blocking)' });
    }
  }
  return issues;
}

async function scanImagesFromFields(fields, cfg, { enable = true } = {}) {
  if (!enable) return { issues: [], files: [] };
  const urls = extractImageUrls(fields);
  if (urls.length === 0) return { issues: [], files: [] };
  const downloaded = [];
  const found = [];
  for (const url of urls) {
    try {
      const urlOnlyHits = await detectImageIssues(url, null, cfg, { urlOnly: true });
      urlOnlyHits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch {}
    try {
      const info = await downloadImage(url);
      downloaded.push(info);
      const hits = await detectImageIssues(url, info, cfg);
      hits.forEach(h => found.push({ url, severity: h.severity, label: h.label }));
    } catch (e) {
      if (IMG_EXT.test(url)) {
        found.push({ url, severity: 'medium', label: 'Image fetch failed (non-blocking)' });
      }
    }
  }
  return { issues: found, files: downloaded };
}

// ---------- text checker ----------
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
      ...listPatterns.map(s => ({ pattern: s, flags: 'i' })),
      ...inline.map(p => {
        if (typeof p === 'string') return { pattern: p, flags: 'i' };
        if (p && typeof p === 'object' && typeof p.pattern === 'string') {
          return { pattern: p.pattern, flags: p.flags || 'i' };
        }
        return null;
      }).filter(Boolean)
    ];

    for (const entry of all) {
      try {
        const re = new RegExp(entry.pattern, entry.flags || 'i');
        if (re.test(searchable)) {
          if (cat.severity === 'high') high = true;
          if (!issues.includes(cat.label || 'Policy issue detected.')) {
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
      } catch {}
    }
  });

  return { issues, fixes, high };
}
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

// ---------- API: compliance check ----------
app.post('/api/check', async (req,res)=>{
  try{
    const { platform, fields, strictMode = false, saveReceipts, scanImages = true } = req.body || {};
    if (!platform || !fields) return res.status(400).json({ error:'Missing platform or fields' });

    const cfg = platformConfig.get(String(platform || 'default').toLowerCase());
    metrics.checks_total += 1;

    let { issues, fixes, high } = runChecks({ platform, fields });
    let level = issues.length===0 ? 'green' : (high ? 'red' : 'yellow');

    let imageFindings = [];
    if (scanImages) {
      try {
        const imageScan = await scanImagesFromFields(fields, cfg, { enable: true });
        metrics.image_checks_total += 1;
        imageFindings = imageScan.issues || [];
        if (imageFindings.length > 0) {
          for (const hit of imageFindings) {
            issues.push(`${hit.label}${hit.url ? ` [${hit.url}]` : ''}`);
            if (hit.severity === 'high') high = true;
          }
          level = issues.length===0 ? 'green' : (high ? 'red' : 'yellow');
        }
      } catch (e) {
        logger.warn('image.scan.error', { err: e && e.message ? e.message : String(e) });
        metrics.last_error_ts = Date.now();
      }
    }

    // re-check suggestion
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

    // optional model assist
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
    let receiptId = null;
    if (shouldSave) {
      receiptId = saveReceipt(platform, {
        id: null,
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

    res.json({ level, issues, fixes, model, imageFindings, receiptId });

  }catch(e){
    logger.error('route.error', { err: e && e.message ? e.message : String(e) });
    metrics.last_error_ts = Date.now();
    res.status(500).json({ error:'Server error' });
  }
});

// ---------- uploads (images + pdf) ----------
const uploadDir = path.join(__dirname, 'files', 'uploads');
ensureDir(uploadDir);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.post('/api/upload', upload.array('files', 12), async (req, res) => {
  try {
    const out = [];
    for (const f of req.files || []) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}_${f.originalname.replace(/[^\w.\-]+/g,'_')}`;
      const dest = path.join(uploadDir, id);
      fs.writeFileSync(dest, f.buffer);
      out.push({ name: f.originalname, url: `/files/uploads/${id}`, size: f.size });
    }
    res.json({ files: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// serve uploaded files
app.use('/files', express.static(path.join(__dirname, 'files'), { fallthrough: false }));

// ---------- rulebook management (local dev only) ----------
app.get('/api/rules', (req, res) => {
  try {
    const dir = path.join(__dirname, 'rules');
    const files = fs.readdirSync(dir).filter(f => /\.v1\.json$/i.test(f));
    const platforms = files.map(f => f.replace(/\.v1\.json$/i,''));
    res.json({ platforms });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/rules/:platform', (req, res) => {
  const rb = loadRulebook(req.params.platform.toLowerCase());
  if (!rb) return res.status(404).json({ error: 'Rulebook not found' });
  res.json(rb);
});
app.put('/api/rules/:platform', (req, res) => {
  try {
    const platform = req.params.platform.toLowerCase();
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON' });
    const fp = path.join(__dirname, 'rules', `${platform}.v1.json`);
    writeJSON(fp, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- receipts viewer ----------
app.get('/api/receipts', (req, res) => {
  try {
    const dir = path.join(__dirname, 'data', 'receipts');
    ensureDir(dir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const list = files.slice(0, limit).map(name => {
      const fp = path.join(dir, name);
      let level = 'unknown', platform = 'unknown', timestamp = null;
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        level = j.level || 'unknown';
        platform = j.platform || 'unknown';
        timestamp = j.timestamp || null;
      } catch {}
      return { id: name, platform, level, timestamp };
    });
    res.json({ receipts: list });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/receipts/:id', (req, res) => {
  try {
    const fp = path.join(__dirname, 'data', 'receipts', req.params.id);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    res.type('application/json').send(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- health/ready/metrics ----------
app.get('/healthz', (req, res) => {
  try {
    const cfgOk = !!platformConfig.get('default');
    const upMs = Date.now() - metrics.start_time;
    res.json({
      status: 'ok',
      uptime_ms: upMs,
      node: process.version,
      checks: { config_loaded: !!cfgOk },
      counters: {
        requests_total: metrics.requests_total,
        checks_total: metrics.checks_total,
        image_checks_total: metrics.image_checks_total,
        last_error_ts: metrics.last_error_ts || null
      }
    });
  } catch (e) {
    metrics.last_error_ts = Date.now();
    res.status(500).json({ status: 'degraded', error: String(e.message || e) });
  }
});
app.get('/readyz', (req, res) => {
  try {
    const cfgOk = !!platformConfig.get('default');
    if (!cfgOk) return res.status(500).json({ status: 'degraded', reason: 'config' });
    res.json({ status: 'ready' });
  } catch (e) {
    metrics.last_error_ts = Date.now();
    res.status(500).json({ status: 'degraded', error: String(e.message || e) });
  }
});
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  const upSec = Math.floor((Date.now() - metrics.start_time) / 1000);
  const lines = [
    '# HELP tosguardian_uptime_seconds Process uptime in seconds',
    '# TYPE tosguardian_uptime_seconds gauge',
    `tosguardian_uptime_seconds ${upSec}`,
    '# HELP tosguardian_requests_total Total HTTP requests',
    '# TYPE tosguardian_requests_total counter',
    `tosguardian_requests_total ${metrics.requests_total}`,
    '# HELP tosguardian_checks_total Total /api/check invocations',
    '# TYPE tosguardian_checks_total counter',
    `tosguardian_checks_total ${metrics.checks_total}`,
    '# HELP tosguardian_image_checks_total Total image scans performed',
    '# TYPE tosguardian_image_checks_total counter',
    `tosguardian_image_checks_total ${metrics.image_checks_total}`,
    '# HELP tosguardian_last_error_ts Unix ms timestamp of last error (0 if none)',
    '# TYPE tosguardian_last_error_ts gauge',
    `tosguardian_last_error_ts ${metrics.last_error_ts || 0}`
  ];
  res.send(lines.join('\n') + '\n');
});

// ---------- start ----------
app.listen(PORT, () => logger.info('server.started', { port: PORT }));
