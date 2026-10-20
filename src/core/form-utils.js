const cheerio = require('cheerio');

/**
 * Safely serializes an ASP.NET Core <form> element into URLSearchParams.
 * Only inspects fields INSIDE the target <form> (never stray inputs on the page).
 * Properly handles ASP.NET Core checkbox + hidden false pairs and custom field overrides.
 */
function serializeAspNetForm($, formEl, fieldOverrides = {}) {
  if (!formEl || formEl.length === 0) {
    throw new Error('Форма редагування не знайдена на сторінці School-Today.');
  }

  const params = new URLSearchParams();
  const handledCheckboxes = new Set();

  formEl.find('input, textarea, select').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name) return;

    const tag = (el.tagName || '').toLowerCase();
    const type = ($el.attr('type') || '').toLowerCase();

    if (type === 'file' || type === 'submit' || type === 'button' || type === 'image') {
      return;
    }

    const hasOverride = Object.prototype.hasOwnProperty.call(fieldOverrides, name);

    if (type === 'checkbox') {
      handledCheckboxes.add(name);
      const isChecked = hasOverride ? Boolean(fieldOverrides[name]) : $el.is(':checked');
      if (isChecked) {
        const val = $el.attr('value') || 'true';
        params.append(name, val);
      }
      return;
    }

    if (type === 'hidden' && handledCheckboxes.has(name)) {
      // ASP.NET Core hidden fallback for checkbox
      params.append(name, 'false');
      return;
    }

    if (type === 'radio') {
      if (hasOverride) {
        if (String($el.val()) === String(fieldOverrides[name])) {
          params.append(name, String(fieldOverrides[name]));
        }
      } else if ($el.is(':checked')) {
        params.append(name, $el.val() || '');
      }
      return;
    }

    let val = hasOverride ? fieldOverrides[name] : ($el.val() ?? '');
    if (val === null || val === undefined) val = '';
    params.append(name, String(val));
  });

  // Also append any explicit overrides that were dynamically added (e.g. new columns)
  for (const [k, v] of Object.entries(fieldOverrides)) {
    if (!params.has(k) && !handledCheckboxes.has(k)) {
      params.append(k, v === null || v === undefined ? '' : String(v));
    }
  }

  return params;
}

/**
 * Checks an HTML response after a POST request for ASP.NET Core validation errors.
 */
function assertNoFormErrors(htmlData, contextLabel = 'Збереження форми') {
  if (typeof htmlData !== 'string' || !htmlData.trim()) return;
  const $ = cheerio.load(htmlData);
  const errors = [];

  $('.validation-summary-errors li, .field-validation-error').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) errors.push(t);
  });

  if (errors.length > 0) {
    throw new Error(`${contextLabel} відхилено сервером School-Today: ${errors.join('; ')}`);
  }
}

module.exports = {
  serializeAspNetForm,
  assertNoFormErrors
};
