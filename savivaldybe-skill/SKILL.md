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

Iš karto gauk ir prašymo failus:
```javascript
fetch('/api/store/kl-permits').then(r=>r.json()).then(d=>{
  var p=(d.value||[]).find(x=>x.id==='{permitId}');
  return JSON.stringify((p&&p.files||[]).map(f=>({name:f.name,url:f.url,filename:f.filename})));
})
```
Išsaugok failų sąrašą — prireiks 7 žingsnyje.

Jei `kl-sav-task` nerastas arba `status` nėra "pending" — pranešk:
> "Nerasta paraiška. Pirmiau Digpoint sistemoje spausk '🚀 Pateikti Savivaldybei automatiškai'."

**Adresas:** Iš `location` ištrauk gatvę ir namą:
- Pvz. "Kranto g. 20, Kaunas" → gatvė = "Kranto g.", namas = "20"
- Pvz. "V. Krėvės pr. 120, Kaunas" → gatvė = "V. Krėvės pr.", namas = "120"
- Taisyklė: viskas iki paskutinio skaičiaus = gatvė; skaičius (su raide jei yra) = namas

### 1a žingsnis — Adresas iš PDF (jei `location` tuščias)

Jei `location` yra tuščias — ištraukti adresą iš PDF:
```javascript
fetch('/api/store/kl-permits').then(r=>r.json()).then(d=>{
  var p=(d.value||[]).find(x=>x.id==='{permitId}');
  return JSON.stringify((p&&p.files||[]).map(f=>({name:f.name,url:f.url})));
})
```
Atidaryk pirmą PDF naujame skirtuke: `http://10.2.1.115:3001{file.url}` ir ištrauk adresą tekstuose ieškodamas "OBJEKTO VIETA", "STATYBOS VIETA" ar panašiai.

## 2 žingsnis — Atidaryti kasimai.kaunas.lt

Naviguok į `https://kasimai.kaunas.lt/mano-prasymai/`

Jei matai "prisijungti per elektroninius valdžios vartus" — **sustok** ir pranešk:
> "Reikia prisijungti prie kasimai.kaunas.lt per e. valdžios vartus, tada rašyk 'pateik Savivaldybei' iš naujo."

Palaukyk kol matysi prašymų sąrašą.

## 3 žingsnis — Kopijuoti paskutinį prašymą

1. Spausti **pirmą prašymą** sąraše — išsiskleis detalės
2. Slinkti žemyn iki mygtukų
3. Rasti ir paspausti **"Kopijuoti prašymą"** per JavaScript:
```javascript
var link = Array.from(document.querySelectorAll('a')).find(function(a){
  return a.textContent.trim().includes('Kopijuoti');
});
if(link && link.href){ location.href = link.href; 'OK'; } else { 'NERASTA'; }
```
4. Palaukti kol forma užsikraus su antrašte **"NAUJAS PRAŠYMAS (KOPIJAVIMAS)"**

## 4 žingsnis — Darbų vadovo duomenys

Spausti ant **"Darbų vadovo duomenys:"** antraštės kad ją išskleistum.

Užpildyti **visus** laukus (ne tik skirtingus):
```javascript
function setInput(name, val){
  var el=document.querySelector('input[name="'+name+'"],textarea[name="'+name+'"]');
  if(!el||!val)return false;
  el.value=val;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
var nameParts = '{manager}'.split(' ');
var firstName = nameParts[0]||'';
var lastName = nameParts.slice(1).join(' ')||'';
setInput('dv_vardas', firstName);
setInput('dv_pavarde', lastName);
setInput('dv_tel', '{managerPhone}');
setInput('dv_epastas', '{managerEmail}');
// Bandyti alternatyvius el. pašto lauko vardus jei pirmas nepavyko:
['dv_email','dv_el_pastas','email'].forEach(function(n){
  setInput(n, '{managerEmail}');
});
'Vadovo duomenys užpildyti';
```

## 5 žingsnis — Darbų duomenys

Spausti ant **"Darbų duomenys:"** antraštės kad ją išskleistum.

**Darbų periodas:**
```javascript
function setInput(name, val){
  var el=document.querySelector('input[name="'+name+'"]');
  if(!el)return;
  el.value=val;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
setInput('darbai_pradzia', '{startDate}');
setInput('darbai_pabaiga', '{endDate}');
```

**Planuojami vykdyti darbai** (select):
```javascript
var sel=document.querySelector('select[name="planuojami_darbai"]');
if(sel){
  var opt=Array.from(sel.options).find(o=>o.text.toLowerCase().includes('elektros tinkl'));
  if(opt){sel.value=opt.value;sel.dispatchEvent(new Event('change',{bubbles:true}));}
}
```

## 6 žingsnis — Darbų vieta (Gatvė, Namas, Seniūnija)

Spausti ant **"Darbų pradžia"** skyriaus.

Gatvės laukas yra autocomplete — reikia įvesti tekstą ir palaukti pasiūlymų:

