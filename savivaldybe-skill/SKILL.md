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

Iš karto gauk ir prašymo `savivaldybePreparation` duomenis bei failus:
```javascript
fetch('/api/store/kl-permits').then(r=>r.json()).then(d=>{
  var p=(d.value||[]).find(x=>x.id==='{permitId}');
  var prep=p&&p.savivaldybePreparation||{};
  var files=(p&&p.files||[]).map(f=>({name:f.name,url:f.url,filename:f.filename}));
  return JSON.stringify({prep:prep, files:files});
})
```
Išsaugok `prep` (savivaldybePreparation) ir `files` — prireiks 7 žingsnyje PDF generavimui.

Jei `kl-sav-task` nerastas arba `status` nėra "pending" — pranešk:
> "Nerasta paraiška. Pirmiau Digpoint sistemoje spausk '🚀 Pateikti'."

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

Užpildyti **visus** laukus:
```javascript
function setInput(sel, val){
  var el=document.querySelector(sel);
  if(!el||val===undefined||val===null)return false;
  el.value=val;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
var nameParts = '{manager}'.split(' ');
setInput('input[name="dv_vardas"]', nameParts[0]||'');
setInput('input[name="dv_pavarde"]', nameParts.slice(1).join(' ')||'');
setInput('input[name="dv_tel"]', '{managerPhone}');

// El. paštas — bandome visus galimus laukų vardus, tada type="email"
var emailVal = '{managerEmail}';
var emailFilled = ['dv_epastas','dv_email','dv_el_pastas','el_pastas','email'].some(function(n){
  return setInput('input[name="'+n+'"]', emailVal);
});
if(!emailFilled){
  var emailEl = document.querySelector('input[type="email"]');
  if(emailEl){
    emailEl.value=emailVal;
    emailEl.dispatchEvent(new Event('input',{bubbles:true}));
    emailEl.dispatchEvent(new Event('change',{bubbles:true}));
    emailFilled=true;
  }
}
emailFilled ? 'El. paštas užpildytas' : 'PERSPEJIMAS: el. pasto laukas NERASTAS';
```

Padaryti ekrano nuotrauką. Jei el. paštas neužpildytas — rasti lauką per `read_page` ir užpildyti su `form_input`.

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

**Eismas — transporto ir keleivinio transporto klausimai:**

Ieškoti select laukų su tekstu apie eismą ir nustatyti "Ne":
```javascript
var allSelects = Array.from(document.querySelectorAll('select'));
var filled = [];
allSelects.forEach(function(sel){
  // Gauti artimiausią label tekstą
  var labelText = '';
  var el = sel;
  while(el && !labelText.trim()){
    var prev = el.previousElementSibling;
    if(prev) labelText = prev.textContent||'';
    el = el.parentElement;
    if(el) labelText = labelText || (el.querySelector('label,p,div:first-child')||{}).textContent||'';
  }
  var lc = labelText.toLowerCase();
  if(lc.includes('eismas')||lc.includes('transporto')||lc.includes('ribojamas')||lc.includes('nutraukiamas')){
    var neOpt = Array.from(sel.options).find(function(o){
      var ot = o.text.trim().toLowerCase();
      return ot==='ne'||o.value==='ne'||o.value==='0'||o.value==='false'||o.value==='2';
    });
    if(neOpt){
      sel.value=neOpt.value;
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      filled.push((sel.name||sel.id||'?')+' = '+neOpt.text);
    }
  }
});
filled.length>0 ? 'Eismo laukai: '+filled.join('; ') : 'Eismo laukų nerasta automatiškai';
```

Padaryti ekrano nuotrauką. Jei eismo laukai neužpildyti — rasti juos per `read_page` ir užpildyti su `form_input` pasirenkant "Ne".

## 6 žingsnis — Darbų vieta (Gatvė, Namas, Seniūnija)

Spausti ant **"Darbų pradžia"** skyriaus.

**6a — Įvesti gatvę:**
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
```javascript
function setField(name, val){
  var el=document.querySelector('select[name="'+name+'"],input[name="'+name+'"]');
  if(!el)return false;
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
setField('namas', '{namas}');
```

## 7 žingsnis — Prašymo priedas (sugeneruotas PDF)

