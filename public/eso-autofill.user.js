// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.5.0
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
      el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:320px;color:#fff;cursor:pointer';
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg + '<br><small style="opacity:.6">(spausk uždaryti)</small>';
  }

  // Rodome iš karto — pirmas ženklas kad skriptas veikia
  overlay('🔌 <b>Digpoint ESO v1.5</b> — tikrinama...', '#6366f1');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── Gauti užduotį iš URL hash (#dp=BASE64) ──────────────── */
  function taskFromHash() {
    var m = window.location.hash.match(/dp=([A-Za-z0-9+\/=]+)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); }
    catch (e) { return null; }
  }

  /* ── Gauti užduotį iš serverio (fallback) ────────────────── */
  function taskFromServer() {
    return new Promise(function (resolve) {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: API + '/api/store/kl-eso-tasks',
          timeout: 5000,
          onload: function (r) {
            try {
              var d = JSON.parse(r.responseText);
              var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
              resolve(list.filter(function (t) { return t.status === 'pending'; })[0] || null);
            } catch (e) { resolve(null); }
          },
          onerror: function () { resolve(null); },
          ontimeout: function () { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ── Angular scope ───────────────────────────────────────── */
  function findScope() {
    var fields = ['obj_address', 'acceptance_email', 'excavation_start'];
    for (var i = 0; i < fields.length; i++) {
      var el = document.querySelector('input[name="' + fields[i] + '"]');
      if (!el) continue;
      var s = angular.element(el).scope();
      while (s) { if (s.postData) return s; s = s.$parent; }
    }
    return null;
  }

  /* ── Savivaldybė ─────────────────────────────────────────── */
  function setMunicipality(scope) {
    var sel = document.querySelector('select#obj_municipality');
    if (!sel) return;
    var opt = Array.from(sel.options).find(function (o) { return o.text.indexOf('Kauno m') !== -1; });
    if (opt) scope.$apply(function () { scope.postData.obj_municipality = opt.value; });
  }

  /* ── Spausti ESO rangovas → Toliau ───────────────────────── */
  async function clickEsoRangovas() {
    if (document.querySelector('input[name="obj_address"]')) return; // jau atidaryta
    var btns = Array.from(document.querySelectorAll('button')).filter(function (b) {
      return b.textContent.trim() === 'Toliau';
    });
    if (btns.length === 0) return;
    var btn = btns.length >= 3 ? btns[2] : btns[btns.length - 1];
    btn.click();
    // Laukiam kol forma atsiranda
    for (var i = 0; i < 12; i++) {
      await sleep(500);
      if (document.querySelector('input[name="obj_address"]')) break;
    }
  }

  /* ── Užpildyti formą ─────────────────────────────────────── */
  async function fill(task) {
    overlay('⏳ Atidaroma ESO rangovas forma...', '#1a56db');

    // Dismiss cookies
    var cb2 = document.querySelector('.save_all_cookies');
    if (cb2) { cb2.click(); await sleep(300); }

    await clickEsoRangovas();

    var scope = findScope();
    if (!scope) {
      overlay('❌ Forma nerasta. Spauskite rankiniu: ESO rangovas → Toliau', '#dc2626');
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

    window.scrollTo(0, 0);

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:12px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:11px;opacity:.8">Patikrinkite ir paspauskite <b>Siųsti</b></span>',
      '#059669'
    );
  }

  /* ── Pagrindinis srautas ─────────────────────────────────── */
  async function main() {
    await sleep(1000);

    // 1. Pirma tikriname URL hash — greita, be serverio
    var task = taskFromHash();

    // 2. Jei nėra hash — bandome serverį
    if (!task) {
      overlay('🔌 Hash nėra — bandomas serveris...', '#6366f1');
      task = await taskFromServer();
    }

    if (!task) {
      overlay('ℹ️ Nėra ESO užduočių.<br><small>Digpoint\'e spauskite "🚀 Pateikti ESO"</small>', '#6b7280');
      setTimeout(function () { var e = document.getElementById('dp-eso'); if (e) e.remove(); }, 7000);
      return;
    }

    overlay('📋 ' + (task.location || task.manager || task.permitId || 'Rasta užduotis'), '#1a56db');
    await sleep(400);
    await fill(task);
  }

  main();
})();
