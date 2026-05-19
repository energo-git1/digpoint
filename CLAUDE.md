# Digpoint — Kasimo leidimų valdymo sistema

Node.js/Express + React 18 web app for managing earth excavation permits (žemės kasimo leidimai) at EnergoLT. Single-file frontend (`public/index.html`) with Babel standalone — no build step. Backend is `server.js`. Data stored in SQLite via `better-sqlite3`.

## Version policy

Increment the minor version (`1.X.x`) with every change. Update the version string in **both** `index.html` (title/display) **and** `package.json`.

## Tech stack

- **Backend:** Node.js, Express, better-sqlite3 (WAL mode), ldapjs v3, multer, nodemailer, imapflow
- **Frontend:** React 18 UMD + Babel standalone, single HTML file
- **Process manager:** PM2. Env vars set via `pm2 set digpoint VAR value`
- **Deployment:** GitHub → server polls via cron + `deploy.sh` every minute

## Auth

- **Local admin:** username `kladmin`, role `admin`, `adAuth: false`, default password `Admin99`
- **AD users:** two-step LDAP — UPN bind to verify password, then service account search for name/email
- **LDAP server:** `ldap://192.168.1.100:389`, base DN `DC=hata,DC=local`
- Sessions stored in browser **localStorage** key `kl-user` (not server-side)
- Passwords never sent to client: `GET /api/store/kl-users` strips them, `PUT /api/store/kl-users` re-merges from DB

## Key files

| File | Purpose |
|------|---------|
| `server.js` | Backend, all API routes, LDAP auth, file upload, ESO email notifications |
| `public/index.html` | Entire frontend (React components, styles, logic) |
| `package.json` | Version tracking |

## Roles

`admin`, `orderer` (užsakovas), `dokumentacija` (dokumentacijos specialistas), `pending`

## Institutions (PERMIT_ORGS)

A permit can target **multiple institutions** simultaneously. Supported:
- `AB ESO` — electricity network operator
- `Kauno miesto savivaldybe` — Kaunas city municipality
- `Telia, Kaunas` — telecom operator (requires route: `teliaRouteFrom` / `teliaRouteTo`)
- `Kauno energija` — district heating (also requires route fields)

`TELIA_EMAIL = "ligita.rutkauskiene@telia.lt"` — used for Telia notifications.

## ESO automation

`EsoSubmitBtn` component in frontend generates a Cowork prompt for semi-automated ESO form filling at `https://www.eso.lt/aktualios-formos/kasimo-darbai/30`. On open, auto-sends email confirmation to the orderer. Constants: `ESO_EMAIL = "leidimai@energolt.eu"`, `ESO_COMPANY = "EnergoLT"`.

## Data store keys

All SQLite store keys use `kl-` prefix:

| Key | Content |
|-----|---------|
| `kl-users` | User array (passwords stripped on GET) |
| `kl-permits` | Excavation permit array (includes `organizations[]`, `permitValidFrom`, `permitValidUntil`, `teliaRouteFrom`, `teliaRouteTo`) |
| `kl-settings` | App settings (emailDomain, etc.) |
| `kl-eso-task` | Temporary ESO automation task (localStorage only) |

## Language

UI and console logs are in **Lithuanian**. Code comments and variable names in **English**.

## File uploads

Stored in `uploads/` dir. Max 500 MB, max 70-char filename. Served via `/uploads/` static route.

## Server & deployment

- **Port:** 3001 (Nginx proxy → HTTPS)
- **PM2 process name:** `digpoint`
- **DB file:** `kasimo.db` (WAL mode)
- **Upload dir:** `uploads/` locally, `/home/data/kasimo-uploads/` on Azure

## Email / SMTP

- **SMTP išorinis:** `192.168.1.100:465` (SSL, auth) — Telia, KE, ESO, užsakovams
- **SMTP vidinis:** `10.2.1.103:25` (relay, be auth) — sisteminiai perspėjimai
- **User:** `uzklausos@energolt.eu`
- **Pass:** PM2 env `SMTP_PASS`
- **MAIL_FROM_EXTERNAL:** `"EnergoLT užklausos" <uzklausos@energolt.eu>` — Telia, KE, ESO, review
- **MAIL_FROM_INTERNAL:** `"Digpoint" <uzklausos@energolt.eu>` — sisteminiai perspėjimai

## Email / IMAP (automatinis leidimų gavimas — įgyvendinta v1.2.14)

- **IMAP:** `192.168.1.100:993` (SSL)
- **User:** `uzklausos@energolt.eu`
- **Pass:** PM2 env `SMTP_PASS` (tas pats)
- Tikrinama kas **15 minučių** (pirmą kartą po 10 sek. nuo paleidimo)
- Rankinis paleidimas: `POST /api/admin/check-mail`
- Atpažįstamos institucijos pagal siuntėjo domeną: `eso.lt`, `kaunas.lt`, `telia.lt`, `kaunoenergeija.lt`, `kaunoenergia.lt`
- Paraiška surandama pagal adreso žodžių sutapimą laiško temoje (threshold 40 %)
- Jei PDF prisegtas ir paraiška rasta → statusas → „Gautas leidimas", PDF išsaugomas
- Jei nepavyksta sugretinti → įspėjimo laiškas į `uzklausos@energolt.eu`

## Env variables (PM2)

```bash
pm2 set digpoint LDAP_SVC_PASS <password>
pm2 set digpoint LDAP_SVC_DN "CN=svc_jira,OU=Service Accounts,DC=hata,DC=local"
pm2 set digpoint LDAP_USERS_BASE "OU=Users,DC=hata,DC=local"
pm2 set digpoint SMTP_HOST "mail.energolt.eu"
pm2 set digpoint SMTP_PORT "465"
pm2 set digpoint SMTP_SECURE "true"
pm2 set digpoint SMTP_USER "uzklausos@energolt.eu"
pm2 set digpoint SMTP_PASS "Uzkl2026TR"
pm2 restart digpoint --update-env
```

## Relationship with Geopoint

Digpoint is a sibling module to Geopoint (geodesy orders system). Both run on the same server, same company (EnergoLT), same LDAP. They are **independent systems** with separate databases and separate user lists. A user may have different roles in each system.

- Geopoint: port 3000, prefix `gp-`, admin `geoadmin`
- Digpoint: port 3001, prefix `kl-`, admin `kladmin`

## Deployment review policy

Any change that modifies the **database schema or existing data** (new columns, renamed columns, dropped tables, migrations, seed data changes, etc.) must go through an **additional review cycle in Claude Cowork** before deployment. Do not proceed with deployment of such changes without explicit confirmation from the developer that the review has been completed.

## Known resolved issues

- `saveUsers` auto-save bug fixed (v1.0.2): removed `sSet("kl-users")` auto-save; user mutations now go through dedicated endpoints only.
- `POST /api/users` and `DELETE /api/users/:id` endpoints added (v1.0.2): user creation and deletion now persisted server-side.
- Frontend merged from Geopoint-Dokumentacija (v1.0.3): multi-institution support, Telia/Kauno energija route fields, ESO automation button, permit validity dates, `Pateikta`/`Nebegalioja` statuses, Geopoint user import logic.
