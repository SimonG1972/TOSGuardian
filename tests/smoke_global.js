// tests/smoke_global.js
// Minimal smoke tests for global rules across platforms

const http = require('http');

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let buf = '';
        res.on('data', d => (buf += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function caseObj(platform, text, expect, extra = {}) {
  return { platform, fields: { description: text, ...extra }, expect, name: `${platform} :: ${text}` };
}

const CASES = [
  // --- Off-platform sales phrasing ---
  // Note: platform rule 'scam_signals' marks "DM me" as high severity -> red
  caseObj('instagram', 'DM me for price', 'red'),
  caseObj('facebook', 'Pay outside the platform', 'yellow'),
  caseObj('tiktok', 'Nice ceramic mug', 'green'),

  // --- Off-platform links (HIGH => red) ---
  caseObj('instagram', 'Check our channel https://t.me/deals123', 'red'),
  caseObj('facebook', 'Message us at https://wa.me/123456789', 'red'),
  caseObj('pinterest', 'Our catalog: https://example.com/shop', 'green'),

  // --- Exaggerated / Misleading (MEDIUM => yellow) ---
  caseObj('shopify', '100% guaranteed results', 'yellow'),
  caseObj('etsy', 'Instant results no risk', 'yellow'),
  caseObj('amazon', 'Relaxing lo-fi beats', 'green'),

  // --- Earnings / Get-Rich-Quick (HIGH => red) ---
  caseObj('instagram', 'Make $500 a day passively', 'red'),
  caseObj('facebook', 'Guaranteed profits with zero experience', 'red'),
  caseObj('tiktok', 'Handmade soap gift set', 'green'),

  // --- Giveaway / Prize scams (HIGH => red) ---
  caseObj('instagram', 'Tag 3 friends to win!', 'red'),
  caseObj('facebook', 'DM us to claim your prize', 'red'),
  caseObj('etsy', 'Beautiful handmade mug', 'green'),

  // --- Fake engagement / Bot-bait (MEDIUM => yellow) ---
  caseObj('instagram', 'Like & share to boost this post', 'yellow'),
  caseObj('tiktok', "Comment 'done' after sharing", 'yellow'),
  caseObj('pinterest', 'Cozy fall decor ideas', 'green'),

  // --- Scarcity / Urgency (MEDIUM => yellow) ---
  caseObj('shopify', 'Only 2 left in stock', 'yellow'),
  caseObj('amazon', 'Limited time offer ends tonight', 'yellow'),
  caseObj('etsy', 'Minimalist print for bedroom', 'green'),

  // --- Before/After (HIGH => red) ---
  caseObj('instagram', 'Before & after results in 7 days', 'red'),
  caseObj('facebook', 'Visible results in 2 weeks', 'red'),
  caseObj('tiktok', 'Handmade ceramic mug', 'green'),

  // --- Impersonation / Fake support (HIGH => red) ---
  caseObj('instagram', 'Verify your account here', 'red'),
  caseObj('facebook', 'Your account will be suspended, appeal now', 'red'),
  caseObj('youtube', 'Relaxing lo-fi beats', 'green'),

  // --- Crypto / Forex hype (MEDIUM => yellow) ---
  caseObj('instagram', 'Crypto signals group: 100x coin', 'yellow'),
  caseObj('facebook', 'Pump signals available', 'yellow'),
  caseObj('tiktok', 'Stainless steel water bottle', 'green'),

  // --- Adult / NSFW promo (platform NSFW rule is high => red) ---
  caseObj('instagram', 'Link in bio for NSFW', 'red'),
  caseObj('instagram', 'Follow me on OnlyFans', 'yellow'),
  caseObj('facebook', 'Cozy fall decor ideas', 'green'),

  // --- Malware / Suspicious files (HIGH => red) ---
  caseObj('reddit', 'Download cheat aimbot.exe now', 'red'),
  caseObj('reddit', 'Free hack wallhack', 'red'),
  caseObj('reddit', 'Open-source tool on GitHub', 'green'),

  // --- Phishing language (HIGH => red) ---
  caseObj('linkedin', 'Click here to verify your identity', 'red'),
  caseObj('instagram', 'Reset your password using this link', 'red'),
  caseObj('facebook', 'New handmade mug drop', 'green'),

  // --- Rapid weight-loss / medical (HIGH => red) ---
  caseObj('instagram', 'Lose weight fast with this tea', 'red'),
  caseObj('instagram', 'Burn fat fast with this smoothie', 'red'),
  caseObj('facebook', 'Cures cancer', 'red'),
  caseObj('tiktok', 'Nice ceramic mug', 'green'),

  // --- Counterfeit / replica (HIGH => red) ---
  caseObj('amazon', 'Official replica designer bag', 'red'),
  caseObj('instagram', '1:1 replica shoes', 'red'),
  caseObj('etsy', 'Handmade mug', 'green')
];

(async () => {
  let pass = 0, fail = 0;

  for (const tc of CASES) {
    try {
      const { status, json } = await postJSON('/api/check', { platform: tc.platform, fields: tc.fields, strictMode: false });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const got = (json && typeof json.level === 'string') ? json.level : 'unknown';
      const ok = got === tc.expect;
      if (ok) {
        console.log(`PASS  [${tc.platform}] expect=${tc.expect} got=${got}  :: ${tc.name}`);
        pass++;
      } else {
        console.log(`FAIL  [${tc.platform}] expect=${tc.expect} got=${got}  :: ${tc.name}`);
        console.log('  issues:', json.issues);
        fail++;
      }
    } catch (e) {
      console.log(`ERROR [${tc.platform}] ${tc.name} :: ${e.message || e}`);
      fail++;
    }
  }

  console.log(`\nSummary: ${pass} passed / ${pass + fail} total`);
  if (fail > 0) process.exitCode = 1;
})();
