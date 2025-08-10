// public/app.js
(function () {
  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const on = (el, evt, fn) => el && el.addEventListener(evt, fn);
  const show = (el, yes) => el && el.classList.toggle('hide', !yes);
  const li = (t) => { const el = document.createElement('li'); el.textContent = t; return el; };
  const norm = (s) => (s || '').trim();

  // Make sure certain sections are visible even if CSS has :empty {display:none}
  function ensureVisible(...ids) {
    ids.forEach(id => {
      const el = $(id);
      if (!el) return;
      el.classList.remove('hide');
      el.style.display = 'block';
      // If it’s a UL/OL that’s empty, add a placeholder so :empty doesn’t hide it
      if ((el.tagName === 'UL' || el.tagName === 'OL') && el.children.length === 0) {
        const p = li('—');
        p.setAttribute('data-placeholder', 'true');
        el.appendChild(p);
      }
    });
  }

  const platformEl = document.querySelector('#platform');

  const ui = {
    themeName: $('themeName'),

    title: $('title'),
    description: $('description'),
    caption: $('caption'),
    link: $('link'),
    image: $('image'),
    strict: $('strictMode'),
    simpleAdvanced: $('simpleAdvanced'),

    labelTitle: $('labelTitle'),
    labelDescription: $('labelDescription'),
    labelCaption: $('labelCaption'),
    labelLink: $('labelLink'),
    helpTitle: $('helpTitle'),
    helpDesc: $('helpDescription'),

    linkWrap: $('linkWrap'),
    captionWrap: $('captionWrap'),
    imageWrap: $('imageWrap'),

    scanBtn: $('scanBtn'),
    runSpinner: $('runSpinner'),
    runSuccess: $('runSuccess'),

    status: $('status'),
    issues: $('issues'),
    fixes: $('fixes'),
    imageFindings: $('imageFindings'),
    model: $('model'),

    // rulebook
    rulePlatform: $('rulePlatform'),
    rbSummary: $('rbSummary'),
    rbToggle: $('rbToggle'),
    rbRefresh: $('rbRefresh'),
    rbEdit: $('rbEdit'),
    rbSave: $('rbSave'),
    rbCancel: $('rbCancel'),
    rulebookPre: $('rulebookPre'),
    rulebookText: $('rulebookText'),
    rulesViewWrap: $('rulesViewWrap'),
    rulesEditWrap: $('rulesEditWrap'),
  };

  const currentPlatform = () =>
    (platformEl && platformEl.value ? platformEl.value : 'instagram').toLowerCase();

  // ---------- presets ----------
  const presets = {
    youtube:  { titleMax:100,  descMax:5000, captionMax:0,    showLink:true,  showCaption:false,
      labels:{title:'Video title *', description:'Description *', link:'Video link (optional)'},
      helps: {title:'Max ~100 chars', description:'Avoid clickbait & medical claims'} },
    tiktok:   { titleMax:120,  descMax:2200, captionMax:0,    showLink:false, showCaption:false,
      labels:{title:'Post title *', description:'Post text *'},
      helps: {title:'Max ~120 chars', description:'Short, accurate, no prohibited claims'} },
    instagram:{ titleMax:120,  descMax:2200, captionMax:2200, showLink:false, showCaption:true,
      labels:{title:'Post title *', description:'Post body *', caption:'Caption (optional)'},
      helps: {title:'Max ~120 chars', description:'No medical claims or counterfeit sales'} },
    pinterest:{ titleMax:100,  descMax:500,  captionMax:500,  showLink:true,  showCaption:true,
      labels:{title:'Pin title *', description:'Pin description *', caption:'Alt text (optional)', link:'Destination URL'},
      helps: {title:'Keep it specific', description:'Be helpful; avoid spam/claims'} },
    facebook: { titleMax:120,  descMax:2000, captionMax:150,  showLink:true,  showCaption:true,
      labels:{title:'Post title *', description:'Post body *', caption:'Caption (optional)', link:'Link (optional)'},
      helps: {title:'Max 120 characters', description:'Keep it clear'} },
    x:        { titleMax:120,  descMax:280,  captionMax:0,    showLink:true,  showCaption:false,
      labels:{title:'Post title *', description:'Post text *', link:'Link (optional)'},
      helps: {title:'Max 120 characters', description:'Keep within ~280 chars'} },
    linkedin: { titleMax:120,  descMax:3000, captionMax:0,    showLink:true,  showCaption:false,
      labels:{title:'Post title *', description:'Post body *', link:'Link (optional)'},
      helps: {title:'Max 120 characters', description:'Professional tone recommended'} },
    reddit:   { titleMax:300,  descMax:40000,captionMax:0,    showLink:true,  showCaption:false,
      labels:{title:'Post title *', description:'Body *', link:'Link (optional)'},
      helps: {title:'Descriptive title', description:'Follow subreddit rules too'} },
    etsy:     { titleMax:140,  descMax:5000, captionMax:0,    showLink:false, showCaption:false,
      labels:{title:'Listing title *', description:'Listing description *'},
      helps: {title:'Max ~140 chars', description:'Add materials, sizing, shipping'} },
    shopify:  { titleMax:200,  descMax:2000, captionMax:0,    showLink:false, showCaption:false,
      labels:{title:'Product title *', description:'Product description *'},
      helps: {title:'Follow product title conventions', description:'No prohibited claims'} },
  };

  function applyPreset(p) {
    const key = (p || 'instagram').toLowerCase();
    const cfg = presets[key] || presets.instagram;

    if (ui.title) ui.title.maxLength = cfg.titleMax;
    if (ui.description) ui.description.maxLength = cfg.descMax;
    if (ui.caption) ui.caption.maxLength = cfg.captionMax;

    if (ui.labelTitle) ui.labelTitle.textContent = cfg.labels.title;
    if (ui.labelDescription) ui.labelDescription.textContent = cfg.labels.description;
    if (cfg.labels.caption && ui.labelCaption) ui.labelCaption.textContent = cfg.labels.caption;
    if (cfg.labels.link && ui.labelLink) ui.labelLink.textContent = cfg.labels.link;

    if (ui.helpTitle) ui.helpTitle.textContent = cfg.helps.title;
    if (ui.helpDesc) ui.helpDesc.textContent = cfg.helps.description;

    // respect platform capabilities + user "Advanced" toggle
    const platformSupportsLink = !!cfg.showLink;
    const platformSupportsCaption = !!cfg.showCaption;
    const advancedOn = !!ui.simpleAdvanced?.checked;

    show(ui.linkWrap, advancedOn && platformSupportsLink);
    show(ui.captionWrap, advancedOn && platformSupportsCaption);
    show(ui.imageWrap, advancedOn);

    if (ui.rulePlatform) ui.rulePlatform.value = key;
    if (ui.themeName) ui.themeName.textContent = 'Light';
  }

  // ---------- UI state ----------
  function setStatus(level, msg) {
    const map = { green: 'status-pill green', yellow: 'status-pill yellow', red: 'status-pill red' };
    if (ui.status) {
      ui.status.className = map[level] || 'status-pill';
      ui.status.textContent = msg || (level ? level.toUpperCase() : '—');
    }
  }

  function clearLists() {
    if (ui.issues) ui.issues.innerHTML = '';
    if (ui.fixes) ui.fixes.innerHTML = '';
    if (ui.imageFindings) ui.imageFindings.innerHTML = '';
    if (ui.model) ui.model.textContent = '(none)';
  }

  function showScanning(isRunning) {
    if (ui.runSpinner) ui.runSpinner.style.display = isRunning ? '' : 'none';
    if (ui.runSuccess) ui.runSuccess.style.display = (!isRunning) ? '' : 'none';
    if (ui.scanBtn) ui.scanBtn.disabled = !!isRunning;
  }

  // ---------- payload ----------
  function buildPayload() {
    const platform = currentPlatform();
    const title = norm(ui.title?.value);
    const description = norm(ui.description?.value);
    const caption = norm(ui.caption?.value);
    const link = norm(ui.link?.value);
    const imageUrl = norm(ui.image?.value);
    const strict = !!ui.strict?.checked;

    const text = [title, description, caption].filter(Boolean).join('\n');

    return {
      platform,
      title,
      description,
      caption,
      link,
      imageUrl,
      strict,
      strictMode: strict, // alternate key some backends read
      text,
      fields: { title, description, caption, link, imageUrl }
    };
  }

  // ---------- scan ----------
  async function scan() {
    try {
      clearLists();
      setStatus(null, 'Checking…');
      showScanning(true);

      const payload = buildPayload();
      const url = `/api/check?platform=${encodeURIComponent(payload.platform)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let err = '';
        try { err = await res.text(); } catch {}
        throw new Error(`Check failed (${res.status})${err ? `: ${err}` : ''}`);
      }

      const data = await res.json().catch(() => ({}));

      const level = data.level || 'yellow';
      const msg = level === 'green' ? 'No critical issues'
              : level === 'yellow' ? 'Review suggested'
              : 'Action required';
      setStatus(level, msg);

      (data.issues || []).forEach(m => ui.issues && ui.issues.appendChild(li(m)));
      (data.fixes || []).forEach(m => ui.fixes && ui.fixes.appendChild(li(m)));
      (data.imageFindings || []).forEach(m => ui.imageFindings && ui.imageFindings.appendChild(
        li(`${m.severity || 'info'}: ${m.label || ''}${m.url ? ' [' + m.url + ']' : ''}`)
      ));

      // ✅ Guarantee visible results area even if lists are empty (handles :empty CSS)
      ensureVisible('results', 'analysis', 'outcome', 'issues', 'fixes');

      // Replace placeholders with clearer text if the lists are still empty
      if (ui.issues && ui.issues.children.length === 1 && ui.issues.firstElementChild?.dataset.placeholder) {
        ui.issues.firstElementChild.textContent = 'No issues found';
      }
      if (ui.fixes && ui.fixes.children.length === 1 && ui.fixes.firstElementChild?.dataset.placeholder) {
        ui.fixes.firstElementChild.textContent = 'No suggested fixes';
      }

      if (data.model && ui.model) {
        ui.model.textContent = data.model.rewrite
          ? `Rewrite: ${data.model.rewrite}`
          : (data.model.error ? `${data.model.name} error: ${data.model.error}` : data.model.name);
      }

      showScanning(false);
    } catch (e) {
      setStatus('red', 'Error: ' + (e?.message || String(e)));
      // keep results visible on failure too
      ensureVisible('results', 'analysis', 'outcome', 'issues', 'fixes');

      if (ui.issues && ui.issues.children.length === 0) {
        const p = li('No issues (request failed)');
        p.setAttribute('data-placeholder', 'true');
        ui.issues.appendChild(p);
      }
      if (ui.fixes && ui.fixes.children.length === 0) {
        const p = li('No fixes (request failed)');
        p.setAttribute('data-placeholder', 'true');
        ui.fixes.appendChild(p);
      }
      showScanning(false);
    }
  }

  // ---------- rulebook ----------
  let rulebookOpen = false;

  function setRulebookOpen(open) {
    rulebookOpen = !!open;

    if (rulebookOpen) {
      // Opening: show VIEW, hide EDIT
      show(ui.rulesEditWrap, false);
      show(ui.rulesViewWrap, true);
      ui.rbSave && ui.rbSave.classList.add('hide');
      ui.rbCancel && ui.rbCancel.classList.add('hide');
      ui.rbEdit && ui.rbEdit.classList.remove('hide');
    } else {
      // Closing: hide both, reset buttons
      show(ui.rulesViewWrap, false);
      show(ui.rulesEditWrap, false);
      ui.rbSave && ui.rbSave.classList.add('hide');
      ui.rbCancel && ui.rbCancel.classList.add('hide');
      ui.rbEdit && ui.rbEdit.classList.remove('hide');
    }

    if (ui.rbToggle) ui.rbToggle.textContent = rulebookOpen ? 'Collapse' : 'Expand';
  }

  function enterEdit(yes) {
    if (!rulebookOpen) setRulebookOpen(true);
    show(ui.rulesViewWrap, !yes);
    show(ui.rulesEditWrap, !!yes);
    show(ui.rbSave, !!yes);
    show(ui.rbCancel, !!yes);
    show(ui.rbEdit, !yes);
  }

  function summarizeRulebook(json) {
    try {
      const cats = Array.isArray(json.categories) ? json.categories.length : 0;
      const ver = json.version || '—';
      const updated = json.updated_at || '—';
      const plat = json.platform || currentPlatform();
      if (ui.rbSummary) ui.rbSummary.textContent = `${plat} • v${ver} • ${cats} categories • updated ${updated}`;
    } catch {
      if (ui.rbSummary) ui.rbSummary.textContent = '—';
    }
  }

  async function loadRulebook(p) {
    const platform = (p || currentPlatform()).toLowerCase();
    const res = await fetch(`/api/rules/${encodeURIComponent(platform)}`);
    if (!res.ok) throw new Error(`Failed to load rules for ${platform}`);
    const json = await res.json();
    if (ui.rulebookPre) ui.rulebookPre.textContent = JSON.stringify(json, null, 2);
    if (ui.rulebookText) ui.rulebookText.value = JSON.stringify(json, null, 2);
    summarizeRulebook(json);
  }

  async function saveRulebook() {
    try {
      const platform = (ui.rulePlatform?.value || currentPlatform()).toLowerCase();
      let parsed;
      try { parsed = JSON.parse(ui.rulebookText.value); }
      catch { alert('Invalid JSON.'); return; }
      const res = await fetch(`/api/rules/${encodeURIComponent(platform)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      await loadRulebook(platform);
      enterEdit(false);
    } catch (e) { alert(e?.message || String(e)); }
  }

  // ---------- wiring ----------
  function wire() {
    if (platformEl) {
      on(platformEl, 'change', () => {
        applyPreset(platformEl.value);
        loadRulebook(platformEl.value).catch(() => { if (ui.rbSummary) ui.rbSummary.textContent = '(rulebook not available)'; });
      });
      applyPreset(platformEl.value);
      loadRulebook(platformEl.value).catch(() => { if (ui.rbSummary) ui.rbSummary.textContent = '(rulebook not available)'; });
    } else {
      applyPreset('instagram');
      loadRulebook('instagram').catch(() => { if (ui.rbSummary) ui.rbSummary.textContent = '(rulebook not available)'; });
    }

    on(ui.simpleAdvanced, 'change', () => applyPreset(platformEl?.value || 'instagram'));
    on(ui.scanBtn, 'click', scan);

    if (ui.rulePlatform) on(ui.rulePlatform, 'change', () => loadRulebook(ui.rulePlatform.value));
    on(ui.rbRefresh, 'click', () => loadRulebook(ui.rulePlatform?.value || currentPlatform()));
    on(ui.rbToggle, 'click', () => setRulebookOpen(!rulebookOpen));
    on(ui.rbEdit, 'click', () => enterEdit(true));
    on(ui.rbCancel, 'click', () => enterEdit(false));
    on(ui.rbSave, 'click', saveRulebook);

    // Start collapsed; Playwright will click #rbToggle when needed.
    setRulebookOpen(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
