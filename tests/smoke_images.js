// tests/smoke_images.js
// Image URL heuristics smoke tests for /api/check

const http = require('http');

function postJSON(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: 3000, path: '/api/check', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let buf = '';
        res.on('data', d => (buf += d));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Bad JSON: ' + buf)); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function expectCase({ platform, fields, expect, label }) {
  return postJSON({ platform, fields, scanImages: true })
    .then(resp => {
      const got = resp.level || 'unknown';
      const pass = got === expect;
      const findings = resp.imageFindings || [];
      const issues = resp.issues || [];
      const line = `${pass ? 'PASS' : 'FAIL'}  expect=${expect} got=${got}  :: ${platform} :: ${label}`;
      console.log(`[TEST] ${line}`);
      if (!pass) {
        console.log('[TEST]   issues:', issues.length ? issues : []);
        console.log('[TEST]   imageFindings:', findings.length ? findings : []);
      }
      return pass;
    })
    .catch(err => {
      console.log(`[TEST] ERROR  :: ${platform} :: ${label} :: ${err.message}`);
      return false;
    });
}

(async () => {
  const cases = [
    // High severity via NSFW token in URL
    {
      platform: 'instagram',
      label: 'New set :: https://cdn.example.com/nsfw_shoot_01.png',
      expect: 'red',
      fields: {
        caption: 'New set https://cdn.example.com/nsfw_shoot_01.png',
        image:   'https://cdn.example.com/nsfw_shoot_01.png'
      }
    },
    // High severity via gore/blood token in URL
    {
      platform: 'facebook',
      label: 'Watch now :: https://img.example.com/gore_blood_scene.jpg',
      expect: 'red',
      fields: {
        description: 'Watch now https://img.example.com/gore_blood_scene.jpg',
        image:       'https://img.example.com/gore_blood_scene.jpg'
      }
    },
    // Medium severity via counterfeit hints
    {
      platform: 'instagram',
      label: 'New drop :: https://img.example.com/handbag_1-1_replica.jpg',
      expect: 'red',
      fields: {
        caption: 'New drop https://img.example.com/handbag_1-1_replica.jpg',
        image:   'https://img.example.com/handbag_1-1_replica.jpg'
      }
    },
    // Medium severity via QR/scan-me hint
    {
      platform: 'instagram',
      label: 'Scan to win :: https://assets.example.com/scan_me_qr.png',
      expect: 'yellow',
      fields: {
        caption: 'Scan to win https://assets.example.com/scan_me_qr.png',
        image:   'https://assets.example.com/scan_me_qr.png'
      }
    },
    // Medium severity: image fetch will fail locally (no internet) => “Image fetch failed (non-blocking)”
    {
      platform: 'tiktok',
      label: 'Product photo :: https://images.example.com/product_clean.jpg',
      expect: 'yellow',
      fields: {
        description: 'Product photo https://images.example.com/product_clean.jpg',
        image:       'https://images.example.com/product_clean.jpg'
      }
    }
  ];

  let passCount = 0;
  for (const c of cases) {
    const ok = await expectCase(c);
    if (ok) passCount++;
  }

  console.log(`\n[TEST] Summary: ${passCount} passed / ${cases.length} total`);
  // Exit code 0 only if all passed
  process.exit(passCount === cases.length ? 0 : 1);
})();
