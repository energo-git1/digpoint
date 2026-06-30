/**
 * sync-leidimai.js — Sinchronizuoja gautus leidimus į tinklo aplanką
 *
 * Naudojimas (Windows mašinoje su prieiga prie \\serv2003 ir 10.2.1.115):
 *   node sync-leidimai.js
 *
 * Kas daroma:
 *   1. Iš Digpoint API gauna visas paraiškas su statusu "Gautas leidimas"
 *   2. Kiekvienai paraiškai ieško aplanko \\serv2003\...\00 Vykdomi kurio
 *      pavadinime yra internalCode (pvz. "158NV-25M")
 *   3. Jei rastas — sukuria "Leidimai" poaplankį (jei nėra) ir išsaugo PDF
 *   4. Jei nerastas — praneša
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');

const DIGPOINT_API = 'http://10.2.1.115:3001';
const VYKDOMI_DIR  = '\\\\serv2003\\Projektu_valdymas\\03 OBJEKTAI\\00 Vykdomi';
const LEIDIMAI_DIR = 'Leidimai';

// --- helpers ---

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchJson(path) {
  const buf = await httpGet(DIGPOINT_API + path);
  return JSON.parse(buf.toString());
}

async function downloadFile(urlPath) {
  return httpGet(DIGPOINT_API + urlPath);
}

// Ieško aplanko kurio pavadinime yra code (case-insensitive)
function findProjectFolder(code) {
  if (!fs.existsSync(VYKDOMI_DIR)) {
    throw new Error(`Tinklo aplankas nepasiekiamas: ${VYKDOMI_DIR}`);
  }
  const entries = fs.readdirSync(VYKDOMI_DIR, { withFileTypes: true });
  const match = entries.find(e =>
    e.isDirectory() && e.name.toUpperCase().includes(code.toUpperCase())
  );
  return match ? path.join(VYKDOMI_DIR, match.name) : null;
}

// --- pagrindinis ---

async function main() {
  console.log('Jungiamasi prie Digpoint...');
  const data = await fetchJson('/api/store/kl-permits');
  const permits = data.value || [];

  const approved = permits.filter(p =>
    p.status === 'Gautas leidimas' && p.permitPdfs && Object.keys(p.permitPdfs).length > 0
  );

  console.log(`Rasta ${approved.length} paraiška(-ų) su statusu "Gautas leidimas"\n`);

  let saved = 0, skipped = 0, notFound = 0, errors = 0;

  for (const permit of approved) {
    const code = (permit.internalCode || '').trim();
    if (!code) {
      console.log(`  ⚠  [${permit.id.slice(-5).toUpperCase()}] internalCode tuščias — praleidžiama`);
      skipped++;
      continue;
    }

    const pdfs = Object.values(permit.permitPdfs);

    // Rasti projekto aplanką
    let projectFolder;
    try {
      projectFolder = findProjectFolder(code);
    } catch (e) {
      console.error(`  ✖  ${e.message}`);
      process.exit(1);
    }

    if (!projectFolder) {
      console.log(`  ✖  [${code}] Aplankas nerastas ${VYKDOMI_DIR}`);
      notFound++;
      continue;
    }

    // Sukurti Leidimai poaplankį
    const leidimaiPath = path.join(projectFolder, LEIDIMAI_DIR);
    if (!fs.existsSync(leidimaiPath)) {
      fs.mkdirSync(leidimaiPath, { recursive: true });
      console.log(`  📁 Sukurtas: ${leidimaiPath}`);
    }

    // Išsaugoti kiekvieną PDF
    for (const pdf of pdfs) {
      const destFile = path.join(leidimaiPath, pdf.name);

      if (fs.existsSync(destFile)) {
        console.log(`  ✓  [${code}] ${pdf.name} — jau yra, praleidžiama`);
        skipped++;
        continue;
      }

      try {
        const buf = await downloadFile(pdf.url);
        fs.writeFileSync(destFile, buf);
        console.log(`  ✅ [${code}] ${pdf.name} → išsaugota (${Math.round(buf.length/1024)} KB)`);
        saved++;
      } catch (e) {
        console.log(`  ✖  [${code}] ${pdf.name} — klaida: ${e.message}`);
        errors++;
      }
    }
  }

  console.log(`\n──────────────────────────────`);
  console.log(`Išsaugota:   ${saved}`);
  console.log(`Praleista:   ${skipped}`);
  console.log(`Nerasta:     ${notFound}`);
  console.log(`Klaidos:     ${errors}`);
}

main().catch(e => { console.error('Klaida:', e.message); process.exit(1); });
