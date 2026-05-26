// ==UserScript==
// @name         Digpoint ESO Autofill
// @namespace    http://10.2.1.115:3001/
// @version      1.1.0
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
    let el = document.getElementById('dp-eso-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dp-eso-overlay';
      el.style.cssText = [
        'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
        'padding:12px 18px', 'border-radius:10px', 'font-size:14px',
        'font-family:sans-serif', 'box-shadow:0 4px 16px #0004',
        'max-width:320px', 'line-height:1.5', 'color:#fff', 'transition:background .3s'
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.background = color || '#1a56db';
    el.innerHTML = msg;
  }

  function hideOverlay() {
    const el = document.getElementById('dp-eso-overlay');
    if (el) el.remove();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Laukia kol atsiranda elementas ──────────────────────── */
  function waitFor(selector, timeout = 8000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  /* ── Laukia kol išnyksta elementas ───────────────────────── */
  function waitForGone(selector, timeout = 8000) {
    return new Promise((resolve) => {
      if (!document.querySelector(selector)) return resolve();
      const obs = new MutationObserver(() => {
        if (!document.querySelector(selector)) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
    });
  }

  /* ── Užpildo lauką (veikia su React/Vue) ─────────────────── */
  function setField(name, val) {
    const el = document.querySelector(
      'input[name="' + name + '"], textarea[name="' + name + '"], input[id="' + name + '"], textarea[id="' + name + '"]'
    );
    if (!el) return false;
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
    } catch (e) { el.value = val; }
    ['input', 'change', 'blur'].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true }))
    );
    return true;
  }

  /* ── API: gauti laukiančią užduotį ───────────────────────── */
  function fetchTask() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API + '/api/store/kl-eso-tasks',
        onload: (r) => {
          try {
            const data = JSON.parse(r.responseText);
            const tasks = Array.isArray(data.value) ? data.value
                        : Array.isArray(data) ? data : [];
            const pending = tasks.filter(t => t.status === 'pending');
            resolve(pending.length ? pending[0] : null);
          } catch (e) { resolve(null); }
        },
        onerror: () => resolve(null)
      });
    });
  }

  /* ── API: pašalinti atliktą užduotį ──────────────────────── */
  function removeTask(permitId) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: API + '/api/store/kl-eso-tasks',
      onload: (r) => {
        try {
          const data = JSON.parse(r.responseText);
          const tasks = Array.isArray(data.value) ? data.value : [];
          const remaining = tasks.filter(t => t.permitId !== permitId);
          GM_xmlhttpRequest({
            method: 'PUT',
            url: API + '/api/store/kl-eso-tasks',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ value: remaining }),
            onload: () => {}
          });
        } catch (e) {}
      }
    });
  }

  /* ── Paspaudžia pirmą "Toliau" mygtuką ───────────────────── */
  async function clickToliau() {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const toliau = btns.find(b => /toliau|tęsti|pirmyn|next/i.test(b.textContent.trim()));
    if (toliau) {
      toliau.click();
      await sleep(1200);
      return true;
    }
    return false;
  }

  /* ── Pagrindinė pildymo logika ────────────────────────────── */
  async function fillForm(task) {
    showOverlay('⏳ Ieškoma formos laukų...', '#1a56db');

    // Kartais forma rodoma po "Toliau" paspaudimo
    await clickToliau();
    await sleep(600);

    // Bandome užpildyti
    const phone = (task.managerPhone || '')
      .replace(/^\+370/, '').replace(/\+/, '').replace(/\s/g, '').trim();

    const filled = [];
    const trySet = (name, val) => { if (val && setField(name, val)) filled.push(name); };

    trySet('legal_company_name', 'EnergoLT');
    trySet('legal_manager_name', task.manager);
    trySet('legal_manager_phone', phone);
    trySet('acceptance_email', task.email);
    trySet('obj_address', task.location);
    trySet('excavation_purpose', 'Elektros tinklų įrengimas');
    trySet('excavation_start', task.startDate);
    trySet('excavation_end', task.endDate);
    setField('excavation_link', '');
    trySet('technical_eso_investment_nr', task.investNo);

    // Savivaldybė dropdown
    const selEl = document.querySelector('select');
    if (selEl) {
      const kauno = Array.from(selEl.options).find(o =>
        o.text.includes('Kauno m') || o.text.includes('Kaunas')
      );
      if (kauno) {
        selEl.value = kauno.value;
        selEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Checkbox
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();

    if (filled.length === 0) {
      // Galbūt reikia dar vieno "Toliau"
      await clickToliau();
      await sleep(800);
      trySet('legal_company_name', 'EnergoLT');
      trySet('legal_manager_name', task.manager);
      trySet('legal_manager_phone', phone);
      trySet('acceptance_email', task.email);
      trySet('obj_address', task.location);
      trySet('excavation_purpose', 'Elektros tinklų įrengimas');
      trySet('excavation_start', task.startDate);
      trySet('excavation_end', task.endDate);
      setField('excavation_link', '');
      trySet('technical_eso_investment_nr', task.investNo);
    }

    // Pažymime kaip atliktą
    removeTask(task.permitId);

    showOverlay(
      '✅ <b>Forma užpildyta!</b><br>' +
      '<span style="font-size:12px">' + (task.location || task.manager || '') + '</span><br>' +
      '<span style="font-size:11px;opacity:.8">Patikrinkite ir paspauskite <b>Siųsti</b></span>',
      '#059669'
    );

    // Po 30s slepiame pranešimą
    setTimeout(hideOverlay, 30000);
  }

  /* ── Start ────────────────────────────────────────────────── */
  window.addEventListener('load', async () => {
    await sleep(2000); // Laukiame kol puslapis pilnai įsikelia

    const task = await fetchTask();
    if (!task) return; // Nėra laukiančių užduočių — nieko nedarome

    showOverlay('🔄 Digpoint: rasta užduotis — ' + (task.location || task.manager || task.permitId), '#1a56db');
    await sleep(500);
    await fillForm(task);
  });

})();
