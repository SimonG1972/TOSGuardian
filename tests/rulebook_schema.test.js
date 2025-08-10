// Validate platform rulebooks vs fragments with Ajv
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

const platformSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'rulebook.platform.schema.json'), 'utf8')
);
const fragmentSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'rulebook.fragment.schema.json'), 'utf8')
);

const validatePlatform = ajv.compile(platformSchema);
const validateFragment = ajv.compile(fragmentSchema);

const rulesDir = path.join(process.cwd(), 'rules');
const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));

let failed = 0;

for (const f of files) {
  const full = path.join(rulesDir, f);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));

  // Heuristic: platform files usually end with .v1.json (or .v2.json, etc.)
  const isPlatform = /\.v\d+\.json$/i.test(f);

  if (isPlatform) {
    const ok = validatePlatform(json);
    if (!ok) {
      console.error(`❌ ${f} (platform) schema errors:`);
      console.error(validatePlatform.errors);
      failed++;
    } else {
      console.log(`✅ ${f} OK (platform)`);
    }
  } else {
    // Fragments like shared.*.json, sources.json, etc.
    const ok = validateFragment(json);
    if (!ok) {
      console.error(`❌ ${f} (fragment) schema warnings:`);
      console.error(validateFragment.errors);
      // Don’t fail CI on fragments unless you want to be strict:
      // failed++;
    } else {
      console.log(`✅ ${f} OK (fragment)`);
    }
  }
}

if (failed) {
  console.error(`\n❌ Rulebook schema failures: ${failed}`);
  process.exit(1);
} else {
  console.log('\n✅ All platform rulebooks valid (fragments are lenient)');
}
