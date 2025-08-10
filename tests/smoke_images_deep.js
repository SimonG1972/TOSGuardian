// tests/smoke_images_deep.js
// Deep image tests: verifies URL extraction (strings, arrays, objects, multi-URL text, no-extension),
// local downloads, and heuristic flags (nsfw/gore/replica/qr + fetch-fail).

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = 'http://localhost:3000';
const API  = `${BASE}/api/check`;

const FIX_DIR = path.join(__dirname, 'fixtures');
const LOCAL = (name) => `${BASE}/tests/fixtures/${name}`;

// simple assertion helpers
function expectEqual(got, exp, label) {
  if (got !== exp) {
    throw new Error(`[FAIL] ${label} expected=${exp} got=${got}`);
  }
}

async function ensureFixtures() {
  if (!fs.existsSync(FIX_DIR)) fs.mkdirSync(FIX_DIR, { recursive: true });

  // small helper to make a tiny PNG/JPG
  async function makeImg(file, format = 'png', color = { r: 64, g: 64, b: 64 }) {
    const out = path.join(FIX_DIR, file);
    if (fs.existsSync(out)) return;

    const img = sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: color
      }
    });

    if (/\.(jpe?g)$/i.test(file)) {
      await img.jpeg({ quality: 80 }).toFile(out);
    } else {
      await img.png().toFile(out);
    }
  }

  // Filenames intentionally include tokens so URL-heuristics trip:
  await makeImg('nsfw_shoot_01.png', 'png', { r: 20, g: 20, b: 20 });
  await makeImg('gore_blood_scene.jpg', 'jpg', { r: 120, g: 0, b: 0 });
  await makeImg('handbag_1-1_replica.jpg', 'jpg', { r: 80, g: 80, b: 80 });
  await makeImg('scan_me_qr.png', 'png', { r: 200, g: 200, b: 200 });
  await makeImg('product_clean.jpg', 'jpg', { r: 180, g: 180, b: 180 });
  await makeImg('onlyfans_banner.png', 'png', { r: 160, g: 160, b: 160 });
  await makeImg('blood_scene.png', 'png', { r: 130, g: 10, b: 10 });
}

async function runCase({ platform, fields, expect, label }) {
  try {
    const res = await axios.post(API, {
      platform,
      fields,
      scanImages: true,
      strictMode: false,
      saveReceipts: false
    }, { timeout: 8000 });

    const { level, issues = [], imageFindings = [] } = res.data || {};

    const summary = `expect=${expect} got=${level}  :: ${platform} :: ${label}`;
    if (level !== expect) {
      console.log('[TEST] FAIL ', summary);
      console.log('[TEST]   issues:', issues);
      console.log('[TEST]   imageFindings:', imageFindings);
      return false;
    } else {
      console.log('[TEST] PASS ', summary);
      return true;
    }
  } catch (e) {
    console.log('[TEST] ERROR', label, e.message);
    return false;
  }
}

(async function main() {
  let passed = 0, total = 0;

  await ensureFixtures();

  const cases = [
    {
      label: `instagram :: URL string (nsfw) :: ${LOCAL('nsfw_shoot_01.png')}`,
      platform: 'instagram',
      fields: { caption: 'New set', image: LOCAL('nsfw_shoot_01.png') },
      expect: 'red'
    },
    {
      label: `facebook :: URL string (gore) :: ${LOCAL('gore_blood_scene.jpg')}`,
      platform: 'facebook',
      fields: { description: 'Watch now', image: LOCAL('gore_blood_scene.jpg') },
      expect: 'red'
    },
    {
      // NOTE: "replica" may also be caught by your text rulebooks, so red is correct here.
      label: `instagram :: URL string (replica) :: ${LOCAL('handbag_1-1_replica.jpg')}`,
      platform: 'instagram',
      fields: { caption: 'New drop', image: LOCAL('handbag_1-1_replica.jpg') },
      expect: 'red'
    },
    {
      label: `instagram :: URL string (scan_me_qr) :: ${LOCAL('scan_me_qr.png')}`,
      platform: 'instagram',
      fields: { caption: 'Scan to win', image: LOCAL('scan_me_qr.png') },
      expect: 'yellow'
    },
    {
      // Clean local image should produce no image findings => green
      label: `tiktok :: clean local image :: ${LOCAL('product_clean.jpg')}`,
      platform: 'tiktok',
      fields: { caption: 'Product photo', image: LOCAL('product_clean.jpg') },
      expect: 'green'
    },

    // ---- Deep extraction paths ----

    // Array of images
    {
      label: `instagram :: fields.images array w/ onlyfans token`,
      platform: 'instagram',
      fields: {
        caption: 'Carousel',
        images: [
          LOCAL('product_clean.jpg'),
          LOCAL('onlyfans_banner.png') // should trigger NSFW/Adult (high)
        ]
      },
      expect: 'red'
    },

    // Object shape with url/src
    {
      label: `facebook :: nested media objects w/ blood token`,
      platform: 'facebook',
      fields: {
        description: 'Check pics',
        media: [
          { url: LOCAL('product_clean.jpg') },
          { src: LOCAL('blood_scene.png') } // should trigger violence (high)
        ]
      },
      expect: 'red'
    },

    // Multiple URLs inside a single string, only one with QR hint
    {
      label: `instagram :: multi-URL text (one QR)`,
      platform: 'instagram',
      fields: {
        caption: `See both:
          ${LOCAL('product_clean.jpg')}
          and ${LOCAL('scan_me_qr.png')}
        `
      },
      expect: 'yellow'
    },

    // No extension, but key name is image_url -> should be considered; also contains "onlyfans" in path
    {
      label: `instagram :: no-extension URL on image_url key + onlyfans token`,
      platform: 'instagram',
      fields: {
        caption: 'Teaser',
        image_url: `${BASE}/tests/fixtures/onlyfans_banner` // no .png, contains onlyfans -> red via URL-heuristics
      },
      expect: 'red'
    },

    // Non-image key with embedded image URL in text (should still be found because it ends with extension)
    {
      label: `tiktok :: caption contains embedded image URL with replica`,
      platform: 'tiktok',
      fields: {
        caption: `Look: ${LOCAL('handbag_1-1_replica.jpg')} now`
      },
      expect: 'red'
    }
  ];

  for (const c of cases) {
    total += 1;
    const ok = await runCase(c);
    if (ok) passed += 1;
  }

  console.log('\n[TEST] Summary:', `${passed} passed / ${total} total`);
  if (passed !== total) {
    process.exitCode = 1;
  }
})();
