// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.4.0
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

  /* ── Overlay — visada rodomas iš karto ───────────────────── */
  function overlay(msg, color) {
    var el = document.getElementById('dp-eso');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dp-eso';
      Object.assign(el.style, {
        position: 'fixed', top: '12px', right: '12px',
        zIndex: '2147483647', padding: '12px 16px',
        borderRadius: '8px', font: '14px/1.5 sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        maxWidth: '320px', color: '#fff', cursor: 'pointer'
      });
      el.onclick = function () { el.remove(); };
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg + '<br><small style="opacity:.6">(spausk uždaryti)</small>';
  }

  // ── PIRMAS ŽENKLAS — rodome IŠKART, sinchroniškai ──────────
  overlay('🔌 <b>Digpoint ESO v1.4</b> — jungiamasi...', '#6366f1');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function gmFetch(url, method, body) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method || 'GET',
        url: url,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 8000,
        onload: function (r) {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { resolve(r.responseText); }
        },
        onerror: function (r) { reject(new Error('Klaida: ' + (r.statusText || 'network error'))); },
        ontimeout: function () { reject(new Error('Timeout — serveris neatsako')); }
      });
    });
  }

  async function fetchTask() {
    var d = await gmFetch(API + '/api/store/kl-eso-tasks');
    var list = Array.isArray(d.value) ? d.value : Array.isArray(d) ? d : [];
    return list.filter(function (t) { return t.status === 'pending'; })[0] || null;
  }

  async function removeTask(id) {
    try {
      var d = await gmFetch(API + '/api/store/kl-eso-tasks');
      var list = Array.isArray(d.value) ? d.value : [];
      await gmFetch(API + '/api/store/kl-eso-tasks', 'PUT',
        { value: list.filter(function (t) { return t.permitId !== id; }) });
    } catch (e) { /* tylu */ }
  }

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
    var opt = Array.from(sel.options).find(function (o) {
      return o.text.indexOf('Kauno m') !== -1;
    });
    if (opt) scope.$apply(function () { scope.postData.obj_municipality = opt.value; });
  }

  async function clickEsoRangovas() {
    var all = Array.from(document.querySelectorAll('button'));
    var btns = all.filter(function (b) { return b.textContent.trim() === 'Toliau'; });
    if (btns.length === 0) return; // jau atidaryta
    var target = btns.length >= 3 ? btns[2] : btns[btns.length - 1];
    target.click();
    await sleep(1500);
  }

  async function fillForm(task) {
    overlay('⏳ Spaudžiama "ESO rangovas → Toliau"...', '#1a56db');
    await clickEsoRangovas();

    // Laukiam kol atsiras laukai (max 6s)
    for (var i = 0; i < 12; i++) {
      if (document.querySelector('input[name="obj_address"]')) break;
      await sleep(500);
    }

    var scope = findScope();
    if (!scope) {
      overlay('❌ Forma nerasta po "Toliau". Paspaukite rankiniu: ESO rangovas → Toliau', '#dc2626');
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
    await removeTask(task.permitId);

    overlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:12px">' + (task.location || task.manager || task.permitId) + '</span><br>' +
      '<span style="font-size:11px;opacity:.8">Patikrinkite ir paspauskite <b>Siųsti</b></span>',
      '#059669'
    );
  }

  async function main() {
    await sleep(1500);

    // Dismiss cookies
    var cb = document.querySelector('.save_all_cookies');
    if (cb) { cb.click(); await sleep(300); }

    var task;
    try {
      task = await fetchTask();
    } catch (e) {
      overlay('❌ Serveris nepasiekiamas (' + API + ')<br><small>' + e.message + '</small>', '#dc2626');
      return;
    }

    if (!task) {
      overlay('ℹ️ Nėra laukiančių ESO užduočių.<br><small>Digpoint\'e spauskite "Pateikti ESO" ir atidarykite naują tab\'ą</small>', '#6b7280');
      setTimeout(function () {
        var el = document.getElementById('dp-eso');
        if (el) el.remove();
      }, 6000);
      return;
    }

    overlay('📋 Rasta: ' + (task.location || task.manager || task.permitId), '#1a56db');
    await sleep(400);
    await fillForm(task);
  }

  main();

})();
