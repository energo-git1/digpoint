// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.6.0
// @description  Automatiškai užpildo ESO kasimo leidimo formą iš Digpoint sistemos
// @author       EnergoLT
// @match        https://www.eso.lt/aktualios-formos/kasimo-darbai/*
// @grant        GM_xmlhttpRequest
// @connect      10.2.1.115
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  var API = 'http://10.2.1.115:3001';

  /* ── Overlay ─────────────────────────────────────────────── */
  function overlay(msg, color) {
    var el = document.getElementById('dp-eso');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dp-eso';
      el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:340px;color:#fff;cursor:pointer';
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg + '<br><small style="opacity:.6">(spausk uždaryti)</small>';
  }

  overlay('🔌 <b>Digpoint ESO v1.6</b> — jungiamasi...', '#6366f1');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── GM fetch helpers ────────────────────────────────────── */
  function gmJson(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 8000,
        onload: function (r) {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('JSON parse error')); }
        },
        onerror: function () { reject(new Error('Network error')); },
        ontimeout: function () { reject(new Error('Timeout')); }
      });
    });
  }

  function gmBlob(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob', timeout: 15000,
        onload: function (r) { resolve(r.response); },
        onerror: function () { reject(new Error('Blob fetch error')); },
        ontimeout: function () { reject(new Error('Timeout')); }
      });
    });
  }

  function gmPut(url, body) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'PUT', url: url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body), timeout: 8000,
        onload: function () { resolve(); },
        onerror: function () { resolve(); }
      });
    });
  }

  /* ── Gauti užduotį ───────────────────────────────────────── */
  function taskFromHash() {
    var m = window.location.hash.match(/dp=([A-Za-z0-9+\/=]+)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch (e) { return null; }
  }

  async function taskFromServer() {
    try {
      var d = await gmJson(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
      return list.filter(function (t) { return t.status === 'pending'; })[0] || null;
    } catch (e) { return null; }
  }

  async function removeTask(permitId) {
    try {
      var d = await gmJson(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : [];
      await gmPut(API + '/api/store/kl-eso-tasks',
        { value: list.filter(function (t) { return t.permitId !== permitId; }) });
    } catch (e) { }
  }

  /* ── Angular scope ───────────────────────────────────────── */
  function findScope() {
    var names = ['obj_address', 'acceptance_email', 'excavation_start'];
    for (var i = 0; i < names.length; i++) {
      var el = document.querySelector('input[name="' + names[i] + '"]');
      if (!el) continue;
      var s = angular.element(el).scope();
      while (s) { if (s.postData) return s; s = s.$parent; }
    }
    return null;
  }

  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality');
    if (!sel) return;
    var opt = Array.from(sel.options).find(function (o) { return o.text.indexOf('Kauno m') !== -1; });
    if (opt) scope.$apply(function () { scope.postData.obj_municipality = opt.value; });
  }

  /* ── PDF įkėlimas per DataTransfer ──────────────────────── */
  async function uploadPdf(task) {
    if (!task.files || task.files.length === 0) return;
    var pdfs = task.files.filter(function (f) { return f.url || f.filename; });
    if (pdfs.length === 0) return;

    overlay('📎 PDF įkeliamas...', '#7c3aed');

    var dt = new DataTransfer();
    for (var i = 0; i < pdfs.length; i++) {
      var pf = pdfs[i];
      var fileUrl = API + (pf.url || '/uploads/' + pf.filename);
      try {
        var blob = await gmBlob(fileUrl);
        dt.items.add(new File([blob], pf.name || 'kasimo_leidimas.pdf', { type: 'application/pdf' }));
      } catch (e) {
        console.warn('[ESO] PDF fetch failed:', e);
      }
    }

    if (dt.files.length === 0) {
      overlay('⚠️ PDF nepavyko įkelti — įkelkite rankiniu būdu', '#d97706');
      await sleep(3000);
      return;
    }

    // Randame brėžinių file input (pirmasis)
    var fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return;

    // Nustatome failus per DataTransfer
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Angular gali naudoti ng-change arba watcher — trigeriname
    try {
      var s = angular.element(fileInput).scope();
      if (s) s.$apply();
    } catch (e) { }

    await sleep(500);
  }

  /* ── ESO rangovas → Toliau ───────────────────────────────── */
  async function clickEsoRangovas() {
    if (document.querySelector('input[name="obj_address"]')) return;
    var btns = Array.from(document.querySelectorAll('button')).filter(function (b) {
      return b.textContent.trim() === 'Toliau';
    });
    if (btns.length === 0) return;
    var btn = btns.length >= 3 ? btns[2] : btns[btns.length - 1];
    btn.click();
    for (var i = 0; i < 12; i++) {
      await sleep(500);
      if (document.querySelector('input[name="obj_address"]')) break;
    }
  }

  /* ── Formos užpildymas ───────────────────────────────────── */
  async function fill(task) {
    overlay('⏳ Atidaroma ESO rangovas forma...', '#1a56db');

    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(300); }

    await clickEsoRangovas();

    var scope = findScope();
    if (!scope) {
      overlay('❌ Forma nerasta. Spauskite: ESO rangovas → Toliau', '#dc2626');
      return;
    }

    overlay('✍️ Pildomi laukai...', '#2563eb');

    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s/g, '').trim();

    scope.$apply(function () {
      scope.postData.legal_company_name = 'EnergoLT';
      scope.postData.legal_manager_name = task.manager || '';
      scope.postData.legal_manager_phone = phone;
      scope.postData.acceptance_email = task.email || '';
      scope.postData.obj_address = task.location || '';
      scope.postData.excavation_purpose = 'Elektros tinklų įrengimas';
      scope.postData.excavation_start = task.startDate || '';
      scope.postData.excavation_end = task.endDate || '';
      scope.postData.excavation_link = '';
      scope.postData.technical_eso_investment_nr = task.investNo || '';
      scope.postData.agree_to_terms = true;
    });

    setMunicipality(scope);

    await sleep(300);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    // PDF įkėlimas
    if (task.files && task.files.length > 0) {
      await uploadPdf(task);
    }

    window.scrollTo(0, 0);
    if (task.permitId) await removeTask(task.permitId);

    var pdfStatus = (task.files && task.files.length > 0) ? '📎 PDF įkeltas' : '⚠️ Nėra PDF failo';
    var invStatus = task.investNo ? '🔢 Inv. nr.: ' + task.investNo : '⚠️ Inv. nr. tuščias paraiškoje';

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:12px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:11px;opacity:.9">' + pdfStatus + ' · ' + invStatus + '</span><br>' +
      '<span style="font-size:11px;opacity:.7">Patikrinkite ir paspauskite <b>Siųsti</b></span>',
      '#059669'
    );
  }

  /* ── Main ────────────────────────────────────────────────── */
  async function main() {
    await sleep(1200);

    // Pirma hash (greita), tada serveris (pilni duomenys su failų URL)
    var hashTask = taskFromHash();
    var task = await taskFromServer(); // serveris turi failus

    // Jei serveris grąžino užduotį — naudojame ją (pilnesni duomenys)
    // Jei ne — naudojame hash
    if (!task && hashTask) task = hashTask;

    if (!task) {
      overlay('ℹ️ Nėra ESO užduočių.<br><small>Digpoint\'e spauskite "🚀 Pateikti ESO"</small>', '#6b7280');
      setTimeout(function () { var e = document.getElementById('dp-eso'); if (e) e.remove(); }, 7000);
      return;
    }

    overlay('📋 ' + (task.location || task.manager || 'Rasta užduotis'), '#1a56db');
    await sleep(400);
    await fill(task);
  }

  main();
})();
