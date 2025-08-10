// Property-based fuzz for /api/check using fast-check
const http = require('http');
const fc = require('fast-check');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const platforms = ['youtube','tiktok','instagram','pinterest','facebook','x','linkedin','reddit','etsy','shopify'];

const urlArb = fc.oneof(
  fc.constant(''),
  fc.webUrl(),                                   // valid URLs
  fc.string().map(s => `http://${s}.test`),      // randomish
  fc.constant('not-a-url'),
  fc.constant('ftp://example.com/file'),
  fc.constant('data:image/png;base64,iVBORw0KGgo=') // data URL
);

const textArb = fc.stringOf(fc.unicode(), { maxLength: 5000 }); // includes emoji/RTL
const titleArb = fc.stringOf(fc.unicode(), { maxLength: 400 });

const bodyArb = fc.record({
  platform: fc.constantFrom(...platforms),
  fields: fc.record({
    title: titleArb,
    description: textArb,
    caption: fc.oneof(fc.constant(''), titleArb),
    link: urlArb,
    imageUrl: urlArb
  }),
  strictMode: fc.boolean()
});

async function run() {
  // 200 random cases + boundary blasts
  await fc.assert(
    fc.asyncProperty(bodyArb, async (b) => {
      const r = await post('/api/check', b);
      // Server should never crash (500). 200 OK is ideal; 4xx acceptable for extreme bad inputs.
      if (r.status >= 500) {
        console.error('Server 5xx for payload:', JSON.stringify(b).slice(0, 1000));
      }
      if (r.status === 200) {
        // structure check
        const j = r.json;
        if (!j || !Array.isArray(j.issues) || !Array.isArray(j.fixes) || !Array.isArray(j.imageFindings)) {
          console.error('Malformed success payload:', j);
          return false;
        }
      }
      return r.status < 500;
    }),
    { numRuns: 200 }
  );

  // Boundary cases (very long / empty)
  const extremes = [
    {
      platform: 'reddit',
      fields: {
        title: 'x'.repeat(300),
        description: 'x'.repeat(40000),
        caption: '',
        link: '',
        imageUrl: ''
      },
      strictMode: true
    },
    {
      platform: 'instagram',
      fields: {
        title: '',
        description: '',
        caption: '',
        link: 'not-a-url',
        imageUrl: 'https://example.com/⚠️🔥🙂.png'
      },
      strictMode: false
    }
  ];

  for (const b of extremes) {
    const r = await post('/api/check', b);
    if (r.status >= 500) {
      throw new Error('5xx on boundary case: ' + JSON.stringify(b).slice(0, 300));
    }
  }

  console.log('✅ Fuzz tests passed (no 5xx, structure OK on 200s)');
}

run().catch(e => { console.error(e); process.exit(1); });
