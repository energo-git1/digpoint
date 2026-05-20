---
name: savivaldybe
description: >
  Naudok šį skill'ą kai vartotojas sako "Pateik Savivaldybei", "pateik kasimai", "kauno savivaldybė forma",
  "užpildyk savivaldybės formą" arba panašiai. Automatiškai atidaro kasimai.kaunas.lt, nukopijuoja
  paskutinį prašymą ir užpildo kintamus laukus iš Digpoint paraiškos duomenų. Sustoja prieš išsaugant.
---

# Kauno m. sav. prašymo automatinis pateikimas

## Tikslas

Nukopijuoti paskutinį kasimai.kaunas.lt prašymą ir užpildyti kintamus laukus iš Digpoint paraiškos.
Sustoti prieš išsaugant — vartotojas pats prisijungia per e. valdžios vartus ir patvirtina.

## 1 žingsnis — Gauti paraiškos duomenis

Digpoint skirtuke (`http://10.2.1.115:3001`) vykdyk:
```javascript
fetch('/api/store/kl-sav-task').then(r=>r.json()).then(d=>JSON.stringify(d))
```

Išsaugok šiuos laukus iš `value` objekto:
- `permitId` — paraiškos ID
- `manager` — darbų vadovo vardas pavardė
- `managerPhone` — darbų vadovo tel. nr.
- `managerEmail` — darbų vadovo el. paštas
- `startDate` — darbų pradžia (YYYY-MM-DD)
- `endDate` — darbų pabaiga (YYYY-MM-DD)
- `description` — planuojami darbai
- `location` — darbų vieta
- `notifyEmail` — kam siųsti pranešimą

Jei `kl-sav-task` nėra arba `status` nėra "pending" — pranešk:
> "Nerasta paraiška. Pirmiau Digpoint sistemoje spausk '🚀 Pateikti Savivaldybei automatiškai'."

### 1a žingsnis — Adresas iš PDF (jei `location` tuščias)

Jei `location` yra tuščias — **privaloma** ištraukti adresą iš PDF:

```javascript
// Digpoint skirtuke — rasti PDF failo URL
fetch('/api/store/kl-permits')
  .then(r=>r.json())
  .then(d=>{
    var p=(d.value||[]).find(x=>x.id==='{permitId}');
    JSON.stringify((p&&p.files||[]).map(f=>({name:f.name,url:f.url})));
  })
```

Atidaryk PDF naujame skirtuke: `http://10.2.1.115:3001{file.url}`

Ištrauk adresą naudodamas PDF.js:
```javascript
async function getAddr(){
  await new Promise((res,rej)=>{var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
  var lib=window['pdfjs-dist/build/pdf']||window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var pdf=await lib.getDocument(window.location.href).promise;
  var txt='';
  for(var i=1;i<=Math.min(pdf.numPages,3);i++){var pg=await pdf.getPage(i);var tc=await pg.getTextContent();txt+=tc.items.map(x=>x.str).join(' ')+'\n';}
  var m=txt.match(/OBJEKTO\s+VIETA[:\s]+([^\n]{5,80})/i)||txt.match(/STATYBOS\s+VIETA[:\s]+([^\n]{5,80})/i);
  return m?m[1].trim():'nerasta';
}
getAddr()
```

Rastą adresą naudok kaip `location` tolimesniuose žingsniuose. Adresą suformatuok: "Gatvė Nr., Kaunas" (be "Kauno m. sav." ir pan.).

## 2 žingsnis — Atidaryti kasimai.kaunas.lt

Naviguok į `https://kasimai.kaunas.lt/mano-prasymai/`

Jei matai "prisijungti per elektroninius valdžios vartus" — **sustok** ir pranešk vartotojui:
> "Reikia prisijungti prie kasimai.kaunas.lt per e. valdžios vartus, tada rašyk 'pateik Savivaldybei' iš naujo."

Palaukyk kol matysi prašymų sąrašą su numeruotomis eilutėmis.

## 3 žingsnis — Kopijuoti paskutinį prašymą

1. Spausti **pirmą prašymą** sąraše (jis yra naujausias) — išsiskleis detalės
2. Slinkti žemyn kol matysi mygtukus su tekstais "Darbai žemėlapyje", "Kopijuoti prašymą", "Atsisiųsti PDF"
3. Spausti **žalią mygtuką "Kopijuoti prašymą"**
4. Palaukti kol atsidarys forma su antrašte **"NAUJAS PRAŠYMAS (KOPIJAVIMAS)"**

Jei prašymų sąrašas tuščias — pranešk kad reikia bent vieno ankstesnio prašymo.

## 4 žingsnis — Atnaujinti Darbų vadovo duomenis

Spausti ant **"Darbų vadovo duomenys:"** antraštės kad ją išskleistum.

