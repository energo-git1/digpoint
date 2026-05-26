// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.3.0
// @description  Automatiškai užpildo ESO kasimo leidimo formą iš Digpoint sistemos
// @author       EnergoLT
// @match        https://www.eso.lt/aktualios-formos/kasimo-darbai/*
// @grant        GM_xmlhttpRequest
// @connect      10.2.1.115
// @connect      localhost
// @run-at       document-idle
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
      el.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
        'padding:12px 16px', 'border-radius:8px', 'font:14px/1.5 sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'max-width:320px', 'color:#fff',
        'cursor:pointer'
      ].join(';');
      el.onclick = function(){ el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg + '<br><small style="opacity:.6">(spausk norėdamas uždaryti)</small>';
  }

  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  /* ── GM_xmlhttpRequest promise wrapper ───────────────────── */
  function gmFetch(url, method, body) {
    return new Promise(function(resolve, reject) {
      var opts = {
        method: method || 'GET',
        url: url,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        onload: function(r) {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch(e) { resolve(r.responseText); }
          } else {
            reject(new Error('HTTP ' + r.status));
          }
        },
        onerror: function(r) { reject(new Error('Network error: ' + r.statusText)); },
        ontimeout: function() { reject(new Error('Timeout')); },
        timeout: 8000
      };
      if (body) opts.data = JSON.stringify(body);
      GM_xmlhttpRequest(opts);
    });
  }

  /* ── Gauti pirmą pending užduotį ─────────────────────────── */
  async function fetchTask() {
    var data = await gmFetch(API + '/api/store/kl-eso-tasks');
    var tasks = Array.isArray(data.value) ? data.value : Array.isArray(data) ? data : [];
    var pending = tasks.filter(function(t){ return t.status === 'pending'; });
    return pending[0] || null;
  }

  /* ── Pašalinti atliktą užduotį ───────────────────────────── */
  async function removeTask(permitId) {
    try {
      var data = await gmFetch(API + '/api/store/kl-eso-tasks');
      var tasks = Array.isArray(data.value) ? data.value : [];
      var remaining = tasks.filter(function(t){ return t.permitId !== permitId; });
      await gmFetch(API + '/api/store/kl-eso-tasks', 'PUT', { value: remaining });
    } catch(e) { console.warn('[ESO] removeTask error:', e); }
  }

  /* ── Rasti Angular scope su postData ─────────────────────── */
  function findScope() {
    var selectors = ['input[name="obj_address"]','input[name="acceptance_email"]','input[name="excavation_start"]'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      var s = angular.element(el).scope();
      while (s) { if (s.postData) return s; s = s.$parent; }
    }
    return null;
  }

  /* ── Spausti ESO rangovas Toliau (3-ias) ─────────────────── */
  async function clickEsoRangovas() {
    var btns = Array.from(document.querySelectorAll('button'));
    var toliau = btns.filter(function(b){ return b.textContent.trim() === 'Toliau'; });
    if (toliau.length === 0) return true; // Forma jau atidaryta
    if (toliau.length >= 3) {
      toliau[2].click();
      await sleep(1500);
      return true;
    }
    // Jei mažiau nei 3 — bandome spausti paskutinį
    toliau[toliau.length - 1].click();
    await sleep(1500);
    return true;
  }

  /* ── Savivaldybė ─────────────────────────────────────────── */
  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality');
    if (!sel) return;
    var opt = Array.from(sel.options).find(function(o){ return o.text.indexOf('Kauno m') !== -1; });
    if (opt) {
      scope.$apply(function(){ scope.postData.obj_municipality = opt.value; });
    }
  }

  /* ── Užpildyti formą ─────────────────────────────────────── */
  async function fillForm(task) {
    overlay('⏳ Atidaroma ESO rangovas forma...', '#1a56db');

    await clickEsoRangovas();

    // Laukiame kol atsiras laukai
    for (var wait = 0; wait < 10; wait++) {
      if (document.querySelector('input[name="obj_address"]')) break;
      await sleep(500);
    }

    var scope = findScope();
    if (!scope) {
      overlay('❌ Forma nerasta. Pabandykite rankiniu būdu paspausti "ESO rangovas → Toliau"', '#dc2626');
      return;
    }

    overlay('✍️ Pildoma forma...', '#2563eb');

    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s/g,'').trim();

    scope.$apply(function(){
      scope.postData.legal_company_name      = 'EnergoLT';
      scope.postData.legal_manager_name      = task.manager || '';
      scope.postData.legal_manager_phone     = phone;
      scope.postData.acceptance_email        = task.email || '';
      scope.postData.obj_address             = task.location || '';
      scope.postData.excavation_purpose      = 'Elektros tinklų įrengimas';
      scope.postData.excavation_start        = task.startDate || '';
      scope.postData.excavation_end          = task.endDate   || '';
      scope.postData.excavation_link         = '';
      scope.postData.technical_eso_investment_nr = task.investNo || '';
      scope.postData.agree_to_terms          = true;
    });

    setMunicipality(scope);

    await sleep(300);
    var cb = document.querySelector('input#terms');
    if (cb && !cb.checked) cb.click();

    window.scrollTo(0, 0);

    await removeTask(task.permitId);

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:12px">' + (task.location || task.manager || task.permitId) + '</span><br>' +
      '<span style="font-size:11px;opacity:.8">Patikrinkite ir paspauskite <b>Siųsti</b></span>',
      '#059669'
    );
  }

  /* ── Main ────────────────────────────────────────────────── */
  async function main() {
    // Pirmas ženklas — skriptas veikia
    overlay('🔌 Digpoint ESO skriptas veikia, tikrinama...', '#6366f1');

    await sleep(2000);

    // Uždaryti slapukų bannerį
    var cookieBtn = document.querySelector('.save_all_cookies, button[class*="cookie"]');
    if (cookieBtn) { cookieBtn.click(); await sleep(400); }

    // Gauti užduotį
    var task;
    try {
      task = await fetchTask();
    } catch(e) {
      overlay('❌ Serveris nepasiekiamas: ' + e.message + '<br><small>' + API + '</small>', '#dc2626');
      return;
    }

    if (!task) {
      // Nėra užduočių — tyliai išsivalom
      var el = document.getElementById('dp-eso');
      if (el) setTimeout(function(){ el.remove(); }, 3000);
      return;
    }

    overlay('📋 Rasta užduotis: ' + (task.location || task.manager || task.permitId), '#1a56db');
    await sleep(500);

    await fillForm(task);
  }

  // Paleidžiame kai puslapis įkeltas
  if (document.readyState === 'complete') {
    main();
  } else {
    window.addEventListener('load', main);
  }

})();
