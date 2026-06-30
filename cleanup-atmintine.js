/**
 * Vienkartinis skriptas: pašalina Zemes_kasimo_darbu_atmintine_ESO.pdf
 * kopijas iš visų paraiškų files[] masyvo ir ištrina failus iš disko.
 *
 * Naudojimas (serveryje):
 *   node cleanup-atmintine.js
 */

'use strict';
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH    = path.join(__dirname, 'kasimo.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const SKIP_RE    = /^zemes_kasimo_darbu_atmintine_eso/i;

const db = new Database(DB_PATH);
const row = db.prepare("SELECT value FROM store WHERE key='kl-permits'").get();
if (!row) { console.log('kl-permits nerasta.'); process.exit(0); }

const permits = JSON.parse(row.value || '[]');
let totalRemoved = 0;
let filesDeleted = 0;

const updated = permits.map((p) => {
  const toDelete = (p.files || []).filter((f) => SKIP_RE.test(f.name || ''));
  const kept     = (p.files || []).filter((f) => !SKIP_RE.test(f.name || ''));
  if (toDelete.length === 0) return p;

  toDelete.forEach((f) => {
    if (!f.filename) return;
    // Pabandom abu galimus kelius
    const paths = [
      path.join(UPLOAD_DIR, f.filename),
      path.join('/home/data/kasimo-uploads', f.filename),
    ];
    let deleted = false;
    for (const fp of paths) {
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); filesDeleted++; deleted = true; console.log('  ✅ disk:', fp); break; }
    }
    if (!deleted) console.log('  ⚠  (failo nėra diske):', f.filename);
  });

  totalRemoved += toDelete.length;
  console.log(`Paraiška #${p.id.slice(-5).toUpperCase()}: pašalinta ${toDelete.length} įrašas(-ai), liko ${kept.length}`);
  return { ...p, files: kept };
});

if (totalRemoved > 0) {
  db.prepare("UPDATE store SET value=? WHERE key='kl-permits'").run(JSON.stringify(updated));
  console.log(`\nDB atnaujintas ✅  |  Pašalinta įrašų: ${totalRemoved}  |  Ištrinta failų: ${filesDeleted}`);
} else {
  console.log('Nieko nerasta — DB švari.');
}

db.close();
