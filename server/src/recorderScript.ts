/**
 * Browser-side capture script, injected into every page during a recording via
 * `context.addInitScript`. It listens for the user's interactions and reports
 * each one — with several selector candidates and a human-readable intent — back
 * to Node through the `__a_flow_runner_record` binding.
 *
 * Kept as a plain string so DOM types don't leak into the Node server package.
 * Password fields are reported with `isPassword: true` and NO value, so secrets
 * are never captured; the Node side turns them into `requiresHumanInput` steps.
 */
export const RECORDER_SCRIPT = String.raw`
(() => {
  if (window.__usInstalled) return;
  window.__usInstalled = true;

  const DATA_ATTRS = ['data-testid','data-test','data-test-id','data-qa','data-cy','data-attr'];
  const EDITABLE = ['text','email','search','url','tel','password','number','date','time'];

  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  function accessibleName(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph.trim();
    if (el.id) {
      const lab = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (lab && lab.innerText) return lab.innerText.trim();
    }
    const closestLabel = el.closest && el.closest('label');
    if (closestLabel && closestLabel.innerText) return closestLabel.innerText.trim();
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) return el.value.trim();
    const t = (el.innerText || el.textContent || '').trim();
    if (t) return t.replace(/\s+/g, ' ');
    const nm = el.getAttribute && el.getAttribute('name');
    return nm || '';
  }

  function roleFor(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (EDITABLE.includes(t)) return 'textbox';
    }
    return '';
  }

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  // An id can be unique yet UNSTABLE — frameworks generate fresh ids every page
  // load (jQuery datepicker "dp1782617930801", React ":r3:", MUI "mui-42", uuids,
  // hex blobs). Those make selectors that break on reload, so we don't trust them.
  function looksGeneratedId(id) {
    if (!id) return true;
    if (/\d{4,}/.test(id)) return true; // long digit runs (timestamps/counters)
    if (/^[.:]?r[a-z0-9]+[.:]?$/i.test(id)) return true; // React useId
    if (/^(dp|ember|ext-gen|ng-|radix-|headlessui-|rc_|cdk-|tippy-|popup-|uid-|uuid|gwt-|yui_|mui-|mat-|p-|svelte-|v-)/i.test(id)) return true;
    if (/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}/i.test(id)) return true; // uuid-ish
    if (/^[a-f0-9]{10,}$/i.test(id)) return true; // hex blob
    return false;
  }

  const stableId = (el) => (el.id && !looksGeneratedId(el.id) ? el.id : null);

  // A full :nth-child path is unique by construction (anchored at a stable id or the root).
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const sid = stableId(node);
      if (sid && isUnique('#' + esc(sid))) { parts.unshift('#' + esc(sid)); break; }
      const parent = node.parentElement;
      let part = node.tagName.toLowerCase();
      if (parent) {
        const idx = Array.prototype.indexOf.call(parent.children, node) + 1;
        part += ':nth-child(' + idx + ')';
      }
      parts.unshift(part);
      if (!parent) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  function genSelectors(el) {
    const out = [];
    const seen = new Set();
    const push = (selector, kind) => { if (selector && !seen.has(selector)) { seen.add(selector); out.push({ selector, kind }); } };
    // Attribute/id/name/placeholder candidates are only worth recording if they
    // identify exactly one element in the current DOM — otherwise replay collides.
    const pushUnique = (selector, kind) => { if (isUnique(selector)) push(selector, kind); };

    for (const a of DATA_ATTRS) {
      const v = el.getAttribute(a);
      if (v) pushUnique('[' + a + '=' + JSON.stringify(v) + ']', 'data');
    }
    if (stableId(el)) pushUnique('#' + esc(el.id), 'css');
    const nm = el.getAttribute('name');
    if (nm) pushUnique(el.tagName.toLowerCase() + '[name=' + JSON.stringify(nm) + ']', 'css');
    const ph = el.getAttribute('placeholder');
    if (ph) pushUnique('[placeholder=' + JSON.stringify(ph) + ']', 'css');

    const role = roleFor(el);
    const name = accessibleName(el);
    if (role && name && name.length <= 60) push('role=' + role + '[name=' + JSON.stringify(name) + ']', 'role');
    if (name && name.length <= 40 && (role === 'button' || role === 'link')) push('text=' + JSON.stringify(name), 'text');

    // Guaranteed-unique structural fallback, so there is always a working selector.
    push(cssPath(el), 'css');
    return out;
  }

  function intentFor(action, el, role, name) {
    const what = name ? '"' + name + '"' : (role || el.tagName.toLowerCase());
    if (action === 'click') return 'click ' + what;
    if (action === 'fill') return 'fill ' + what;
    if (action === 'select') return 'select option in ' + what;
    return action + ' ' + what;
  }

  const report = (payload) => { try { window.__a_flow_runner_record(payload); } catch (e) {} };

  document.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'file') return; // file pickers can't be replayed via click
      // We DO record clicks on text inputs: clicking a field can be the action
      // itself (opening a datepicker, dropdown, or autocomplete). When the user
      // then types, the Node side collapses this click into the resulting fill.
    }
    const role = roleFor(el);
    const name = accessibleName(el);
    report({ kind: 'click', selectors: genSelectors(el), intent: intentFor('click', el, role, name) });
  }, true);

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    const role = roleFor(el);
    const name = accessibleName(el);
    if (tag === 'select') {
      report({ kind: 'select', selectors: genSelectors(el), value: el.value, intent: intentFor('select', el, role, name) });
      return;
    }
    if (tag === 'input' || tag === 'textarea') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return; // the click handler captures toggles
      if (t === 'file') return; // file uploads can't be replayed with fill
      if (el.readOnly || el.disabled) return; // e.g. datepicker inputs — the click set the value
      const isPassword = t === 'password';
      report({
        kind: 'fill',
        selectors: genSelectors(el),
        value: isPassword ? undefined : (el.value || ''),
        isPassword,
        intent: intentFor('fill', el, role, name),
      });
    }
  }, true);
})();
`;