Spausti ant **"Prašymo priedai:"** antraštės kad ją išskleistum.

Digpoint serveris turi CORS leidimą kasimai.kaunas.lt — galima fetch'inti tiesiai iš kasimai skirtuko.

**Kasimai skirtuke** vykdyk (naudodamas `prep` iš 1 žingsnio ir `permitId`):
```javascript
(async function(){
  var DIGPOINT = 'http://10.2.1.115:3001';
  var prep = /* prep objektas iš 1 žingsnio */;
  var extraFns = (prep.extraFiles||[]).filter(function(f){return f&&f.filename;}).map(function(f){
    var pgs=prep.extraPages&&prep.extraPages[f.filename];
    return pgs&&pgs.length>0 ? f.filename+'__pages:'+pgs.join(',') : f.filename;
  });
  var selWithPages = (prep.selectedFilenames||[]).map(function(fn){
    var base=fn.split('__pages:')[0];
    var pgs=prep.docPages&&prep.docPages[base];
    return pgs&&pgs.length>0 ? base+'__pages:'+pgs.join(',') : fn;
  });
  if(!selWithPages.length && !extraFns.length) return 'TUŠČIA: nėra pasirinktų failų priedams';
  var r = await fetch(DIGPOINT+'/api/admin/merge-sav-priedai',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({permitId:prep.srcId||null, selectedFilenames:selWithPages, extraFilenames:extraFns, location:'{location}'})
  });
  var d = await r.json();
  if(!d.ok) return 'KLAIDA: '+(d.error||'nezinoma');
  // Sukurti File objektą iš base64 ir priskirti prie input
  var binary = atob(d.content);
  var bytes = new Uint8Array(binary.length);
  for(var i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  var file = new File([bytes], d.filename||'priedai_savivaldybei.pdf', {type:'application/pdf'});
  var input = document.querySelector('input[type="file"]');
  if(!input) return 'FILE INPUT NERASTAS';
  var dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
  return 'OK: '+file.name+' '+Math.round(file.size/1024)+' KB įkeltas ('+d.pages+' psl.)';
})()
```

Patikrinti rezultatą — turi grąžinti `OK: priedai_xxx.pdf ... KB įkeltas`.

Jei `savivaldybePreparation` tuščias arba failų nėra — praleisti šį žingsnį ir pranešti vartotojui.

## 8 žingsnis — Išsiųsti pranešimą ir sustoti

**NESAUGOTI** — vartotojas pats prisijungs ir patvirtins.

Padaryti ekrano nuotrauką.

Digpoint skirtuke išsiųsti pranešimą:
```javascript
fetch('/api/admin/notify', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    to: '{notifyEmail}',
    subject: 'Savivaldybes forma paruosta — reikia prisijungti ir saugoti',
    html: '<h2>Kauno m. sav. forma uzpildyta</h2><p>Claude automatiskai uzpilde kasimo leidimo praasyma kasimai.kaunas.lt.</p><ul><li><b>Darbu vadovas:</b> {manager}, {managerPhone}, {managerEmail}</li><li><b>Vieta:</b> {location}</li><li><b>Laikotarpis:</b> {startDate} – {endDate}</li></ul><p>Reikia: prisijungti per e. valdzios vartus ir spausti Saugoti.</p>'
  })
}).then(r=>r.json())
```

## Klaidų atvejai

| Situacija | Veiksmas |
|-----------|----------|
| `kl-sav-task` nerastas | Pranešti, sustoti |
| Neprisijungta prie kasimai.kaunas.lt | Pranešti, sustoti |
| Prašymų sąrašas tuščias | Pranešti kad reikia ankstesnio prašymo |
| `location` tuščias | Ištraukti iš PDF (1a žingsnis) |
| El. pašto laukas nerandamas | Ieškoti `input[type="email"]`, tada `read_page` + `form_input` |
| Eismo laukai nerandami | Screenshot, užpildyti rankiniu būdu per `form_input` |
| Gatvės autocomplete neranda | Bandyti su trumpesniu pavadinimu |
| `savivaldybePreparation` tuščias | Praleisti PDF įkėlimą, pranešti |
| Failo įkėlimas nepavyksta | Praleisti, pranešti |
