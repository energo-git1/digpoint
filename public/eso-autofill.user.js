// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.9.0
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

  overlay('🔌 <b>Digpoint ESO v1.9</b> — jungiamasi...', '#6366f1');

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
    if (!permitId) {
      console.warn('[ESO] markDone: permitId tuščias!');
      return;
    }

    // 1. Pašaliname iš eilės
    try {
      var d = await gmJson(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
      var remaining = list.filter(function (t) { return t.permitId !== permitId; });
      await gmPut(API + '/api/store/kl-eso-tasks', { value: remaining });
      console.log('[ESO] Užduotis pašalinta iš eilės, liko:', remaining.length);
    } catch (e) {
      console.warn('[ESO] Eilės valymo klaida:', e);
    }

    // 2. Keičiame statusą į "Pateikta"
    try {
      var r = await gmPost(
        API + '/api/permits/' + permitId + '/status',
        { status: 'Pateikta', note: 'ESO paraiška pateikta automatiškai' }
      );
      console.log('[ESO] Statusas atnaujintas:', r ? r.status : 'neatsakė');
    } catch (e) {
      console.warn('[ESO] Statuso atnaujinimo klaida:', e);
    }
  }

  /* ── Angular laukų užpildymas ────────────────────────────── */
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

  // Užpildo lauką Angular-native būdu (triggerHandler = AngularJS suprantamas event)
  function setAngularField(name, val) {
    var el = document.querySelector('input[name="' + name + '"], textarea[name="' + name + '"]');
    if (!el) { console.warn('[ESO] Laukas nerastas:', name); return false; }
    try {
      var $el = angular.element(el);
      $el.val(val);
      $el.triggerHandler('input');
      $el.triggerHandler('change');
      return true;
    } catch (e) {
      console.warn('[ESO] setAngularField klaida (' + name + '):', e);
      return false;
    }
  }

  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality');
    if (!sel) return;
    var opt = Array.from(sel.options).find(function (o) { return o.text.indexOf('Kauno m') !== -1; });
    if (!opt) return;
    try {
      scope.$apply(function () { scope.postData.obj_municipality = opt.value; });
    } catch (e) {
      // Jei jau vyksta digest — tiesiog nustatome reikšmę
      scope.postData.obj_municipality = opt.value;
      angular.element(sel).triggerHandler('change');
    }
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

    var fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return;
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      var fs = angular.element(fileInput).scope();
      if (fs) fs.$apply();
    } catch (e) { }

    await sleep(600);
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
    for (var i = 0; i < 15; i++) {
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

    // Telefono formatas: be +370 ir be tarpų
    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s+/g, '').trim();

    // 1 žingsnis: scope.$apply — nustato Angular modelio reikšmes
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
    } catch (e) {
      console.warn('[ESO] scope.$apply klaida (gali būti digest race):', e.message);
    }

    // 2 žingsnis: Angular-native triggerHandler — atnaujina DOM iš modelio
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

    // 3 žingsnis: savivaldybė dropdown + terms checkbox
    await sleep(200);
    setMunicipality(scope);
    await sleep(200);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    // 4 žingsnis: PDF
    if (task.files && task.files.length > 0) {
      await uploadPdf(task);
    }

    // 5 žingsnis: pažymime kaip atlikta Digpoint sistemoje
    window.scrollTo(0, 0);
    await markDone(task.permitId);

    // Rezultato overlay
    var phoneEl = document.querySelector('input[name="legal_manager_phone"]');
    var phoneVal = phoneEl ? phoneEl.value : '?';
    var pdfStatus  = (task.files && task.files.length > 0) ? '📎 PDF įkeltas' : '⚠️ Nėra PDF';
    var invStatus  = task.investNo ? '🔢 ' + task.investNo : '⚠️ Inv. nr. nėra';
    var idStatus   = task.permitId ? '✅ Pateikta sistemoje' : '⚠️ Nėra permitId';

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:11px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">📞 Tel.: ' + phoneVal + ' · ' + pdfStatus + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">' + invStatus + ' · ' + idStatus + '</span><br>' +
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

    console.log('[ESO] Rasta užduotis:', JSON.stringify({
      permitId: task.permitId,
      manager: task.manager,
      phone: task.managerPhone,
      location: task.location
    }));

    overlay('📋 ' + (task.location || task.manager || 'Rasta užduotis') +
      '<br><small style="opacity:.7">ID: ' + (task.permitId || 'nėra!') + '</small>', '#1a56db');
    await sleep(500);
    await fill(task);
  }

  main();
})();
