---
name: eso-pateikimas
description: Automatiškai užpildo AB ESO kasimo darbų leidimo paraišką svetainėje eso.lt naudodamas duomenis iš Digpoint sistemos. Naudoti VISADA kai vartotojas sako: "pateik ESO", "užpildyk ESO formą", "pateik paraišką ESO", "eso pateikimas", "paleisk ESO agentą". Skill paima užduotį iš Digpoint serverio, atidaro ESO svetainę, užpildo visus laukus automatiškai ir sustoja prieš galutinį siuntimą — kad vartotojas galėtų patikrinti prieš patvirtindamas.
---

# ESO Kasimo Darbų Paraiškos Pateikimas

Šis skill automatizuoja AB ESO kasimo leidimo paraiškos pildymą svetainėje `https://www.eso.lt/aktualios-formos/kasimo-darbai/30`.

## 1. Gauk užduoties duomenis iš Digpoint serverio

Pirmas žingsnis — paimk užduotį iš Digpoint serverio:

```
GET http://localhost:3001/api/store/kl-eso-task
```

Atsakymas bus JSON su `value` lauku. Jei `value` yra `null` arba `status !== "pending"` — informuok vartotoją kad nėra aktyvios ESO užduoties ir prašyk pirmiausia ją sukurti Digpoint sistemoje (mygtuku „Pateikti ESO automatiškai").

Iš `value` objekto ištrauk šiuos laukus:
- `manager` — darbų vadovo vardas pavardė
- `managerPhone` — telefono numeris (formatas: +370XXXXXXXX)
- `email` — ESO sutikimo gavimo el. paštas
- `location` — darbų vieta (adresas)
- `startDate` — darbų pradžia (YYYY-MM-DD)
- `endDate` — darbų pabaiga (YYYY-MM-DD)
- `company` — įmonės pavadinimas (EnergoLT)
- `description` — darbų aprašas (jei tuščias, naudok "Kasimo darbai pagal projektą")
- `files` — PDF failų sąrašas (masyvas su `name` laukais)
- `investNo` — investicinis numeris (gali būti tuščias)

## 2. Rasti ESO formą naršyklėje

Digpoint sistema jau atidarė `https://www.eso.lt/aktualios-formos/kasimo-darbai/30` naujame skirtuke.

Naudok `tabs_context_mcp` kad rastum tą skirtuką. Jei jo nėra — atidaryк patį su `navigate`.

## 3. Užpildyti formą žingsnis po žingsnio

### Žingsnis A — ESO rangovas blokas

Surask bloką su tekstu „Prašymą pildo ESO (sub)rangovo organizacija..." arba mygtuką „Toliau" ties ESO rangovas sekcija. Spausk „Toliau".

### Žingsnis B — Formos laukai

Užpildyk šiuos laukus tiksliai tokia tvarka:

| Laukas | Reikšmė |
|--------|----------|
| Organizacijos/įmonės pavadinimas | `company` iš užduoties |
| Darbų vadovo vardas, pavardė | `manager` iš užduoties |
| Darbų vadovo telefono numeris | `managerPhone` iš užduoties |
| El. paštas sutikimo gavimui | `email` iš užduoties |
| Savivaldybė | **NUSKAITYTI iš PDF** — jei failai yra, perskaityk PDF pavadinimus ir spėk savivaldybę iš adreso; jei negali — pasirink „Kauno miesto savivaldybė" (dažniausias atvejis EnergoLT) |
| Darbų vykdymo vieta | `location` iš užduoties |
| Numatytų darbų paskirtis ir pobūdis | `description` iš užduoties (arba "Kasimo darbai pagal projektą") |
| Kasimo darbų pradžia | `startDate` — konvertuok į DD.MM.YYYY formatą |
| Kasimo darbų pabaiga | `endDate` — konvertuok į DD.MM.YYYY formatą |
| Darbų vietos nuoroda | **PALIKTI TUŠČIĄ** |
| Investicinis numeris | `investNo` jei yra, kitu atveju palikti tuščią |
| Jūsų žinutė mums | **PALIKTI TUŠČIĄ** |

### Žingsnis C — Brėžiniai (PDF failai)

Jei `files` masyve yra PDF failų — bandyk juos pridėti per failo įkėlimo lauką. Failai fiziškai yra Digpoint uploads/ aplanke serveryje — informuok vartotoją jei automatinis pridėjimas nepavyks, kad jis pridėtų rankiniu būdu.

### Žingsnis D — Sutikimo varnelė

Surask ir pažymėk varnelę: „Patvirtinu, kad susipažinau su darbų atlikimo taisyklėmis..."

## 4. SUSTOTI — NESPAUSTI „Siųsti"

**SVARBU:** Baigus pildyti formą — **NESPAUSK „Siųsti" mygtuko**. 

Pranešk vartotojui:
- ✅ Forma užpildyta
- 📋 Parodyk trumpą suvestinę kas buvo užpildyta
- ⚠️ Jei kas nors nepavyko (pvz. PDF nepridėtas) — aiškiai nurodyk
- 👉 Prašyk vartotojo **patikrinti formą** ir tik tada rankiniu būdu paspausti „Siųsti"

Forma lieka atidaryta naršyklėje.

## 5. Po vartotojo patvirtinimo (jei paprašo)

Jei vartotojas sako „siųsk", „patvirtinu", „submit" — tik tada spausk „Siųsti" mygtuką.

Po sėkmingo išsiuntimo — pranešk apie tai ir pažymėk užduotį kaip atliktą serveryje:

```
PUT http://localhost:3001/api/store/kl-eso-task
Body: {"value": null}
```

## Klaidos atvejai

- **Puslapis neatsidaro** — pranešk vartotojui ir pateik nuorodą rankiniam atidarymui
- **Laukas nerandamas** — ESO gali būti atnaujinę formą; pranešk vartotojui ir parodyk ką pavyko užpildyti
- **PDF nepridedamas automatiškai** — tęsk be failų, pranešk vartotojui kad pridėtų rankiniu būdu
- **Serveris nepasiekiamas** — gali būti kad Digpoint neveikia; paprašyk patikrinti `http://localhost:3001`
