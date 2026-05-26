// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      2.0.0
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

  overlay('🔌 <b>Digpoint ESO v2.0</b> — jungiamasi...', '#6366f1');

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
      scope.postData.obj_municipality = opt.value;
      angular.element(sel).triggerHandler('change');
    }
  }

  /* ── PDF įkėlimas (AngularJS-native) ────────────────────── */
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
        console.log('[ESO] PDF blob gautas:', pf.name, blob.size, 'bytes');
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
    if (!fileInput) {
      console.warn('[ESO] File input nerastas!');
      overlay('⚠️ File input nerastas — įkelkite PDF rankiniu būdu', '#d97706');
      await sleep(3000);
      return;
    }

    // Nustatome failus per DataTransfer
    fileInput.files = dt.files;
    console.log('[ESO] fileInput.files.length:', fileInput.files.length);

    // AngularJS-native event (ne dispatchEvent — jis AngularJS neveikia)
    try {
      angular.element(fileInput).triggerHandler('change');
      console.log('[ESO] triggerHandler(change) atliktas');
    } catch (e) {
      console.warn('[ESO] triggerHandler klaida:', e);
      // Fallback
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Paleidžiame Angular digest
    try {
      var fs = angular.element(fileInput).scope();
      if (fs) fs.$apply();
    } catch (e) { /* digest jau vyksta – gerai */ }

    await sleep(800);
    console.log('[ESO] PDF įkėlimas baigtas');
  }

  /* ── Auto-navigacija iki ESO rangovas formos ─────────────── */
  async function navigateToEsoRangovas() {
    // Jei forma jau atidaryta — nieko nedaryti
    if (document.querySelector('input[name="obj_address"]')) return true;

    overlay('🔍 Ieškoma ESO rangovas bloko...', '#6366f1');

    // Laukiame kol puslapis pilnai įkraunamas (iki 5 sek.)
    for (var w = 0; w < 10; w++) {
      if (document.querySelectorAll('button').length > 0) break;
      await sleep(500);
    }

    // Slapukų patvirtinimas
    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(400); }

    // 1 bandymas: rasti "ESO rangovas" tekstą ir artimiausią "Toliau" mygtuką
    var clicked = false;
    var allEls = Array.from(document.querySelectorAll('*'));
    var rangovasEl = null;

    // Ieškome tikslaus teksto "ESO rangovas" lapiniuose elementuose
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (el.childElementCount > 0) continue; // tik lapiniai elementai
      var txt = el.textContent.trim();
      if (txt === 'ESO rangovas' || txt.indexOf('ESO rangovas') !== -1) {
        rangovasEl = el;
        break;
      }
    }

    if (rangovasEl) {
      console.log('[ESO] Rastas "ESO rangovas" elementas:', rangovasEl.tagName, rangovasEl.className);
      // Einame aukštyn DOM medžiu ieškodami "Toliau" mygtuko tame pačiame bloke
      var parent = rangovasEl;
      for (var depth = 0; depth < 8; depth++) {
        parent = parent.parentElement;
        if (!parent) break;
        var btnsInBlock = Array.from(parent.querySelectorAll('button')).filter(function (b) {
          return b.textContent.trim() === 'Toliau';
        });
        if (btnsInBlock.length > 0) {
          btnsInBlock[0].click();
          clicked = true;
          console.log('[ESO] Spaudžiamas "Toliau" ESO rangovas bloke (depth=' + depth + ')');
          break;
        }
      }
    }

    // 2 bandymas (fallback): spaudžiame trečią arba paskutinį "Toliau"
    if (!clicked) {
      console.warn('[ESO] "ESO rangovas" blokas nerastas, naudojamas fallback');
      var allBtns = Array.from(document.querySelectorAll('button')).filter(function (b) {
        return b.textContent.trim() === 'Toliau';
      });
      if (allBtns.length === 0) {
        overlay('❌ Nerasta "Toliau" mygtukų. Atidarykite ESO formą rankiniu būdu.', '#dc2626');
        return false;
      }
      var target = allBtns.length >= 3 ? allBtns[2] : allBtns[allBtns.length - 1];
      target.click();
      console.log('[ESO] Fallback: spaudžiamas Toliau[' + (allBtns.length >= 3 ? 2 : allBtns.length - 1) + ']');
    }

    // Laukiame kol forma atsidaro (iki 10 sek.)
    overlay('⏳ Laukiama ESO rangovas formos...', '#1a56db');
    for (var j = 0; j < 20; j++) {
      await sleep(500);
      if (document.querySelector('input[name="obj_address"]')) {
        console.log('[ESO] Forma atsidaro po', (j + 1) * 500, 'ms');
        return true;
      }
    }

    return false;
  }

  /* ── Formos užpildymas ───────────────────────────────────── */
  async function fill(task) {
    overlay('⏳ Navigacija iki ESO rangovas formos...', '#1a56db');

    var formReady = await navigateToEsoRangovas();
    if (!formReady) {
      overlay('❌ Forma nerasta po 10 sek. Atidarykite ESO rangovas → Toliau', '#dc2626');
      return;
    }

    var scope = findScope();
    if (!scope) {
      overlay('❌ Angular scope nerastas. Perkraukite puslapį.', '#dc2626');
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
      console.warn('[ESO] scope.$apply klaida:', e.message);
    }

    // 2 žingsnis: Angular-native triggerHandler — atnaujina DOM
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
    var pdfStatus = (task.files && task.files.length > 0) ? '📎 PDF įkeltas' : '⚠️ Nėra PDF';
    var invStatus = task.investNo ? '🔢 ' + task.investNo : '⚠️ Inv. nr. nėra';
    var idStatus  = task.permitId ? '✅ Pateikta sistemoje' : '⚠️ Nėra permitId';

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
    await sleep(1500);

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
      location: task.location,
      files: (task.files || []).length
    }));

    overlay('📋 ' + (task.location || task.manager || 'Rasta užduotis') +
      '<br><small style="opacity:.7">ID: ' + (task.permitId || 'nėra!') + '</small>', '#1a56db');
    await sleep(500);
    await fill(task);
  }

  main();
})();
