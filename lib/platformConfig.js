// lib/platformConfig.js
const fs = require('fs');
const path = require('path');

let cache = null;

/** Minimal deep merge without extra deps */
function deepMerge(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) {
    return override.length ? override : base;
  }
  if (typeof base === 'object' && base && typeof override === 'object' && override) {
    const out = { ...base };
    for (const k of Object.keys(override)) {
      out[k] = deepMerge(base[k], override[k]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function loadConfig() {
  if (cache) return cache;
  const defaultPath = path.join(process.cwd(), 'config', 'platforms.json');
  const overrideFile = process.env.TOSGUARDIAN_PLATFORM_CONFIG; // optional external path

  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config/platforms.json: ${e.message}`);
  }

  if (overrideFile) {
    try {
      const extra = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      base = deepMerge(base, extra);
    } catch (e) {
      console.warn(`[platformConfig] Could not read override file ${overrideFile}: ${e.message}`);
    }
  }

  cache = base;
  return cache;
}

/**
 * Get merged config for a platform. Falls back to "default".
 * @param {string} platform
 * @returns {object}
 */
function get(platform) {
  const cfg = loadConfig();
  const defaults = cfg.default || {};
  if (!platform) return defaults;

  const lower = String(platform).toLowerCase();
  const specific = cfg[lower] || {};
  return deepMerge(defaults, specific);
}

module.exports = { get };
