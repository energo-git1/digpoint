# Digpoint — Kasimo leidimų valdymo sistema

Node.js/Express + React 18 web app for managing earth excavation permits (žemės kasimo leidimai) at EnergoLT. Single-file frontend (`public/index.html`) with Babel standalone — no build step. Backend is `server.js`. Data stored in SQLite via `better-sqlite3`.

## Version policy

Increment the minor version (`1.X.x`) with every change. Update the version string in **both** `index.html` (title/display) **and** `package.json`.

## Tech stack

- **Backend:** Node.js, Express, better-sqlite3 (WAL mode), ldapjs v3, multer, nodemailer
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

## Data store keys

All SQLite store keys use `kl-` prefix:

| Key | Content |
|-----|---------|
| `kl-users` | User array (passwords stripped on GET) |
| `kl-permits` | Excavation permit array |
| `kl-settings` | App settings (emailDomain, etc.) |

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

- **SMTP:** `10.2.1.103:25` (no auth, internal relay)
- **From:** `geopoint@energolt.eu`
- Dedicated endpoint for ESO submission confirmation: `POST /api/notify/eso-submitted`

## Env variables (PM2)

```bash
pm2 set digpoint LDAP_SVC_PASS <password>
pm2 set digpoint LDAP_SVC_DN "CN=svc_jira,OU=Service Accounts,DC=hata,DC=local"
pm2 set digpoint LDAP_USERS_BASE "OU=Users,DC=hata,DC=local"
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