Patikrinti esamas reikšmes:
```javascript
var dvInputs = Array.from(document.querySelectorAll('input')).filter(i=>i.name&&i.name.startsWith('dv_'));
JSON.stringify(dvInputs.map(i=>({name:i.name,val:i.value})));
```

Lyginti su task duomenimis. Atnaujinti laukus kurie skiriasi:
```javascript
function setVal(name, val){
  var el=document.querySelector('input[name="'+name+'"]');
  if(!el)return;
  el.value=val;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
// Atnaujinti tik skirtingus laukus
setVal('dv_vardas', '{manager vardas}');
setVal('dv_pavarde', '{manager pavardė}');
setVal('dv_tel', '{managerPhone}');
// dv_email — palikti iš kopijos (kopijoje yra tikras vadovo el. paštas)
```

## 5 žingsnis — Atnaujinti Darbų duomenis

Spausti ant **"Darbų duomenys:"** antraštės kad ją išskleistum.

**Darbų periodas** (jei `startDate` ir `endDate` nėra tušti):
```javascript
setVal('darbai_pradzia', '{startDate}');
setVal('darbai_pabaiga', '{endDate}');
```

Jei datos tuščios — palikti nukopijuotas datas ir informuoti vartotoją.

**Darbų vieta (gatvė):**
```javascript
// Iš location ištraukti gatvę — pvz. "Vytauto pr. 37A, Kaunas" → "Vytauto pr."
// Naudoti autocomplete lauką 'gatve'
var gatveInput = document.querySelector('input[name="gatve"]');
if(gatveInput){
  gatveInput.value = '{gatvės pavadinimas iš location}';
  gatveInput.dispatchEvent(new Event('input',{bubbles:true}));
  // Palaukti autocomplete pasiūlymus ir pasirinkti tinkamą
}
```

**Planuojami vykdyti darbai:**
- Tai select laukas — pasirinkti "Elektros tinklų įrengimas" arba artimiausią
```javascript
var sel = document.querySelector('select[name="planuojami_darbai"]');
var opt = Array.from(sel.options).find(o=>o.text.toLowerCase().includes('elektros tinkl'));
if(opt){ sel.value=opt.value; sel.dispatchEvent(new Event('change',{bubbles:true})); }
```

**Kiti laukai** (Ardoma danga, eismas) — **palikti kaip nukopijuota**.

## 6 žingsnis — Išsiųsti pranešimą ir sustoti

**NESAUGOTI** — vartotojas pats prisijungs ir patvirtins.

Padaryti ekrano nuotrauką formos būklei užfiksuoti.

Tada išsiųsti pranešimą per Digpoint:
```javascript
// Digpoint skirtuke vykdyti:
fetch('/api/admin/notify', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    to: '{notifyEmail}',
    subject: '✅ Savivaldybės forma paruošta — reikia prisijungti ir saugoti',
    html: '<h2>🏛 Kauno m. sav. forma užpildyta</h2><p>Claude automatiškai užpildė kasimo leidimo prašymą kasimai.kaunas.lt.</p><h3>Užpildyta:</h3><ul><li><b>Darbų vadovas:</b> {manager} {managerPhone}</li><li><b>Vieta:</b> {location}</li><li><b>Laikotarpis:</b> {startDate} – {endDate}</li></ul><h3>Reikia jūsų:</h3><ol><li>Atsidaryti kasimai.kaunas.lt naršyklėje</li><li>Prisijungti per e. valdžios vartus</li><li>Patikrinti žemėlapį ir ardomą dangą</li><li>Spausti <b>Saugoti</b></li></ol>'
  })
}).then(r=>r.json())
```

Pranešti pokalbio lange:
```
✅ Forma paruošta — kasimai.kaunas.lt

Užpildyta:
• Darbų vadovas: {manager} {managerPhone}
• Vieta: {location}
• Laikotarpis: {startDate} – {endDate}

📧 Pranešimas išsiųstas → {notifyEmail}

Reikia jūsų:
1. Prisijungti prie kasimai.kaunas.lt per e. valdžios vartus
2. Patikrinti žemėlapį ir ardomą dangą
3. Spausti "Saugoti"
```

## Klaidų atvejai

| Situacija | Veiksmas |
|-----------|----------|
| `kl-sav-task` nerastas | Pranešti, sustoti |
| Neprisijungta prie kasimai.kaunas.lt | Pranešti vartotojui, sustoti |
| Prašymų sąrašas tuščias | Pranešti kad reikia ankstesnio prašymo |
| `location` tuščias | Ištraukti iš PDF (1a žingsnis) |
| Laukas nerandamas | Praleisti, pranešti vartotojui |
| Autocomplete neranda gatvės | Pranešti vartotojui, užpildyti rankiniu būdu |
