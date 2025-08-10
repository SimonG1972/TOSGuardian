// tests/run_golden.js
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

const API = 'http://localhost:3000/api/check';
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden.json'), 'utf8'));

const rank = { red: 3, yellow: 2, green: 1 };

async function check(platform, text) {
  // Pick the most common primary field per platform
  const fields =
    platform === 'tiktok' ? { caption: text } :
    platform === 'youtube' ? { description: text, title: 'Test' } :
    platform === 'amazon' ? { description: text, title: 'Test' } :
    platform === 'shopify' ? { description: text, title: 'Test' } :
    platform === 'pinterest' ? { description: text, title: 'Test' } :
    /* etsy */               { description: text, title: 'Test' };

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, fields, strictMode: false, saveReceipts: false })
  });
  if (!res.ok) throw new Error(`${platform} HTTP ${res.status}`);
  return res.json();
}

(async () => {
  const results = [];
  let fails = 0;

  for (const [platform, cases] of Object.entries(GOLDEN)) {
    for (const tc of cases) {
      try {
        const out = await check(platform, tc.text);
        const got = out.level || 'unknown';
        const pass = rank[got] >= rank[tc.expect]; // allow stricter-than-expected
        if (!pass) fails++;
        results.push({
          platform, text: tc.text, expect: tc.expect, got,
          issues: out.issues || [],
          model: out.model?.error ? `model_error:${out.model.error}` : out.model?.label || null
        });
        const status = pass ? 'PASS' : 'FAIL';
        console.log(`${status}  [${platform}]  expect=${tc.expect} got=${got}  :: ${tc.text}`);
      } catch (e) {
        fails++;
        console.log(`FAIL  [${platform}]  error=${e.message}  :: ${tc.text}`);
      }
    }
  }

  const reportDir = path.join(process.cwd(), 'data', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const fp = path.join(reportDir, `golden-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(fp, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nSummary: ${results.length - fails} passed / ${results.length} total`);
  console.log(`Report: ${fp}`);
})();
