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
Sustoti prieš išsaugant — vartotojas pats patvirtina.

## 1 žingsnis — Gauti paraiškos duomenis

Atlik GET užklausą:
```
http://10.2.1.115:3001/api/store/kl-sav-task
```

Naudok `mcp__workspace__web_fetch` arba `javascript_tool` naršyklės kortelėje.

Išsaugok šiuos laukus iš `value` objekto:
- `manager` — darbų vadovo vardas pavardė
- `managerPhone` — darbų vadovo tel. nr.
- `managerEmail` — darbų vadovo el. paštas
- `startDate` — darbų pradžia (YYYY-MM-DD)
- `endDate` — darbų pabaiga (YYYY-MM-DD)
- `description` — planuojami darbai
- `location` — darbų vieta (informacijai)

Jei `kl-sav-task` nėra arba `status` nėra "pending" — pranešk:
> "Nerasta paraiška. Pirmiau Digpoint sistemoje spausk '🚀 Pateikti Savivaldybei automatiškai'."

## 2 žingsnis — Atidaryti kasimai.kaunas.lt

Naviguok į `https://kasimai.kaunas.lt/mano-prasymai/`

Palaukyk kol matysi prašymų sąrašą su numeruotomis eilutėmis.

## 3 žingsnis — Kopijuoti paskutinį prašymą

1. Spausti **pirmą prašymą** sąraše (jis yra naujausias) — išsiskleis detalės
2. Slinkti žemyn kol matysi mygtukus su tekstais "Darbai žemėlapyje", "Kopijuoti prašymą", "Atsisiųsti PDF"
3. Spausti **žalią mygtuką "Kopijuoti prašymą"**
4. Palaukti kol atsidarys forma su antrašte **"NAUJAS PRAŠYMAS (KOPIJAVIMAS)"**

Jei prašymų sąrašas tuščias — pranešk kad reikia bent vieno ankstesnio prašymo.

## 4 žingsnis — Atnaujinti Darbų vadovo duomenis

Spausti ant **"Darbų vadovo duomenys:"** antraštės kad ją išskleistum.

Naudoti `javascript_tool` kad patikrintum esamas reikšmes:
```javascript
document.querySelectorAll('input[type="text"]').forEach(i => console.log(i.name || i.placeholder, '=', i.value))
```

Lyginti su task duomenimis. Jei skiriasi — atnaujinti laukus:
- Vardas + Pavardė pagal `manager`
- Telefonas pagal `managerPhone`
- El. paštas pagal `managerEmail`

Jei sutampa — palikti kaip yra.

## 5 žingsnis — Atnaujinti Darbų duomenis

Spausti ant **"Darbų duomenys:"** antraštės kad ją išskleistum.

**Darbų periodas:**
- Laukas "Nuo:" — įvesti `startDate` (YYYY-MM-DD formatas)
- Laukas "Iki:" — įvesti `endDate` (YYYY-MM-DD formatas)

Naudoti `form_input` arba tiesiogiai per `javascript_tool`:
```javascript
document.querySelector('input[name="data_nuo"]').value = 'YYYY-MM-DD';
document.querySelector('input[name="data_iki"]').value = 'YYYY-MM-DD';
```
Jei name atributai skiriasi — naudoti `read_page` kad rastum tinkamus ref.

**Planuojami vykdyti darbai:**
- Tai autocomplete laukas — spausti jį ir ieškoti reikšmės pagal `description`
- Dažniausios reikšmės: "Elektros kabelio tiesimas", "Elektros kabelio remontas", "Šilumos tinklų remontas"
- Jei tikslaus atitikmens nėra — palikti nukopijuotą reikšmę ir informuoti vartotoją

**Kiti laukai** (Ardoma danga, eismas) — **palikti kaip nukopijuota**.

## 6 žingsnis — Sustoti ir pranešti

**NESAUGOTI** — vartotojas pats spaudžia "Saugoti".

Padaryti ekrano nuotrauką ir pranešti:

```
✅ Forma paruošta — kasimai.kaunas.lt

Užpildyta iš Digpoint paraiškos:
• Darbų vadovas: [manager] [managerPhone]
• Laikotarpis: [startDate] – [endDate]
• Vieta: [location]

Prašau naršyklėje patikrinkite:
1. Darbų vadovo duomenis
2. Laikotarpį
3. Planuojamus darbus
4. Ardomą dangą ir plotą (reikia pildyti rankiniu būdu)
5. Žemėlapį (darbų vieta)

Kai viskas gerai — spauskite "Saugoti".
```

## Klaidų atvejai

| Situacija | Veiksmas |
|-----------|----------|
| `kl-sav-task` nerastas | Pranešti, sustoti |
| Prašymų sąrašas tuščias | Pranešti kad reikia ankstesnio prašymo |
| Puslapis neatsikrovė / nėra prisijungta | Pranešti patikrinti naršyklę |
| Laukas nerandamas | Praleisti, pranešti vartotojui ką reikia pildyti rankiniu būdu |
| Autocomplete neranda reikšmės | Palikti nukopijuotą, pranešti |
