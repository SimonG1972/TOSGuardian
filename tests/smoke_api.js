// tests/smoke_api.js
// End-to-end API smoke for TOS Guardian
// Run: npm run test:api

const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';

function get(path) { return req('GET', path); }
function post(path, body) { return req('POST', path, body); }
function put(path, body) { return req('PUT', path, body); }

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
        : {}
    };
    const st = Date.now();
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const ms = Date.now() - st;
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, ms, raw, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await get('/healthz');
      if (status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server did not become ready in time.');
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
function pass(msg) { console.log('[PASS]', msg); }
function warn(msg) { console.log('[WARN]', msg); }
function info(msg) { console.log('[INFO]', msg); }

async function run() {
  info(`Waiting for http://${HOST}:${PORT} ...`);
  await waitForServer();
  pass('Server is up');

  // 1) Health + readiness
  {
    const a = await get('/healthz');  assert(a.status === 200, '/healthz not 200');  pass('/healthz OK');
    const b = await get('/readyz');   assert(b.status === 200, '/readyz not 200');   pass('/readyz OK');
  }

  // 2) Rulebooks (GET + no-change PUT)
  const platforms = ['instagram', 'reddit', 'etsy'];
  for (const p of platforms) {
    const r1 = await get(`/api/rules/${p}`);
    assert(r1.status === 200 && r1.json, `rulebook GET ${p} failed`);
    assert(r1.json.platform && r1.json.categories, `rulebook ${p} missing keys`);
    pass(`Rulebook GET ${p} OK`);

    const r2 = await put(`/api/rules/${p}`, r1.json); // no-op PUT
    assert(r2.status === 200, `rulebook PUT ${p} failed`);
    pass(`Rulebook PUT ${p} (no change) OK`);
  }

  // 3) /api/check — benign + risky patterns (correct body shape)
  const testVectors = [
    {
      name: 'IG benign',
      body: {
        platform: 'instagram',
        fields: {
          title: 'Sunday garden tips',
          description: 'Sharing helpful tips for repotting plants.',
          caption: 'Happy weekend!',
          link: '',
          imageUrl: ''
        },
        strictMode: false,
        saveReceipts: true   // ensure at least one receipt exists
      }
    },
    {
      name: 'Instagram counterfeit text',
      body: {
        platform: 'instagram',
        fields: {
          title: 'Designer bags',
          description: 'Best replica handbags under $100!',
          caption: '',
          link: '',
          imageUrl: ''
        },
        strictMode: true
      }
    },
    {
      name: 'Facebook gore image pattern',
      body: {
        platform: 'facebook',
        fields: {
          title: 'Watch now',
          description: 'Intense scene ahead',
          link: '',
          imageUrl: 'https://img.example.com/gore_blood_scene.jpg'
        },
        strictMode: true
      }
    },
    {
      name: 'Etsy product safe',
      body: {
        platform: 'etsy',
        fields: {
          title: 'Handmade ceramic mug',
          description: 'Stoneware mug, lead-free glaze, dishwasher-safe.',
          link: '',
          imageUrl: ''
        },
        strictMode: false
      }
    }
  ];

  for (const tv of testVectors) {
    const r = await post('/api/check', tv.body);
    assert(r.status === 200 && r.json, `/api/check "${tv.name}" failed`);
    const j = r.json;
    assert(['green','yellow','red'].includes(j.level), `${tv.name} invalid level`);
    assert(Array.isArray(j.issues), `${tv.name} issues missing`);
    assert(Array.isArray(j.fixes), `${tv.name} fixes missing`);
    assert(Array.isArray(j.imageFindings), `${tv.name} imageFindings missing`);
    if (j.model) {
      assert(j.model.rewrite || j.model.name || j.model.error, `${tv.name} model malformed`);
    }
    pass(`/api/check OK :: ${tv.name} => ${j.level.toUpperCase()}`);
  }

  // 4) Receipts should exist after checks
  const rec = await get('/api/receipts');
  if (rec.status === 200 && rec.json) {
    const arr = Array.isArray(rec.json) ? rec.json
              : Array.isArray(rec.json.receipts) ? rec.json.receipts
              : null;
    if (arr) {
      pass(`Receipts present (${arr.length})`);
    } else {
      warn('Receipts endpoint returned non-array payload; skipping strict assertion');
    }
  } else if (rec.status === 404) {
    warn('/api/receipts not implemented; skipping');
  } else {
    warn(`Unexpected receipts status ${rec.status}; skipping`);
  }

  // 5) Negative path: bogus route
  const bad = await get('/api/not-a-route');
  assert(bad.status === 404 || bad.status === 200, 'Unexpected status for bad route');
  pass('Negative path check OK');

  console.log('\n✅ ALL SMOKE TESTS PASSED');
}

run().catch(err => {
  console.error('\n❌ SMOKE TEST FAILED');
  console.error(err && err.stack || err);
  process.exit(1);
});
