// ==UserScript==
// @name         EnergoLT — Kasimo leidimai
// @namespace    http://energolt.eu/
// @version      1.0.3
// @description  Automatizuotas Kauno m. sav. ir ESO kasimo leidimų paraiškų pildymas
// @author       EnergoLT
// @match        https://kasimai.kaunas.lt/*
// @match        https://ap.epaslaugos.lt/*
// @match        https://log-in.swedbank.lt/*
// @match        https://www.swedbank.lt/banklink/*
// @match        https://www.eso.lt/aktualios-formos/kasimo-darbai/*
// @updateURL    http://10.2.1.115:3001/energolt-kasimo.user.js
// @downloadURL  http://10.2.1.115:3001/energolt-kasimo.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      10.2.1.115
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DIGPOINT = 'http://10.2.1.115:3001';
  const SWB_ID   = GM_getValue('swb_login_id', '2211078');
  const log      = (msg) => console.log('[EnergoLT]', msg);
  const TASK_TTL = 60 * 60 * 1000; // 60 minučių

  // Tikrina ar užduotis aktyvi (status=pending ir ne senesnė nei TTL)
  function isActiveTask(t) {
    if (!t || t.status !== 'pending') return false;
    const age = Date.now() - new Date(t.createdAt).getTime();
    if (age > TASK_TTL) {
      log(`Užduotis per sena (${Math.round(age / 60000)} min.) — ignoruojama`);
      return false;
    }
    return true;
  }

  // ─── Pagalbinės funkcijos ──────────────────────────────────────

  // Laukia elemento iki timeout ms, tada iškviečia callback
  function waitFor(selector, callback, timeout = 15000, interval = 250) {
    const start = Date.now();
    const check = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(check);
        log(`Rastas: ${selector}`);
        callback(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        log(`Timeout (${timeout}ms): ${selector}`);
      }
    }, interval);
  }

  // Laukia elemento pagal tekstą
  function waitForText(selector, text, callback, timeout = 15000) {
    const start = Date.now();
    const check = setInterval(() => {
      const els = Array.from(document.querySelectorAll(selector));
      const el = els.find(e => (e.textContent || '').includes(text));
      if (el) {
        clearInterval(check);
        callback(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        log(`Timeout tekstui "${text}" selector "${selector}"`);
      }
    }, 300);
  }

  // Nustato Angular input reikšmę
  function setAngularVal(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Nustato įprasto input reikšmę
  function setVal(name, value) {
    const el = document.querySelector(`input[name="${name}"]`);
    if (!el) { log(`Laukas nerastas: ${name}`); return; }
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Gauna duomenis iš Digpoint
  function digpointGet(path, callback) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${DIGPOINT}${path}`,
      onload: (r) => {
        try { callback(null, JSON.parse(r.responseText)); }
        catch (e) { callback(e, null); }
      },
      onerror: (e) => callback(e, null),
    });
  }

  // Siunčia mygtuko paspaudimą
  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // Sukuria File objektą iš base64 ir priskiria input
  function uploadBase64(input, base64, filename) {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], filename, { type: 'application/pdf' });
    const dt   = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log(`Įkeltas failas: ${filename} (${(bytes.length / 1024).toFixed(1)} KB)`);
  }

  // ─── Puslapių valdikliai ───────────────────────────────────────

  const url = location.href;

  // ── 1. E. valdžios vartai — pasirinkti Swedbank ───────────────
  if (url.includes('epaslaugos.lt') && url.includes('/login')) {
    log('E. valdžios vartai — ieškoma Swedbank');
    waitFor('img[alt*="Swedbank"]', (img) => {
      // Mažas delay kad puslapiui stabilizuotis
      setTimeout(() => {
        const parent = img.closest('a,button,div[role="button"]') || img.parentElement;
        click(parent);
        log('Swedbank pasirinktas');
      }, 500);
    });
    return;
  }

  // ── 2. E. valdžios vartai — duomenų perdavimo patvirtinimas ──
  if (url.includes('epaslaugos.lt/auth-redirect')) {
    log('E. valdžios vartai — Asmens duomenų perdavimas');
    waitForText('button', 'Prisijungti', (btn) => {
      setTimeout(() => { click(btn); log('Prisijungti paspaustas'); }, 800);
    });
    return;
  }

  // ── 3. Swedbank — įvesti vartotojo ID ─────────────────────────
  if (url.includes('log-in.swedbank.lt')) {
    log('Swedbank — pildomas prisijungimo ID');
    waitFor('#login-widget-user-id-simple', (idField) => {
      setTimeout(() => {
        setAngularVal(idField, SWB_ID);
        log(`ID įvestas: ${SWB_ID}`);
        // Spausti Prisijungti po 0.5s
        setTimeout(() => {
          waitForText('button', 'Prisijungti', (btn) => {
            click(btn);
            log('Prisijungti paspaustas — laukiame telefono patvirtinimo...');
          });
        }, 500);
      }, 300);
    });
    return;
  }

  // ── 4. Swedbank — duomenų siuntimas (banklink) ────────────────
  if (url.includes('swedbank.lt/banklink/auth')) {
    log('Swedbank — Siųsti duomenis');
    waitFor('input[type="button"][value="Siųsti duomenis"]', (btn) => {
      setTimeout(() => { click(btn); log('Siųsti duomenis paspaustas'); }, 600);
    });
    return;
  }

  // ── 5a. kasimai.kaunas.lt — šaknis arba bet kuris puslapis (po prisijungimo redirect) ──
  if (url.match(/kasimai\.kaunas\.lt\/?$/) || url.match(/kasimai\.kaunas\.lt\/\?/)) {
    digpointGet('/api/store/kl-sav-task', (err, data) => {
      if (err || !data || !data.value) return;
      if (!isActiveTask(data.value)) return;
      log('Aktyvus kl-sav-task — nukreipiama į mano-prasymai');
      setTimeout(() => { location.href = 'https://kasimai.kaunas.lt/mano-prasymai/'; }, 1000);
    });
    return;
  }

  // ── 5. kasimai.kaunas.lt — mano prašymai: atidaryti pirmą ir kopijuoti ──
  if (url.includes('kasimai.kaunas.lt/mano-prasymai')) {
    log('kasimai — mano prašymai, laukiama sąrašo');

    // Tikrinti ar vartotojas prisijungęs — jei ne, spausti "Prisijungti"
    setTimeout(() => {
      const loginBtn = Array.from(document.querySelectorAll('a, button')).find(el => {
        const txt = (el.textContent || '').trim();
        return txt.startsWith('Prisijungti') && !el.closest('nav, header, .navbar');
      });
      if (loginBtn) {
        log('Vartotojas neprisijungęs — spaudžiamas "Prisijungti"');
        click(loginBtn);
        return; // po redirect script'as paleis iš naujo
      }

      // Prisijungęs — tikrinti ar yra aktyvus kl-sav-task
      digpointGet('/api/store/kl-sav-task', (err, data) => {
        if (err || !data || !data.value) {
          log('Nėra aktyvios užduoties — nieko nedarome');
          return;
        }
        if (!isActiveTask(data.value)) {
          log('Užduotis neaktyvi arba per sena — nieko nedarome');
          return;
        }
        log('Yra aktyvus kl-sav-task — kopijuojame pirmą prašymą');
        waitFor('a[href*="collapsePrasymas"]', (firstLink) => {
          setTimeout(() => {
            click(firstLink);
            log('Pirmasis prašymas atidarytas');
            waitForText('button', 'Kopijuoti prašymą', (btn) => {
              setTimeout(() => { click(btn); log('"Kopijuoti prašymą" paspaustas'); }, 600);
            }, 8000);
          }, 1000);
        }, 10000);
      });
    }, 1500);
    return;
  }

  // ── 6. kasimai.kaunas.lt — formos pildymas ────────────────────
  if (url.includes('kasimai.kaunas.lt/naujas-prasymas')) {
    log('kasimai.kaunas.lt — formos pildymas');

    // Gauname užduoties duomenis iš Digpoint
    digpointGet('/api/store/kl-sav-task', (err, data) => {
      if (err || !data || !data.value) {
        log('Nerasta kl-sav-task — formą pildykite rankiniu būdu');
        return;
      }
      if (!isActiveTask(data.value)) {
        log('Užduotis neaktyvi — formą pildykite rankiniu būdu');
        return;
      }
      const t = data.value;
      log(`Duomenys gauti: ${t.manager}, ${t.startDate}–${t.endDate}`);

      // Laukiame kol formos laukai bus paruošti
      waitFor('input[name="dv_vardas"]', () => {
        setTimeout(() => {
          const nameParts = (t.manager || '').split(' ');
          setVal('dv_vardas',   nameParts[0] || '');
          setVal('dv_pavarde',  nameParts.slice(1).join(' ') || '');
          setVal('dv_tel',      t.managerPhone || '');
          setVal('darbai_pradzia', t.startDate || '');
          setVal('darbai_pabaiga', t.endDate   || '');

          // Planuojami darbai — "Elektros tinklų įrengimas"
          const sel = document.querySelector('select[name="planuojami_darbai"]');
          if (sel) {
            const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes('elektros tinkl'));
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              log('Darbų tipas: Elektros tinklų įrengimas');
            }
          }

          log('Formos laukai užpildyti');

          // Pažymime užduotį kaip atliktą
          GM_xmlhttpRequest({
            method: 'PUT',
            url: `${DIGPOINT}/api/store/kl-sav-task`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ ...t, status: 'done', doneAt: new Date().toISOString() }),
            onload: () => log('kl-sav-task pažymėta "done"'),
          });

          // Įkeliame priedų PDF — naudojame merge-sav-priedai su išsaugotais pasirinkimais
          if (t.permitId) {
            const fileInput = document.querySelector('input[type="file"]');
            if (fileInput) {
              // Gauname išsaugotus pasirinkimus iš kl-permits
              digpointGet('/api/store/kl-permits', (err2, permitsData) => {
                const permits = (permitsData && permitsData.value) || [];
                const permit = permits.find(pm => pm.id === t.permitId);
                const prep = (permit && permit.savivaldybePreparation) || {};
                const srcId = prep.srcId || t.permitId;
                const selectedFilenames = prep.selectedFilenames || [];
                const extraFilenames = (prep.extraFiles || []).map(f => f.filename).filter(Boolean);
                const location = (permit && permit.location) || '';

                GM_xmlhttpRequest({
                  method: 'POST',
                  url: `${DIGPOINT}/api/admin/merge-sav-priedai`,
                  headers: { 'Content-Type': 'application/json' },
                  data: JSON.stringify({ permitId: srcId, selectedFilenames, extraFilenames, location }),
                  onload: (r) => {
                    try {
                      const d = JSON.parse(r.responseText);
                      if (d.ok && d.content) {
                        uploadBase64(fileInput, d.content, d.filename || 'priedai_savivaldybei.pdf');
                        log(`Priedų PDF įkeltas: ${d.pages} psl. — ${d.filename}`);
                      } else {
                        log('Priedų PDF klaida: ' + (d.error || 'nežinoma'));
                      }
                    } catch (e) { log('Priedų PDF klaida: ' + e.message); }
                  },
                });
              });
            }
          }
        }, 400);
      });
    });
    return;
  }

  // ── 6. ESO forma — pildymas su Angular laukimu ────────────────
  if (url.includes('eso.lt/aktualios-formos/kasimo-darbai')) {
    // Bandome gauti duomenis iš URL hash arba kl-eso-tasks
    const hashMatch = location.hash.match(/dp=([A-Za-z0-9+/=]+)/);

    function fillEsoForm(task) {
      log(`ESO forma — pildoma: ${task.location}`);
      const ph = (task.managerPhone || '').replace(/^\+370/, '').replace(/\s/g, '');

      // Angular scope pildymas
      const fillAngular = () => {
        const el = document.querySelector('input[name="obj_address"]');
        if (!el) { log('Angular forma dar nekraunama'); return false; }

        try {
          const scope = angular.element(el).scope();
          let s = scope;
          while (s && !s.postData) s = s.$parent;
          if (!s) { log('Angular scope nerastas'); return false; }

          s.$apply(() => {
            s.postData.legal_company_name         = 'EnergoLT';
            s.postData.legal_manager_name         = task.manager    || '';
            s.postData.legal_manager_phone        = ph;
            s.postData.acceptance_email           = task.email      || 'uzklausos@energolt.eu';
            s.postData.obj_address                = task.location   || '';
            s.postData.excavation_purpose         = 'Elektros tinklų įrengimas';
            s.postData.excavation_start           = task.startDate  || '';
            s.postData.excavation_end             = task.endDate    || '';
            s.postData.technical_eso_investment_nr = task.investNo  || '';
            s.postData.agree_to_terms             = true;
          });

          // Savivaldybė
          const munSel = document.querySelector('select#obj_municipality');
          if (munSel) {
            const opt = Array.from(munSel.options).find(o => o.text.includes('Kauno m'));
            if (opt) s.$apply(() => { s.postData.obj_municipality = opt.value; });
          }

          // Checkbox
          const cb = document.querySelector('input#terms');
          if (cb && !cb.checked) cb.click();

          log('ESO forma užpildyta ✅');
          return true;
        } catch (e) {
          log('Angular klaida: ' + e.message);
          return false;
        }
      };

      // Laukiame kol vartotojas pasirenka rangovo tipą ir pereina į formos puslapį
      // NESPAUČIAME "Toliau" — vartotojas pats turi pasirinkti rangovo tipą
      const tryFill = (attempt = 0) => {
        if (attempt > 120) { log('ESO: timeout (60s), bandykite rankiniu būdu'); return; }

        const addrInput = document.querySelector('input[name="obj_address"]');
        if (!addrInput) {
          // Forma dar nepasirodė — laukiame toliau (kas 500ms, iki 60s)
          if (attempt === 0) log('ESO: laukiama kol pasirodys forma (pasirinkite rangovo tipą ir spauskite Toliau)...');
          setTimeout(() => tryFill(attempt + 1), 500);
          return;
        }

        // Forma paruošta — pildome
        log('ESO: forma pasirodė — pildome laukus');
        if (!fillAngular()) {
          setTimeout(() => tryFill(attempt + 1), 500);
        }
      };

      // Pradedame tikrinti po 2s (puslapiui stabilizuotis)
      setTimeout(() => tryFill(), 2000);
    }

    if (hashMatch) {
      try {
        const task = JSON.parse(decodeURIComponent(escape(atob(hashMatch[1]))));
        log('ESO: duomenys iš URL hash');
        fillEsoForm(task);
      } catch (e) { log('Hash klaida: ' + e.message); }
    } else {
      // Bandome iš kl-eso-tasks
      digpointGet('/api/store/kl-eso-tasks', (err, data) => {
        if (err || !data || !data.value) { log('ESO: nėra užduočių'); return; }
        const tasks = (data.value || []).filter(t => t.status === 'pending');
        if (!tasks.length) { log('ESO: nėra pending užduočių'); return; }
        log(`ESO: rasta ${tasks.length} užduotis`);
        fillEsoForm(tasks[0]);
      });
    }
    return;
  }

})();
