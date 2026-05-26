// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      2.1.0
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

  overlay('🔌 <b>Digpoint ESO v2.1</b> — jungiamasi...', '#6366f1');

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

  /* ── Angular scope ───────────────────────────────────────── */
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
    } catch (e) { console.warn('[ESO] setAngularField klaida (' + name + '):', e); return false; }
  }

  /* ── Savivaldybė ─────────────────────────────────────────── */
  function setMunicipality(scope) {
    // Bandome kelis selektorius
    var sel = document.querySelector('select#obj_municipality')
           || document.querySelector('select[name="obj_municipality"]')
           || document.querySelector('select[ng-model*="municipality"]')
           || document.querySelector('select[ng-model*="obj_municipality"]');

    if (!sel) {
      // Paskutinis bandymas: pirmas select su Kauno variantu
      var allSels = Array.from(document.querySelectorAll('select'));
      sel = allSels.find(function (s) {
        return Array.from(s.options).some(function (o) { return o.text.indexOf('Kauno') !== -1; });
      }) || null;
    }

    if (!sel) { console.warn('[ESO] Savivaldybės select nerastas'); return; }

    var opt = Array.from(sel.options).find(function (o) { return o.text.indexOf('Kauno m') !== -1; });
    if (!opt) { console.warn('[ESO] Kauno m opcija nerasta, opcijos:', Array.from(sel.options).map(function(o){return o.text;})); return; }

    console.log('[ESO] Savivaldybė: rastas select, opt.value=', opt.value);
    try {
      scope.$apply(function () { scope.postData.obj_municipality = opt.value; });
    } catch (e) {
      scope.postData.obj_municipality = opt.value;
      angular.element(sel).triggerHandler('change');
    }
    // Papildomas triggerHandler ant select elemento
    angular.element(sel).triggerHandler('change');
  }

  /* ── PDF įkėlimas ────────────────────────────────────────── */
  async function uploadPdf(task) {
    if (!task.files || task.files.length === 0) return;
    var pdfs = task.files.filter(function (f) { return f.url || f.filename; });
    if (pdfs.length === 0) { console.warn('[ESO] Nėra failų su url/filename'); return; }

    overlay('📎 PDF įkeliamas... (' + pdfs.length + ' failas(-ai))', '#7c3aed');

    var dt = new DataTransfer();
    for (var i = 0; i < pdfs.length; i++) {
      var pf = pdfs[i];
      var fileUrl = API + (pf.url || '/uploads/' + pf.filename);
      console.log('[ESO] Kraunamas PDF:', fileUrl);
      try {
        var blob = await gmBlob(fileUrl);
        var fname = pf.name || pf.filename || ('kasimo_leidimas_' + i + '.pdf');
        dt.items.add(new File([blob], fname, { type: 'application/pdf' }));
        console.log('[ESO] PDF OK:', fname, blob.size, 'bytes');
      } catch (e) {
        console.warn('[ESO] PDF fetch failed:', pf.url, e.message);
      }
    }

    if (dt.files.length === 0) {
      overlay('⚠️ PDF nepavyko gauti iš serverio — įkelkite rankiniu būdu', '#d97706');
      await sleep(3000);
      return;
    }

    // Randame file input
    var fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      console.warn('[ESO] input[type="file"] nerastas');
      overlay('⚠️ File input nerastas puslapyje', '#d97706');
      await sleep(2000);
      return;
    }

    // Priskiriame failus
    try {
      fileInput.files = dt.files;
      console.log('[ESO] fileInput.files.length =', fileInput.files.length);
    } catch (e) {
      console.warn('[ESO] Nepavyko priskirti files:', e);
    }

    // Trigeriname AngularJS ir native events
    try { angular.element(fileInput).triggerHandler('change'); } catch (e) { console.warn('[ESO] triggerHandler change:', e); }
    try { angular.element(fileInput).triggerHandler('input'); } catch (e) { }
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Angular digest
    try {
      var fs = angular.element(fileInput).scope();
      if (fs) {
        try { fs.$apply(); } catch (e) { /* digest jau vyksta */ }
      }
    } catch (e) { }

    await sleep(800);
    console.log('[ESO] PDF įkėlimas baigtas');
  }

  /* ── Navigacija iki ESO rangovas formos ──────────────────── */
  async function clickEsoRangovas() {
    // Jei forma jau matoma — nieko nedaryti
    if (document.querySelector('input[name="obj_address"]')) {
      console.log('[ESO] Forma jau atidaryta');
      return;
    }

    // Slapukai
    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(400); }

    // Laukiame kol puslapis įkraunamas
    for (var w = 0; w < 10; w++) {
      if (document.querySelectorAll('button').length > 0) break;
      await sleep(400);
    }

    // Strategija 1: ieškome teksto "ESO rangovas" ir spaudžiame jo Toliau
    var allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p,label'));
    var rangovasEl = null;
    for (var i = 0; i < allEls.length; i++) {
      // Tikriname tik tiesioginio teksto turinį (ne innerHTML)
      var directText = Array.from(allEls[i].childNodes)
        .filter(function (n) { return n.nodeType === 3; })
        .map(function (n) { return n.textContent.trim(); })
        .join('');
      if (directText.indexOf('ESO rangovas') !== -1) {
        rangovasEl = allEls[i]; break;
      }
      if (allEls[i].textContent.trim() === 'ESO rangovas') {
        rangovasEl = allEls[i]; break;
      }
    }

    var clicked = false;
    if (rangovasEl) {
      console.log('[ESO] Rastas "ESO rangovas":', rangovasEl.tagName, '|', rangovasEl.textContent.trim().slice(0, 50));
      // Einame aukštyn ieškodami Toliau mygtuko
      var par = rangovasEl.parentElement;
      for (var d = 0; d < 10 && par; d++) {
        var btnsHere = Array.from(par.querySelectorAll('button')).filter(function (b) {
          return b.textContent.trim() === 'Toliau';
        });
        if (btnsHere.length > 0) {
          btnsHere[0].click();
          clicked = true;
          console.log('[ESO] Spaudžiamas Toliau ESO rangovas bloke (depth=' + d + ')');
          break;
        }
        par = par.parentElement;
      }
    }

    // Strategija 2 (fallback): 3-ias arba paskutinis Toliau
    if (!clicked) {
      console.warn('[ESO] ESO rangovas blokas nerastas, naudojamas fallback');
      var allBtns = Array.from(document.querySelectorAll('button')).filter(function (b) {
        return b.textContent.trim() === 'Toliau';
      });
      console.log('[ESO] Rasta "Toliau" mygtukų:', allBtns.length);
      if (allBtns.length > 0) {
        var target = allBtns.length >= 3 ? allBtns[2] : allBtns[allBtns.length - 1];
        target.click();
        console.log('[ESO] Fallback: spaudžiamas Toliau idx', allBtns.indexOf(target));
      }
    }

    // Laukiame kol forma atsidaro (iki 10 sek.)
    for (var j = 0; j < 20; j++) {
      await sleep(500);
      if (document.querySelector('input[name="obj_address"]')) {
        console.log('[ESO] Forma atsidaro po', (j + 1) * 500, 'ms');
        return;
      }
    }
    console.warn('[ESO] Forma nepasirode per 10 sek.');
  }

  /* ── Formos užpildymas ───────────────────────────────────── */
  async function fill(task) {
    overlay('⏳ Navigacija...', '#1a56db');
    await clickEsoRangovas();

    var scope = findScope();
    if (!scope) {
      overlay('❌ Angular scope nerastas. Spauskite ESO rangovas → Toliau', '#dc2626');
      return;
    }

    overlay('✍️ Pildomi laukai...', '#2563eb');

    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s+/g, '').trim();
    console.log('[ESO] Duomenys:', {
      manager: task.manager,
      phone: phone,
      location: task.location,
      investNo: task.investNo,
      files: (task.files || []).length
    });

    // 1. scope.$apply
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
    } catch (e) { console.warn('[ESO] $apply klaida:', e.message); }

    // 2. setAngularField
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

    // 3. Savivaldybė + checkbox
    await sleep(200);
    setMunicipality(scope);
    await sleep(200);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    // 4. PDF
    if (task.files && task.files.length > 0) {
      await uploadPdf(task);
    } else {
      console.log('[ESO] Nėra PDF failų užduotyje');
    }

    // 5. Žymime atlikta
    window.scrollTo(0, 0);
    await markDone(task.permitId);

    // Rezultatas
    var phoneEl  = document.querySelector('input[name="legal_manager_phone"]');
    var phoneVal = phoneEl ? phoneEl.value : '?';
    var pdfStatus = (task.files && task.files.length > 0) ? '📎 PDF įkeltas' : '⚠️ Nėra PDF';
    var invStatus = task.investNo ? '🔢 ' + task.investNo : '⚠️ Inv. nr. nėra';
    var idStatus  = task.permitId ? '✅ Pateikta' : '⚠️ Nėra permitId';

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:11px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:10px;opacity:.9">📞 ' + phoneVal + ' · ' + pdfStatus + '</span><br>' +
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
      investNo: task.investNo,
      files: (task.files || []).length
    }));

    overlay('📋 ' + (task.location || task.manager || 'Rasta užduotis') +
      '<br><small style="opacity:.7">ID: ' + (task.permitId || 'nėra!') +
      ' · Inv: ' + (task.investNo || '⚠️nėra') + '</small>', '#1a56db');
    await sleep(500);
    await fill(task);
  }

  main();
})();
