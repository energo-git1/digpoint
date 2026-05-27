// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      2.2.0
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

  overlay('🔌 <b>Digpoint ESO v2.2</b> — jungiamasi...', '#6366f1');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── Laukia kol forma atsiranda DOM'e ────────────────────── */
  // Naudoja MutationObserver — tikrina kol input[name="obj_address"] atsiranda.
  // Timeout: 120 sek. (2 min.) — pakankamai laiko rankiniam atidarymui.
  function waitForForm() {
    return new Promise(function (resolve) {
      // Jei jau yra — iš karto
      if (document.querySelector('input[name="obj_address"]')) {
        resolve(); return;
      }
      var timeout = setTimeout(function () {
        observer.disconnect();
        resolve(); // tęsiame net jei nepavyko rasti
      }, 120000);

      var observer = new MutationObserver(function () {
        if (document.querySelector('input[name="obj_address"]')) {
          clearTimeout(timeout);
          observer.disconnect();
          resolve();
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
        onload: function (r) { resolve(r); },
        onerror: function () { resolve(null); }
      });
    });
  }

  function gmPost(url, body) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'POST', url: url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body), timeout: 8000,
        onload: function (r) { resolve(r); },
        onerror: function () { resolve(null); }
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
      var pending = list.filter(function (t) { return t.status === 'pending'; });
      return pending[0] || null;
    } catch (e) {
      console.warn('[ESO] taskFromServer klaida:', e);
      return null;
    }
  }

  async function markDone(permitId) {
    if (!permitId) { console.warn('[ESO] markDone: permitId tuščias!'); return; }
    try {
      var d = await gmJson(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
      var remaining = list.filter(function (t) { return t.permitId !== permitId; });
      await gmPut(API + '/api/store/kl-eso-tasks', { value: remaining });
      console.log('[ESO] Eilė: liko', remaining.length);
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
      $el.val(val);
      $el.triggerHandler('input');
      $el.triggerHandler('change');
      return true;
    } catch (e) { console.warn('[ESO] setAngularField(' + name + '):', e); return false; }
  }

  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality')
           || document.querySelector('select[name="obj_municipality"]')
           || document.querySelector('select[ng-model*="municipality"]');
    if (!sel) {
      sel = Array.from(document.querySelectorAll('select')).find(function (s) {
        return Array.from(s.options).some(function (o) { return o.text.indexOf('Kauno') !== -1; });
      }) || null;
    }
    if (!sel) { console.warn('[ESO] Savivaldybės select nerastas'); return; }
    var opt = Array.from(sel.options).find(function (o) { return o.text.indexOf('Kauno m') !== -1; });
    if (!opt) { console.warn('[ESO] Kauno m opcija nerasta'); return; }
    console.log('[ESO] Savivaldybė → opt.value =', opt.value);
    try { scope.$apply(function () { scope.postData.obj_municipality = opt.value; }); }
    catch (e) { scope.postData.obj_municipality = opt.value; }
    angular.element(sel).triggerHandler('change');
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
      console.log('[ESO] Kraunamas:', fileUrl);
      try {
        var blob = await gmBlob(fileUrl);
        var fname = pf.name || pf.filename || ('kasimo_leidimas_' + i + '.pdf');
        dt.items.add(new File([blob], fname, { type: 'application/pdf' }));
        console.log('[ESO] PDF OK:', fname, blob.size, 'bytes');
      } catch (e) { console.warn('[ESO] PDF fetch klaida:', e.message); }
    }

    if (dt.files.length === 0) {
      overlay('⚠️ PDF nepavyko gauti — įkelkite rankiniu būdu', '#d97706');
      await sleep(3000); return;
    }

    var fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      console.warn('[ESO] input[type="file"] nerastas');
      overlay('⚠️ File input nerastas', '#d97706');
      await sleep(2000); return;
    }

    try { fileInput.files = dt.files; } catch (e) { console.warn('[ESO] files assign:', e); }
    try { angular.element(fileInput).triggerHandler('change'); } catch (e) { }
    try { angular.element(fileInput).triggerHandler('input'); } catch (e) { }
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      var fs = angular.element(fileInput).scope();
      if (fs) { try { fs.$apply(); } catch (e) { } }
    } catch (e) { }

    await sleep(800);
  }

  /* ── Navigacija (tik bandoma, neblokuoja) ────────────────── */
  async function tryAutoNavigate() {
    // Jei forma jau matoma — nieko nedaryti
    if (document.querySelector('input[name="obj_address"]')) return;

    // Slapukai
    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(300); }

    // Ieškome "ESO rangovas" bloko
    var allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p,label'));
    var rangovasEl = null;
    for (var i = 0; i < allEls.length; i++) {
      if (allEls[i].textContent.trim().indexOf('ESO rangovas') !== -1
          && allEls[i].childElementCount === 0) {
        rangovasEl = allEls[i]; break;
      }
    }

    var clicked = false;
    if (rangovasEl) {
      var par = rangovasEl.parentElement;
      for (var d = 0; d < 10 && par; d++) {
        var btn = Array.from(par.querySelectorAll('button')).find(function (b) {
          return b.textContent.trim() === 'Toliau';
        });
        if (btn) { btn.click(); clicked = true; console.log('[ESO] Auto-click Toliau (depth=' + d + ')'); break; }
        par = par.parentElement;
      }
    }
    if (!clicked) {
      var allBtns = Array.from(document.querySelectorAll('button')).filter(function (b) {
        return b.textContent.trim() === 'Toliau';
      });
      if (allBtns.length > 0) {
        var t = allBtns.length >= 3 ? allBtns[2] : allBtns[allBtns.length - 1];
        t.click();
        console.log('[ESO] Fallback Toliau idx', allBtns.indexOf(t));
      }
    }
  }

  /* ── Formos užpildymas ───────────────────────────────────── */
  async function fill(task) {
    var scope = findScope();
    if (!scope) {
      overlay('❌ Angular scope nerastas', '#dc2626'); return;
    }

    overlay('✍️ Pildomi laukai...', '#2563eb');
    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s+/g, '').trim();

    console.log('[ESO] Pildoma:', { manager: task.manager, phone: phone, location: task.location, investNo: task.investNo });

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
    setMunicipality(scope);
    await sleep(200);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    if (task.files && task.files.length > 0) await uploadPdf(task);

    window.scrollTo(0, 0);
    await markDone(task.permitId);

    var phoneEl  = document.querySelector('input[name="legal_manager_phone"]');
    var phoneVal = phoneEl ? phoneEl.value : '?';
    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:11px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">📞 ' + phoneVal +
        ' · ' + (task.files && task.files.length > 0 ? '📎 PDF įkeltas' : '⚠️ Nėra PDF') + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">' +
        (task.investNo ? '🔢 ' + task.investNo : '⚠️ Inv. nr. nėra') +
        ' · ' + (task.permitId ? '✅ Pateikta' : '⚠️ Nėra ID') + '</span><br>' +
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

    overlay(
      '📋 <b>' + (task.location || task.manager || 'Rasta užduotis') + '</b>' +
      '<br><small style="opacity:.8">Inv: ' + (task.investNo || '⚠️ nėra') + ' · ID: ' + (task.permitId || '⚠️') + '</small>' +
      '<br><small style="opacity:.6">Laukiama ESO rangovas formos...</small>',
      '#1a56db'
    );

    // Bandome auto-naviguoti, bet neblokuojame
    await tryAutoNavigate();

    // *** Pagrindinė logika: laukiame kol forma atsiranda ***
    // Nesvarbu ar auto-navigacija pavyko ar ne — laukiame iki 2 min.
    overlay(
      '⏳ <b>Laukiama formos...</b>' +
      '<br><small style="opacity:.8">' + (task.location || task.manager || '') + '</small>' +
      '<br><small style="opacity:.6">Spauskite ESO rangovas → Toliau</small>',
      '#1a56db'
    );

    await waitForForm();

    // Forma atsiranda — palaukiame dar 400ms kol Angular inicializuojasi
    await sleep(400);

    await fill(task);
  }

  main();
})();
