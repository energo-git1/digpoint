// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      2.3.1
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
      el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:360px;color:#fff;cursor:pointer';
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg + '<br><small style="opacity:.6">(spausk uždaryti)</small>';
  }

  overlay('🔌 <b>Digpoint ESO v2.3.1</b> — jungiamasi...', '#6366f1');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── Laukia kol forma atsiranda DOM'e ────────────────────── */
  function waitForForm() {
    return new Promise(function (resolve) {
      if (document.querySelector('input[name="obj_address"]')) { resolve(); return; }
      var timeout = setTimeout(function () { observer.disconnect(); resolve(); }, 120000);
      var observer = new MutationObserver(function () {
        if (document.querySelector('input[name="obj_address"]')) {
          clearTimeout(timeout); observer.disconnect(); resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  /* ── GM fetch helpers ────────────────────────────────────── */
  function gmJson(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 8000,
        onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('JSON parse error')); } },
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
        method: 'PUT', url: url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body), timeout: 8000,
        onload: function (r) { resolve(r); }, onerror: function () { resolve(null); }
      });
    });
  }

  function gmPost(url, body) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'POST', url: url, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body), timeout: 10000,
        onload: function (r) { resolve(r); }, onerror: function () { resolve(null); }
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
    } catch (e) { console.warn('[ESO] taskFromServer:', e); return null; }
  }

  async function markDone(permitId) {
    if (!permitId) return;
    try {
      var d = await gmJson(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
      await gmPut(API + '/api/store/kl-eso-tasks', { value: list.filter(function (t) { return t.permitId !== permitId; }) });
    } catch (e) { console.warn('[ESO] Eilės klaida:', e); }
    try {
      await gmPost(API + '/api/permits/' + permitId + '/status',
        { status: 'Pateikta', note: 'ESO paraiška pateikta automatiškai' });
      console.log('[ESO] Statusas → Pateikta');
    } catch (e) { console.warn('[ESO] Statuso klaida:', e); }
  }

  /* ── Angular ─────────────────────────────────────────────── */
  function findScope() {
    var names = ['obj_address', 'acceptance_email', 'excavation_start', 'legal_company_name'];
    for (var i = 0; i < names.length; i++) {
      var el = document.querySelector('input[name="' + names[i] + '"]');
      if (!el) continue;
      var s = angular.element(el).scope();
      while (s) { if (s.postData) return s; s = s.$parent; }
    }
    return null;
  }

  function setAngularField(name, val) {
    var el = document.querySelector('input[name="' + name + '"], textarea[name="' + name + '"]');
    if (!el) { console.warn('[ESO] Laukas nerastas:', name); return false; }
    try {
      var $el = angular.element(el);
      $el.val(val); $el.triggerHandler('input'); $el.triggerHandler('change');
      return true;
    } catch (e) { console.warn('[ESO] setAngularField(' + name + '):', e); return false; }
  }

  /* ── Savivaldybė — iš PDF arba adresas ──────────────────── */

  // 1. Klausia serverio ištraukti savivaldybę iš PDF
  async function getMunFromPdf(task) {
    if (!task.files || task.files.length === 0) return null;
    var pdfs = task.files.filter(function (f) { return f.url || f.filename; });
    if (pdfs.length === 0) return null;
    try {
      var pf = pdfs[0];
      var r = await gmPost(API + '/api/extract-municipality', {
        url: pf.url || null, filename: pf.filename || null
      });
      if (r && r.responseText) {
        var d = JSON.parse(r.responseText);
        if (d.municipality) { console.log('[ESO] PDF savivaldybė:', d.municipality); return d.municipality; }
        if (d.error) console.warn('[ESO] PDF mun klaida:', d.error);
      }
    } catch (e) { console.warn('[ESO] getMunFromPdf:', e); }
    return null;
  }

  // 2. Ištraukia savivaldybę iš teksto
  function munFromText(text) {
    if (!text) return null;
    var m = text.match(/[^\s,\.()]+(?:\s+[^\s,\.()]+)?\s+[rm]\.\s*sav\./i);
    if (m) return m[0].trim().replace(/\s+/g, ' ');
    var m2 = text.match(/[^\s,\.()]{4,}\s+sav\./i);
    if (m2) return m2[0].trim();
    return null;
  }

  // 3. Randa savivaldybių select'ą (ieško pagal opcijų turinį)
  function findMunSelect() {
    // Bandome selektorius
    var sel = document.querySelector('select#obj_municipality')
           || document.querySelector('select[name="obj_municipality"]')
           || document.querySelector('select[ng-model="postData.obj_municipality"]')
           || document.querySelector('select[ng-model*="municipality"]');
    if (sel) { console.log('[ESO] Select rastas selektoriumi, ng-model:', sel.getAttribute('ng-model')); return sel; }

    // Ieškome pagal opcijų turinį — savivaldybės visada turi "sav."
    var allSels = Array.from(document.querySelectorAll('select'));
    console.log('[ESO] Visi select elementai puslapyje:', allSels.length);
    allSels.forEach(function(s, i) {
      console.log('[ESO]   select[' + i + ']: id=' + s.id + ' name=' + s.name + ' ng-model=' + s.getAttribute('ng-model') + ' opcijų=' + s.options.length);
    });

    sel = allSels.find(function(s) {
      return Array.from(s.options).some(function(o) { return o.text.indexOf('sav.') !== -1; });
    });
    if (sel) { console.log('[ESO] Select rastas pagal "sav." opcijas, opcijų:', sel.options.length); return sel; }

    // Paskutinis bandymas: select su >15 opcijų
    sel = allSels.find(function(s) { return s.options.length > 15; });
    if (sel) { console.log('[ESO] Select rastas pagal opcijų kiekį:', sel.options.length); }
    return sel || null;
  }

  // 4. Ieško atitinkančios opcijos
  function findMunOption(sel, mun) {
    if (!mun) return null;
    var opts = Array.from(sel.options);
    var munL = mun.toLowerCase().replace(/\s+/g, ' ');

    var opt = opts.find(function(o) { return o.text.toLowerCase().replace(/\s+/g, ' ') === munL; });
    if (opt) return opt;

    var isM = /\bm\b/i.test(mun);
    var isR = /\br\b/i.test(mun);
    var word1 = munL.split(/\s+/)[0];
    opt = opts.find(function(o) {
      var t = o.text.toLowerCase();
      if (t.indexOf(word1) === -1) return false;
      if (isM) return t.indexOf(' m.') !== -1;
      if (isR) return t.indexOf(' r.') !== -1;
      return true;
    });
    if (opt) return opt;

    opt = opts.find(function(o) { return o.text.toLowerCase().indexOf(word1.slice(0, 5)) !== -1; });
    return opt || null;
  }

  // Pagrindinis savivaldybės nustatymas
  async function setMunicipality(scope, task) {
    var sel = findMunSelect();
    if (!sel) { console.warn('[ESO] Savivaldybės select NERASTAS'); return; }

    // Prioritetai: PDF → task.municipality → task.location
    var mun = await getMunFromPdf(task);
    if (!mun) mun = task.municipality || munFromText(task.location);
    console.log('[ESO] Ieškoma savivaldybė:', mun || '(nerasta — bus Kauno m.)');

    var opt = findMunOption(sel, mun);
    if (!opt) {
      opt = Array.from(sel.options).find(function(o) { return o.text.indexOf('Kauno m') !== -1; });
      if (mun) console.warn('[ESO] "' + mun + '" nerasta dropdown\'e, naudojama Kauno m.');
    }
    if (!opt) { console.warn('[ESO] Nė viena savivaldybė nerasta'); return; }

    console.log('[ESO] Savivaldybė → "' + opt.text + '" (value=' + opt.value + ')');

    // Nustatome ir DOM reikšmę, ir Angular scope
    sel.value = opt.value;
    try { scope.$apply(function() { scope.postData.obj_municipality = opt.value; }); }
    catch (e) { scope.postData.obj_municipality = opt.value; }
    // Trigeriname Angular change event
    var $sel = angular.element(sel);
    $sel.triggerHandler('change');
    $sel.triggerHandler('input');
  }

  /* ── PDF įkėlimas ────────────────────────────────────────── */
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
        var fname = pf.name || pf.filename || ('kasimo_leidimas_' + i + '.pdf');
        dt.items.add(new File([blob], fname, { type: 'application/pdf' }));
        console.log('[ESO] PDF OK:', fname, blob.size, 'bytes');
      } catch (e) { console.warn('[ESO] PDF fetch:', e.message); }
    }

    if (dt.files.length === 0) {
      overlay('⚠️ PDF nepavyko gauti — įkelkite rankiniu būdu', '#d97706');
      await sleep(3000); return;
    }

    var fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      overlay('⚠️ File input nerastas', '#d97706'); await sleep(2000); return;
    }
    try { fileInput.files = dt.files; } catch (e) { console.warn('[ESO] files assign:', e); }
    try { angular.element(fileInput).triggerHandler('change'); } catch (e) { }
    try { angular.element(fileInput).triggerHandler('input'); } catch (e) { }
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    try { var fs = angular.element(fileInput).scope(); if (fs) { try { fs.$apply(); } catch (e) { } } } catch (e) { }
    await sleep(800);
  }

  /* ── Navigacija (bando auto, neblokuoja) ─────────────────── */
  async function tryAutoNavigate() {
    if (document.querySelector('input[name="obj_address"]')) return;
    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(300); }

    // Ieškome "ESO rangovas" elemento
    var rangovasEl = null;
    var allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p,label'));
    for (var i = 0; i < allEls.length; i++) {
      if (allEls[i].childElementCount === 0 &&
          allEls[i].textContent.trim().indexOf('ESO rangovas') !== -1) {
        rangovasEl = allEls[i]; break;
      }
    }

    var clicked = false;
    if (rangovasEl) {
      var par = rangovasEl.parentElement;
      for (var d = 0; d < 10 && par; d++) {
        var btn = Array.from(par.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === 'Toliau'; });
        if (btn) { btn.click(); clicked = true; console.log('[ESO] Auto-click Toliau depth=' + d); break; }
        par = par.parentElement;
      }
    }
    if (!clicked) {
      var allBtns = Array.from(document.querySelectorAll('button')).filter(function (b) { return b.textContent.trim() === 'Toliau'; });
      if (allBtns.length > 0) {
        var t = allBtns.length >= 3 ? allBtns[2] : allBtns[allBtns.length - 1];
        t.click(); console.log('[ESO] Fallback Toliau idx', allBtns.indexOf(t));
      }
    }
  }

  /* ── Formos užpildymas ───────────────────────────────────── */
  async function fill(task) {
    var scope = findScope();
    if (!scope) { overlay('❌ Angular scope nerastas', '#dc2626'); return; }

    overlay('✍️ Pildomi laukai...', '#2563eb');
    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s+/g, '').trim();
    console.log('[ESO] Duomenys:', { manager: task.manager, phone: phone, location: task.location, investNo: task.investNo, municipality: task.municipality });

    try {
      scope.$apply(function () {
        scope.postData.legal_company_name          = 'EnergoLT';
        scope.postData.legal_manager_name          = task.manager || '';
        scope.postData.legal_manager_phone         = phone;
        scope.postData.acceptance_email            = task.email || '';
        scope.postData.obj_address                 = task.location || '';
        scope.postData.excavation_purpose          = 'Elektros tinklų įrengimas';
        scope.postData.excavation_start            = task.startDate || '';
        scope.postData.excavation_end              = task.endDate || '';
        scope.postData.excavation_link             = '';
        scope.postData.technical_eso_investment_nr = task.investNo || '';
        scope.postData.agree_to_terms              = true;
      });
    } catch (e) { console.warn('[ESO] $apply:', e.message); }

    await sleep(200);
    setAngularField('legal_company_name',          'EnergoLT');
    setAngularField('legal_manager_name',          task.manager || '');
    setAngularField('legal_manager_phone',         phone);
    setAngularField('acceptance_email',            task.email || '');
    setAngularField('obj_address',                 task.location || '');
    setAngularField('excavation_purpose',          'Elektros tinklų įrengimas');
    setAngularField('excavation_start',            task.startDate || '');
    setAngularField('excavation_end',              task.endDate || '');
    setAngularField('technical_eso_investment_nr', task.investNo || '');

    await sleep(200);

    // Savivaldybė — tikrina PDF, tada adresą
    await setMunicipality(scope, task);

    await sleep(200);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    if (task.files && task.files.length > 0) await uploadPdf(task);

    window.scrollTo(0, 0);
    await markDone(task.permitId);

    var phoneEl  = document.querySelector('input[name="legal_manager_phone"]');
    var selEl    = document.querySelector('select#obj_municipality') || document.querySelector('select[name="obj_municipality"]');
    var munText  = selEl ? (selEl.options[selEl.selectedIndex] || {}).text || '?' : '?';

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:11px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">📞 ' + (phoneEl ? phoneEl.value : '?') +
        ' · 🏛 ' + munText + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">' +
        (task.investNo ? '🔢 ' + task.investNo : '⚠️ Inv. nr. nėra') +
        ' · ' + (task.files && task.files.length > 0 ? '📎 PDF' : '⚠️ Nėra PDF') + '</span><br>' +
      '<span style="font-size:10px;opacity:.7">Patikrinkite ir spauskite <b>Siųsti</b></span>',
      '#059669'
    );
  }

  /* ── Main ────────────────────────────────────────────────── */
  async function main() {
    await sleep(1200);
    var hashTask = taskFromHash();
    var task = await taskFromServer();
    if (!task && hashTask) task = hashTask;

    if (!task) {
      overlay('ℹ️ Nėra ESO užduočių.<br><small>Digpoint\'e spauskite "🚀 Pateikti ESO"</small>', '#6b7280');
      setTimeout(function () { var e = document.getElementById('dp-eso'); if (e) e.remove(); }, 7000);
      return;
    }

    console.log('[ESO] Rasta užduotis:', { permitId: task.permitId, manager: task.manager, municipality: task.municipality, files: (task.files || []).length });

    overlay(
      '📋 <b>' + (task.location || task.manager || 'Rasta užduotis') + '</b>' +
      '<br><small style="opacity:.8">Inv: ' + (task.investNo || '⚠️ nėra') + '</small>' +
      '<br><small style="opacity:.6">⏳ Laukiama formos...</small>',
      '#1a56db'
    );

    await tryAutoNavigate();

    overlay(
      '⏳ <b>Laukiama ESO rangovas formos...</b>' +
      '<br><small style="opacity:.7">Spauskite ESO rangovas → Toliau</small>',
      '#1a56db'
    );

    await waitForForm();
    await sleep(400);
    await fill(task);
  }

  main();
})();