**6a — Įvesti gatvę:**
Surask gatvės įvesties lauką ir įvesk gatvės pavadinimą. Jei yra `input` laukas su placeholder "Pasirinkite" arba name "gatve":
```javascript
var gatveEl = document.querySelector('input[name="gatve"], input[placeholder*="atve"], input[placeholder*="asirinkite"]');
if(gatveEl){
  gatveEl.value = '{gatvės pavadinimas}';
  gatveEl.dispatchEvent(new Event('input',{bubbles:true}));
  gatveEl.dispatchEvent(new Event('keyup',{bubbles:true}));
  'Gatvė įvesta — laukiama pasiūlymų';
} else { 'Gatvės laukas nerastas'; }
```

Palaukti ~2 sekundes kol pasirodys autocomplete sąrašas.

**6b — Pasirinkti iš sąrašo:**
Ekrano nuotrauką ir surask pasirodžiusius pasiūlymus. Spausti ant atitinkančio gatvės pavadinimo.

Jei pasiūlymų nėra — bandyti su trumpesniu gatvės pavadinimu (pvz. vietoj "V. Krėvės pr." bandyti "Krėvės").

**6c — Namas ir Seniūnija:**
Po gatvės pasirinkimo gali atsirasti Namo ir Seniūnijos laukai. Užpildyti:
```javascript
function setSelect(name, val){
  var el=document.querySelector('select[name="'+name+'"],input[name="'+name+'"]');
  if(!el)return false;
  // Jei select — rasti artimiausią option
  if(el.tagName==='SELECT'){
    var opt=Array.from(el.options).find(o=>o.text.includes(val)||o.value===val);
    if(opt){el.value=opt.value;el.dispatchEvent(new Event('change',{bubbles:true}));return true;}
    return false;
  }
  el.value=val;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
setSelect('namas', '{namas}');
// Seniūnija — automatiškai turėtų užsipildyti po gatvės pasirinkimo
```

Jei laukai nerandami — padaryti ekrano nuotrauką ir pranešti vartotojui kokie laukai liko tušti.

## 7 žingsnis — Prašymo priedas (failo įkėlimas)

Spausti ant **"Prašymo priedai:"** antraštės kad ją išskleistum.

Iš 1 žingsnio turimų failų pasirinkti tinkamą priedą — pirmenybė:
1. Failas kurio pavadinime yra "projektas", "schema", "planas"
2. Jei nėra — pirmasis PDF failas iš paraiškos

Parsisiųsti failą iš Digpoint:
```javascript
// Pasirinkto failo URL: http://10.2.1.115:3001{file.url}
```

Surasti failo įkėlimo lauką puslapyje:
```javascript
var fileInput = document.querySelector('input[type="file"]');
fileInput ? 'Rastas: '+fileInput.name : 'Nerastas';
```

Naudoti `file_upload` įrankį su failo `ref` iš `read_page` arba `find` — **ne** spausti ant mygtuko (atidarytų sisteminį dialogą).

Jei failų nėra arba įkėlimas nepavyksta — pranešti vartotojui ir tęsti be priedo.

## 8 žingsnis — Išsiųsti pranešimą ir sustoti

**NESAUGOTI** — vartotojas pats prisijungs ir patvirtins.

Padaryti ekrano nuotrauką formos būklei užfiksuoti.

Išsiųsti pranešimą per Digpoint (Digpoint skirtuke):
```javascript
fetch('/api/admin/notify', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    to: '{notifyEmail}',
    subject: '✅ Savivaldybės forma paruošta — reikia prisijungti ir saugoti',
    html: '<h2>🏛 Kauno m. sav. forma užpildyta</h2><p>Claude automatiškai užpildė kasimo leidimo prašymą kasimai.kaunas.lt.</p><h3>Užpildyta:</h3><ul><li><b>Darbų vadovas:</b> {manager}, {managerPhone}, {managerEmail}</li><li><b>Vieta:</b> {location}</li><li><b>Laikotarpis:</b> {startDate} – {endDate}</li></ul><h3>Reikia jūsų:</h3><ol><li>Atsidaryti kasimai.kaunas.lt naršyklėje</li><li>Prisijungti per e. valdžios vartus</li><li>Patikrinti žemėlapį ir ardomą dangą</li><li>Spausti <b>Saugoti</b></li></ol>'
  })
}).then(r=>r.json())
```

Pranešti pokalbio lange:
```
✅ Forma paruošta — kasimai.kaunas.lt

Užpildyta:
• Darbų vadovas: {manager} {managerPhone} {managerEmail}
• Vieta: {location}
• Laikotarpis: {startDate} – {endDate}

📧 Pranešimas išsiųstas → {notifyEmail}

Reikia jūsų:
1. Prisijungti prie kasimai.kaunas.lt per e. valdžios vartus
2. Patikrinti žemėlapį, ardomą dangą, ir priedus
3. Spausti "Saugoti"
```

## Klaidų atvejai

| Situacija | Veiksmas |
|-----------|----------|
| `kl-sav-task` nerastas | Pranešti, sustoti |
| Neprisijungta prie kasimai.kaunas.lt | Pranešti vartotojui, sustoti |
| Prašymų sąrašas tuščias | Pranešti kad reikia ankstesnio prašymo |
| `location` tuščias | Ištraukti iš PDF (1a žingsnis) |
| Gatvės autocomplete neranda | Bandyti su trumpesniu pavadinimu, pranešti vartotojui |
| Failo įkėlimas nepavyksta | Praleisti, pranešti vartotojui |
| Laukas nerandamas | Praleisti, pranešti vartotojui |
