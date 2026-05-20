---
name: eso-pateikimas
description: Automatiškai užpildo AB ESO kasimo darbų leidimo paraišką svetainėje eso.lt naudodamas duomenis iš Digpoint sistemos. Naudoti VISADA kai vartotojas sako: "pateik ESO", "užpildyk ESO formą", "pateik paraišką ESO", "eso pateikimas", "paleisk ESO agentą". Skill paima VISAS laukiančias užduotis iš Digpoint serverio, atidaro ESO svetainę kiekvienai paraiškai ir užpildo automatiškai. Viena komanda = visos paraiškos.
---

# ESO Kasimo Darbų Paraiškos Pateikimas

Šis skill automatizuoja AB ESO kasimo leidimo paraiškos pildymą svetainėje `https://www.eso.lt/aktualios-formos/kasimo-darbai/30`.

## 1. Gauk VISAS laukiančias užduotis iš Digpoint serverio

```
GET http://10.2.1.115:3001/api/store/kl-eso-tasks
```

Atsakymas bus JSON su `value` lauku — tai **masyvas** užduočių.

Jei `value` yra `null` arba tuščias masyvas — informuok vartotoją kad nėra aktyvių ESO užduočių ir prašyk pirmiausia jas sukurti Digpoint sistemoje (mygtuku „Pateikti ESO automatiškai").

Filtruok tik `status === "pending"` užduotis.

Iš kiekvieno objekto ištrauk:
- `permitId` — paraiškos ID (reikės žymint kaip atliktą)
- `manager` — darbų vadovo vardas pavardė
- `managerPhone` — telefono numeris
- `email` — ESO sutikimo gavimo el. paštas
- `location` — darbų vieta
- `startDate` — darbų pradžia (YYYY-MM-DD)
- `endDate` — darbų pabaiga (YYYY-MM-DD)
- `company` — įmonės pavadinimas
- `investNo` — investicinis numeris
- `files` — PDF failų sąrašas

## 2. Kiekvienai užduočiai — atidaryti naują ESO skirtuką ir užpildyti

Kiekvienai pending užduočiai atlik žemiau nurodytus žingsnius A–D **viename skirtuke** (arba naujame jei jau yra):

### Žingsnis A — ESO rangovas blokas

Naviguok į `https://www.eso.lt/aktualios-formos/kasimo-darbai/30`.
Surask ir spausk „Toliau" ties „ESO rangovas" sekcija.

### Žingsnis B — Formos laukai (JavaScript pagalba greičiausiai)

Užpildyk naudodamas `javascript_tool`:

```javascript
function set(name, val) {
  const el = document.querySelector('input[name="'+name+'"], textarea[name="'+name+'"]');
  if(!el) return;
  el.value = val;
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
}
set('legal_company_name', 'EnergoLT');
set('legal_manager_name', '{manager}');
set('legal_manager_phone', '{managerPhone be +370}');
set('acceptance_email', '{email}');
set('obj_address', '{location}');
set('excavation_purpose', 'Elektros tinklų įrengimas');
set('excavation_start', '{startDate}');
set('excavation_end', '{endDate}');
set('excavation_link', '');
set('technical_eso_investment_nr', '{investNo}');
// Savivaldybė
const sel = document.querySelector('select');
const kauno = sel && Array.from(sel.options).find(o => o.text.includes('Kauno m. sav'));
if(kauno) { sel.value = kauno.value; sel.dispatchEvent(new Event('change',{bubbles:true})); }
// Varnelė
const cb = document.querySelector('input[type="checkbox"]');
if(cb && !cb.checked) cb.click();
```

### Žingsnis C — PDF failai

Jei `location` tuščias — pabandyk iš PDF nuskaityti adresą:
- Atidaryk `http://10.2.1.115:3001{file.url}` naujame skirtuke
- Pirmame puslapyje rask „OBJEKTO VIETA:" eilutę
- Įrašyk rastą adresą į `obj_address`

### Žingsnis D — Statusas, pranešimas ir kitas

**1. Atnaujink paraiškos statusą Digpoint'e į „Pateikta":**
```javascript
// Digpoint skirtuke vykdyti:
fetch('/api/permits/{permitId}/status', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({status:'Pateikta', note:'ESO paraiška pateikta automatiškai'})
}).then(r=>r.json()).then(d=>JSON.stringify(d))
```

**2. Pašalink užduotį iš kl-eso-tasks:**
```javascript
// Digpoint skirtuke vykdyti:
fetch('/api/store/kl-eso-tasks')
  .then(r=>r.json())
  .then(d=>{
    var remaining = (d.value||[]).filter(t=>t.permitId!=='{permitId}');
    return fetch('/api/store/kl-eso-tasks',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:remaining})});
  }).then(r=>r.json()).then(d=>JSON.stringify(d))
```

**3. Pranešk pokalbio lange:**
`✅ Paraiška #{permitId} užpildyta ir pažymėta „Pateikta" — patikrinkite naršyklėje ir spauskite Siųsti`

Jei liko daugiau pending užduočių — tęsk su kita.

## 3. Galutinė suvestinė

Kai visos paraiškos užpildytos, pranešk:
- Kiek formų užpildyta
- Kurioms reikia rankinių veiksmų (PDF įkėlimas, adresas)
- Prašyk vartotojo patikrinti kiekvieną skirtuką ir spausti „Siųsti"
- Informuok: Digpoint'e visos paraiškos pažymėtos „Pateikta" ir matosi „Pateiktos paraiškos" rodinyje

## Klaidos atvejai

- **Puslapis neatsidaro** — pranešk vartotojui
- **Laukas nerandamas** — ESO gali būti atnaujinę formą; pranešk
- **PDF adresas nerastas** — palik tuščią, pranešk vartotojui
- **Serveris nepasiekiamas** — paprašyk patikrinti `http://10.2.1.115:3001`
