// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.2.0
// @description  Automatiškai užpildo ESO kasimo leidimo formą iš Digpoint sistemos
// @author       EnergoLT
// @match        https://www.eso.lt/aktualios-formos/kasimo-darbai/*
// @grant        GM_xmlhttpRequest
// @connect      10.2.1.115
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = 'http://10.2.1.115:3001';

  /* ── UI overlay ───────────────────────────────────────────── */
  function showOverlay(msg, color) {
    var el = document.getElementById('dp-eso-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dp-eso-overlay';
      el.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;padding:14px 18px;border-radius:10px;font-size:14px;font-family:sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.25);max-width:340px;line-height:1.5;color:#fff;';
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg;
  }

  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  /* ── Laukia kol atsiranda DOM elementas ──────────────────── */
  function waitFor(selector, timeout) {
    timeout = timeout || 8000;
    return new Promise(function(resolve) {
      var el = document.querySelector(selector);
      if (el) return resolve(el);
      var obs = new MutationObserver(function() {
        var el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  /* ── API: gauti pirmą laukiančią ESO užduotį ─────────────── */
  function fetchTask() {
    return new Promise(function(resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API + '/api/store/kl-eso-tasks',
        onload: function(r) {
          try {
            var data = JSON.parse(r.responseText);
            var tasks = Array.isArray(data.value) ? data.value
                      : Array.isArray(data) ? data : [];
            var pending = tasks.filter(function(t) { return t.status === 'pending'; });
            resolve(pending.length ? pending[0] : null);
          } catch(e) { resolve(null); }
        },
        onerror: function() { resolve(null); }
      });
    });
  }

  /* ── API: pašalinti atliktą užduotį ──────────────────────── */
  function removeTask(permitId) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: API + '/api/store/kl-eso-tasks',
      onload: function(r) {
        try {
          var data = JSON.parse(r.responseText);
          var tasks = Array.isArray(data.value) ? data.value : [];
          var remaining = tasks.filter(function(t) { return t.permitId !== permitId; });
          GM_xmlhttpRequest({
            method: 'PUT',
            url: API + '/api/store/kl-eso-tasks',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ value: remaining }),
            onload: function() {}
          });
        } catch(e) {}
      }
    });
  }

  /* ── Nustatome Angular scope reikšmę ─────────────────────── */
  function setScope(scope, key, value) {
    scope.$apply(function() {
      // Parašome į postData objektą
      scope.postData[key] = value;
    });
  }

  /* ── Randame Angular scope su postData ───────────────────── */
  function findScope() {
    var input = document.querySelector('input[name="obj_address"], input[name="acceptance_email"], input[name="excavation_start"]');
    if (!input) return null;
    var s = angular.element(input).scope();
    while (s) {
      if (s.postData) return s;
      s = s.$parent;
    }
    return null;
  }

  /* ── Pasirenkame savivaldybę ──────────────────────────────── */
  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality');
    if (!sel) return;
    var kauno = Array.from(sel.options).find(function(o) {
      return o.text.indexOf('Kauno m') !== -1;
    });
    if (kauno) {
      scope.$apply(function() {
        scope.postData.obj_municipality = kauno.value;
      });
    }
  }

  /* ── Pagrindinė užpildymo funkcija ───────────────────────── */
  async function fillForm(task) {
    showOverlay('⏳ Ieškoma formos...', '#1a56db');

    // 1. Spaudžiame "ESO rangovas" Toliau (3-ias mygtukas)
    await sleep(1500);
    var btns = Array.from(document.querySelectorAll('button'));
    var toliauBtns = btns.filter(function(b) { return b.textContent.trim() === 'Toliau'; });
    if (toliauBtns.length >= 3) {
      toliauBtns[2].click(); // ESO rangovas
      showOverlay('⏳ Atidaroma ESO rangovas forma...', '#1a56db');
      await sleep(1200);
    } else if (toliauBtns.length > 0) {
      // Jei forma jau atidaryta — tiesiog pildome
    } else {
      showOverlay('⚠️ Nerasta "Toliau" mygtukų. Galbūt forma jau atidaryta?', '#d97706');
      await sleep(1000);
    }

    // 2. Randame Angular scope
    var scope = findScope();
    if (!scope) {
      showOverlay('❌ Angular scope nerastas. Bandykite perkrauti puslapį.', '#dc2626');
      return;
    }

    showOverlay('✍️ Pildoma forma...', '#1a56db');

    // 3. Užpildome laukus per Angular scope
    var phone = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s/g, '').trim();

    scope.$apply(function() {
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

    // 4. Savivaldybė — Kauno m. sav.
    setMunicipality(scope);

    // 5. Fiziškai pažymime checkbox (Angular gali neatnaujinti vizualiai)
    await sleep(300);
    var cb = document.querySelector('input[id="terms"]');
    if (cb && !cb.checked) cb.click();

    // 6. Slinkame aukštyn kad forma matytųsi
    window.scrollTo(0, 0);
    await sleep(200);
    window.scrollTo(0, 400);

    // 7. Pašaliname iš užduočių sąrašo
    removeTask(task.permitId);

    showOverlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<small style="opacity:.9">' + (task.location || task.manager || '') + '</small><br>' +
      '<small style="opacity:.7">Patikrinkite ir paspauskite <b>Siųsti</b></small>',
      '#059669'
    );

    setTimeout(function() {
      var el = document.getElementById('dp-eso-overlay');
      if (el) el.remove();
    }, 60000);
  }

  /* ── Startas ──────────────────────────────────────────────── */
  window.addEventListener('load', async function() {
    await sleep(2500); // Laukiame AngularJS inicializacijos

    // Uždariame slapukų bannerį jei yra
    var cookieBtn = document.querySelector('.save_all_cookies');
    if (cookieBtn) { cookieBtn.click(); await sleep(500); }

    var task = await fetchTask();
    if (!task) return; // Nėra laukiančių užduočių

    showOverlay('🔄 Digpoint: rasta užduotis — ' + (task.location || task.manager || task.permitId), '#1a56db');
    await sleep(400);
    await fillForm(task);
  });

})();
