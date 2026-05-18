const express = require('express');
const fs = require('fs');
const path = require('path');
const ldap = require('ldapjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const app = express();
const PORT = process.env.PORT || 3001;

// On Azure Linux App Service, /home is persistent storage
// Locally, use the project directory
const DATA_DIR   = process.env.WEBSITE_SITE_NAME ? '/home/data/kasimo-leidimai' : __dirname;
const DB_FILE    = path.join(DATA_DIR, 'kasimo.db');
const UPLOAD_DIR = process.env.WEBSITE_SITE_NAME ? '/home/data/kasimo-uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE    = 500 * 1024 * 1024; // 500 MB
const MAX_FILENAME_LEN = 70;

function srvUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function safeName(name) { return name.replace(/[^a-zA-Z0-9.\-_\u00C0-\u017E]/g, '_').slice(0, 200); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${srvUid()}_${safeName(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.length > MAX_FILENAME_LEN) {
      return cb(new Error(`Failo pavadinimas per ilgas (max ${MAX_FILENAME_LEN} simbolių).`));
    }
    cb(null, true);
  },
});

// ── Active Directory config ───────────────────────────────────
const LDAP_URL        = 'ldap://192.168.1.100:389';
const LDAP_BASE_DN    = 'DC=hata,DC=local';
const LDAP_USERS_BASE = process.env.LDAP_USERS_BASE || LDAP_BASE_DN;
const LDAP_SVC_DN     = process.env.LDAP_SVC_DN   || 'CN=svc_jira,OU=Service Accounts,DC=hata,DC=local';
const LDAP_SVC_PASS   = process.env.LDAP_SVC_PASS || '';

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database setup ────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// ── Data helpers ─────────────────────────────────────────────
const stmtGet    = db.prepare('SELECT value FROM store WHERE key = ?');
const stmtSet    = db.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
const stmtDelete = db.prepare('DELETE FROM store WHERE key = ?');

function dbGet(key) {
  const row = stmtGet.get(key);
  return row ? JSON.parse(row.value) : null;
}

function dbSet(key, value) {
  if (value === null || value === undefined) {
    stmtDelete.run(key);
  } else {
    stmtSet.run(key, JSON.stringify(value));
  }
}

// ── Startup: ensure admin exists ──────────────────────────────
(function ensureLocalAdmin() {
  const users = dbGet('kl-users') || [];
  const hasAdmin = users.find((u) => !u.adAuth && u.username === 'kladmin');

  if (hasAdmin) {
    if (!hasAdmin.password) {
      const fixed = users.map((u) =>
        u.id === hasAdmin.id
          ? Object.assign({}, u, { password: 'Admin99', mustChangePassword: true })
          : u
      );
      dbSet('kl-users', fixed);
    }
    return;
  }

  dbSet('kl-users', users.concat([{
    id: 'admin1',
    name: 'Administratorius',
    username: 'kladmin',
    email: '',
    password: 'Admin99',
    role: 'admin',
    adAuth: false,
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  }]));
  console.log('  👤 Sukurtas vietinis administratorius:kladmin');
})();

// ── One-time cleanup ──────────────────────────────────────────
(function removeSharedSession() {
  if (dbGet('kl-session')) {
    stmtDelete.run('kl-session');
  }
})();

// ── API endpoints ────────────────────────────────────────────

// kl-users GET: strip passwords
app.get('/api/store/kl-users', (req, res) => {
  const users = dbGet('kl-users') || [];
  res.json({ key: 'kl-users', value: users.map(({ password, ...u }) => u) });
});

// kl-users PUT: merge passwords back
// kl-users PUT užblokuotas — vartotojai keičiami tik per /api/users/*
app.put('/api/store/kl-users', (req, res) => {
  res.status(403).json({ error: 'Vartotojų sąrašas keičiamas tik per /api/users/* endpointus.' });
});

app.get('/api/store/:key', (req, res) => {
  res.json({ key: req.params.key, value: dbGet(req.params.key) });
});

app.put('/api/store/:key', (req, res) => {
  if (req.params.key === 'kl-users') {
    return res.status(403).json({ error: 'Vartotojų sąrašas keičiamas tik per /api/users/* endpointus.' });
  }
  dbSet(req.params.key, req.body.value);
  res.json({ ok: true });
});

// ── Local login ───────────────────────────────────────────────
app.post('/api/auth/local', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Trūksta prisijungimo duomenų.' });

  const users = dbGet('kl-users') || [];
  const usernameLower = username.toLowerCase();
  const user  = users.find((u) => !u.adAuth && u.username.toLowerCase() === usernameLower);

  if (!user)                       return res.status(401).json({ error: 'Vartotojas nerastas.' });
  if (user.password !== password)  return res.status(401).json({ error: 'Neteisingas slaptažodis.' });

  const { password: _pw, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ── Change password ───────────────────────────────────────────
app.post('/api/auth/change-password', (req, res) => {
  const { userId, oldPassword, newPassword, forceChange } = req.body;
  if (!userId || !newPassword)
    return res.status(400).json({ error: 'Trūksta duomenų.' });
  if (newPassword.length < 4)
    return res.status(400).json({ error: 'Slaptažodis per trumpas (min. 4 simboliai).' });

  const users = dbGet('kl-users') || [];
  const user  = users.find((u) => u.id === userId);

  if (!user)     return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (user.adAuth) return res.status(400).json({ error: 'AD vartotojai slaptažodžio nekeičia čia.' });

  const skipOldCheck = user.mustChangePassword || forceChange;
  if (!skipOldCheck && user.password !== oldPassword) {
    return res.status(401).json({ error: 'Neteisingas dabartinis slaptažodis.' });
  }

  const mustChange = false;
  const updated = Object.assign({}, user, { password: newPassword, mustChangePassword: mustChange });
  dbSet('kl-users', users.map((u) => (u.id === userId ? updated : u)));

  const { password: _pw, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// ── Update user email ─────────────────────────────────────────
app.patch('/api/users/:id/email', (req, res) => {
  const users = dbGet('kl-users') || [];
  const user  = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  const updated = Object.assign({}, user, { email: (req.body.email || '').trim() });
  dbSet('kl-users', users.map((u) => (u.id === updated.id ? updated : u)));
  const { password: _, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// ── Update user role ──────────────────────────────────────────
// Roles: admin | orderer | dokumentacija | pending
app.patch('/api/users/:id/role', (req, res) => {
  const ALLOWED = ['admin', 'orderer', 'dokumentacija', 'pending'];
  const role = (req.body.role || '').trim();
  if (!ALLOWED.includes(role)) {
    return res.status(400).json({ error: 'Neteisinga rolė.' });
  }
  const users = dbGet('kl-users') || [];
  const user  = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });

  if (user.role === 'admin' && role !== 'admin') {
    const otherAdmins = users.filter((u) => u.role === 'admin' && u.id !== user.id);
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: 'Negalima pašalinti paskutinio administratoriaus.' });
    }
  }

  const updated = Object.assign({}, user, { role });
  dbSet('kl-users', users.map((u) => (u.id === updated.id ? updated : u)));
  const { password: _, ...safeUser } = updated;
  console.log(`  🔧 Rolė pakeista: ${user.name} (${user.email || user.username}): ${user.role} → ${role}`);
  res.json({ user: safeUser });
});

// ── Create user ───────────────────────────────────────────────
app.post('/api/users', (req, res) => {
  const { id, name, username, email, phone, password, role, mustChangePassword, adAuth, createdAt } = req.body;
  if (!name || !username || !role) {
    return res.status(400).json({ error: 'Trūksta privalomų laukų.' });
  }
  const users = dbGet('kl-users') || [];
  if (users.find((u) => u.username === username)) {
    return res.status(409).json({ error: 'Vartotojas tokiu vardu jau egzistuoja.' });
  }
  const newUser = { id, name, username, email: email || '', phone: phone || '', password: password || '', role, mustChangePassword: !!mustChangePassword, adAuth: !!adAuth, createdAt: createdAt || new Date().toISOString() };
  dbSet('kl-users', users.concat([newUser]));
  const { password: _pw, ...safeUser } = newUser;
  console.log(`  👤 Sukurtas vartotojas: ${name} (${username}), rolė: ${role}`);
  res.status(201).json({ user: safeUser });
});

// ── Update user contact info ──────────────────────────────────
app.patch('/api/users/:id/contact', (req, res) => {
  const users = dbGet('kl-users') || [];
  const user  = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  const name  = (req.body.name  || '').trim();
  if (!name) return res.status(400).json({ error: 'Vardas yra privalomas.' });
  const updated = Object.assign({}, user, {
    name,
    phone: (req.body.phone || '').trim(),
    email: (req.body.email || '').trim(),
  });
  dbSet('kl-users', users.map((u) => (u.id === updated.id ? updated : u)));
  const { password: _, ...safeUser } = updated;
  console.log(`  ✏️  Kontaktai atnaujinti: ${name} (${user.username})`);
  res.json({ user: safeUser });
});

// ── Delete user ───────────────────────────────────────────────
app.delete('/api/users/:id', (req, res) => {
  const users = dbGet('kl-users') || [];
  const user  = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (!user.adAuth && user.role === 'admin') {
    const otherAdmins = users.filter((u) => u.role === 'admin' && u.id !== user.id);
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: 'Negalima ištrinti paskutinio administratoriaus.' });
    }
  }
  dbSet('kl-users', users.filter((u) => u.id !== req.params.id));
  console.log(`  🗑️  Ištrintas vartotojas: ${user.name} (${user.username})`);
  res.json({ ok: true });
});

// ── AD / LDAP authentication ──────────────────────────────────
app.post('/api/auth/ldap', (req, res) => {
  const rawUsername = (req.body.username || '').trim();
  const username = rawUsername.replace(/@[^@]*$/, '').toLowerCase();
  const { password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Trūksta prisijungimo duomenų' });
  }

  let responded = false;
  function safeRespond(code, body) {
    if (!responded) { responded = true; res.status(code).json(body); }
  }
  function makeClient() {
    return ldap.createClient({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000, reconnect: false });
  }

  const authClient = makeClient();
  authClient.on('error', (err) => {
    console.error('[LDAP] connection error:', err.message);
    safeRespond(503, { error: 'Nepavyko prisijungti prie Active Directory.' });
  });

  authClient.bind(`${username}@hata.local`, password, (bindErr) => {
    authClient.destroy();
    if (bindErr) {
      return safeRespond(401, { error: 'Neteisingas vartotojo vardas arba slaptažodis.' });
    }

    const svcClient = makeClient();
    svcClient.on('error', () => { finishLogin(res, username, '', username); });

    svcClient.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (svcErr) => {
      if (svcErr) {
        svcClient.destroy();
        return finishLogin(res, username, '', username);
      }

      const searchOpts = {
        filter: `(&(objectClass=user)(sAMAccountName=${username}))`,
        scope: 'sub',
        attributes: ['givenName', 'sn', 'mail', 'userPrincipalName'],
        timeLimit: 8,
      };

      svcClient.search(LDAP_USERS_BASE, searchOpts, (searchErr, result) => {
        if (searchErr) {
          try { svcClient.destroy(); } catch (_) {}
          return finishLogin(res, username, '', username);
        }

        let attrs = {};
        let done = false;
        function finish() {
          if (done) return;
          done = true;
          try { svcClient.destroy(); } catch (_) {}
          const upn   = attrs.userPrincipalName || '';
          const email = attrs.mail || (!upn.toLowerCase().endsWith('@hata.local') ? upn : '');
          const name  = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;
          finishLogin(res, username, email, name);
        }

        result.on('searchEntry', (entry) => {
          (entry.attributes || []).forEach((a) => {
            attrs[a.type] = a.values && a.values.length === 1 ? a.values[0] : a.values;
          });
        });
        result.on('searchReference', () => {});
        result.on('error',  () => { finish(); });
        result.on('end',    () => { finish(); });
      });
    });
  });
});

function finishLogin(res, username, email, displayName) {
  let users = dbGet('kl-users') || [];

  const usernameLower = username.toLowerCase();
  const existingByUsername = users.find((u) => u.adAuth && u.username.toLowerCase() === usernameLower);
  const existingByEmail    = email ? users.find((u) => u.adAuth && u.email === email) : null;
  let user = existingByUsername || existingByEmail || null;

  if (!user) {
    user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: displayName,
      email: email,
      username: username,
      role: 'pending',
      adAuth: true,
      mustChangePassword: false,
      password: null,
      createdAt: new Date().toISOString(),
    };
    dbSet('kl-users', users.concat([user]));
    console.log(`  👤 Naujas AD vartotojas: ${displayName} (${email || username})`);
  } else {
    const updatedEmail = email || user.email;
    user = Object.assign({}, user, { name: displayName, email: updatedEmail, username: username });
    dbSet('kl-users', users.map((u) => (u.id === user.id ? user : u)));
  }

  res.json({ user });
}

// ── File upload ───────────────────────────────────────────────
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Failas per didelis (max 500 MB).`
        : err.message || 'Įkėlimo klaida.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Failas neįkeltas.' });
    res.json({
      id:       srvUid(),
      name:     req.file.originalname,
      filename: req.file.filename,
      size:     req.file.size,
      url:      `/uploads/${req.file.filename}`,
    });
  });
});

// ── Delete uploaded file ──────────────────────────────────────
app.delete('/api/files/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename || filename.includes('..') || /[/\\]/.test(filename)) {
    return res.status(400).json({ error: 'Neteisingas failo pavadinimas.' });
  }
  const filePath = path.join(UPLOAD_DIR, filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    return res.status(500).json({ error: 'Klaida trinant failą iš disko.' });
  }
  // Remove file reference from any permit that contains it
  const permits = dbGet('kl-permits') || [];
  const updated = permits.map(p => ({
    ...p,
    files: (p.files || []).filter(f => f.filename !== filename),
  }));
  dbSet('kl-permits', updated);
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ── Email / SMTP ──────────────────────────────────────────────
// Laikinas: vidinis relay testavimui. Vėliau: mail.energolt.eu:465 su SMTP_PASS
const mailer = nodemailer.createTransport({
  host: '10.2.1.103',
  port: 25,
  secure: false,
  auth: false,
  tls: { rejectUnauthorized: false },
});

const MAIL_FROM_INTERNAL = 'digpoint@energolt.eu';   // perspėjimai, uždarymas
const MAIL_FROM_EXTERNAL = 'uzklausos@energolt.eu';  // Telia, KE, ESO, review
const ESO_EMAIL   = 'leidimai@energolt.eu';
const TELIA_EMAIL = 'ligita.rutkauskiene@telia.lt';

app.post('/api/notify/email', async (req, res) => {
  const { to, subject, html, attachments, from } = req.body || {};
  if (!to || !subject || !html) return res.status(400).json({ error: 'Trūksta duomenų.' });
  try {
    const mailOptions = { from: from||MAIL_FROM_EXTERNAL, to, subject, html };
    // Optional attachments: [{ filename: 'x.pdf', content: 'base64string' }]
    if (Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments
        .filter(a => a && a.filename && a.content)
        .map(a => ({
          filename: a.filename,
          content: a.content,
          encoding: a.encoding || 'base64',
          contentType: a.contentType || 'application/pdf',
        }));
    }
    const info = await mailer.sendMail(mailOptions);
    const attachInfo = mailOptions.attachments ? ` | ${mailOptions.attachments.length} priedas(-ai)` : '';
    console.log(`  📨 El. laiškas išsiųstas → ${to} | ${subject} | ${info.messageId}${attachInfo}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`  ❌ El. laiško klaida → ${to}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Įspėjimas kai sistema aptinka leidimą bet negali pridėti PDF ──
app.post('/api/notify/permit-pdf-missing', async (req, res) => {
  const { permitNo, institution, location } = req.body || {};
  if (!permitNo) return res.status(400).json({ error: 'Trūksta duomenų.' });
  try {
    const subject = `Nepavyko automatiškai atpažinti leidimo — reikalingas rankinis įkėlimas`;
    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;padding:20px">
      <p>Sistema aptiko gautą laišką iš <strong>${institution||'institucijos'}</strong>, tačiau nepavyko automatiškai atpažinti leidimo dokumento paraiškoje <strong>#${permitNo}</strong>${location?' ('+location+')':''}.</p>
      <p>Paraiška lieka <strong>„Pateikta"</strong> statusu.</p>
      <p>Reikalingas rankinis leidimo PDF įkėlimas sistemoje.</p>
    </body></html>`;
    const info = await mailer.sendMail({ from: MAIL_FROM_INTERNAL, to: 'uzklausos@energolt.eu', subject, html });
    console.log(`  📨 Permit PDF missing warning → uzklausos | #${permitNo} | ${info.messageId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`  ❌ Permit PDF missing warning klaida: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── ESO paraiškos pateikimo patvirtinimas užsakovui ───────────
app.post('/api/notify/eso-submitted', async (req, res) => {
  const { permit } = req.body || {};
  if (!permit || !permit.email) {
    return res.status(400).json({ error: 'Trūksta paraiškos duomenų arba el. pašto.' });
  }

  const permitNo = permit.id ? permit.id.slice(-5).toUpperCase() : '?????';
  const subject = `Kasimo leidimo paraiška #${permitNo} pateikta AB ESO`;

  const html = `
<!DOCTYPE html>
<html lang="lt">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0F2F7;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F7;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#F97316,#EAB308);padding:28px 32px;text-align:center;">
            <div style="font-size:36px;margin-bottom:8px;">🚧</div>
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Kasimo leidimai</h1>
            <p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:13px;">EnergoLT dokumentacijos sistema</p>
          </td>
        </tr>
        <!-- Status juosta -->
        <tr>
          <td style="background:#10B981;padding:12px 32px;text-align:center;">
            <p style="margin:0;color:#ffffff;font-size:13px;font-weight:700;">✅ Paraiška sėkmingai pateikta AB ESO</p>
          </td>
        </tr>
        <!-- Turinys -->
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">
              Gerb. <strong>${permit.manager || 'Klientas'}</strong>,<br><br>
              informuojame, kad Jūsų kasimo leidimo paraiška <strong>#${permitNo}</strong> buvo pateikta AB ESO ir šiuo metu laukia jų patvirtinimo. Sutikimas bus išsiųstas adresu <strong>${ESO_EMAIL}</strong>.
            </p>
            <!-- Paraiškos duomenys -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:8px;border:1px solid #E5E7EB;margin-bottom:20px;">
              <tr><td style="padding:16px 20px;">
                <p style="margin:0 0 12px;color:#6B7280;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Paraiškos informacija</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:5px 0;color:#6B7280;font-size:12px;width:140px;">Paraiškos Nr.</td>
                    <td style="padding:5px 0;color:#111827;font-size:12px;font-weight:700;">#${permitNo}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#6B7280;font-size:12px;">Institucija</td>
                    <td style="padding:5px 0;color:#111827;font-size:12px;font-weight:600;">AB ESO</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#6B7280;font-size:12px;">Darbų vadovas</td>
                    <td style="padding:5px 0;color:#111827;font-size:12px;">${permit.manager || '-'}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#6B7280;font-size:12px;">Darbų laikotarpis</td>
                    <td style="padding:5px 0;color:#111827;font-size:12px;">${permit.startDate || '-'} &ndash; ${permit.endDate || '-'}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;color:#6B7280;font-size:12px;">Pateikta</td>
                    <td style="padding:5px 0;color:#111827;font-size:12px;">${new Date().toLocaleDateString('lt-LT', {year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;color:#374151;font-size:13px;line-height:1.6;">
              Gavus ESO sutikimą, būsite informuoti papildomu el. laišku. Jei turite klausimų, kreipkitės: <a href="mailto:${ESO_EMAIL}" style="color:#3B82F6;">${ESO_EMAIL}</a>
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F9FAFB;border-top:1px solid #E5E7EB;padding:16px 32px;text-align:center;">
            <p style="margin:0;color:#9CA3AF;font-size:11px;">EnergoLT UAB &bull; Kasimo leidimų sistema &bull; Šis laiškas išsiųstas automatiškai</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const info = await mailer.sendMail({ from: MAIL_FROM_EXTERNAL, to: permit.email, subject, html });
    console.log(`  📨 ESO pateikimo patvirtinimas → ${permit.email} | #${permitNo} | ${info.messageId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`  ❌ ESO patvirtinimo laiško klaida → ${permit.email}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── IMAP el. pašto tikrinimas ─────────────────────────────────
const IMAP_HOST = 'mail.energolt.eu';
const IMAP_PORT = 993;
const IMAP_USER = 'uzklausos@energolt.eu';

// Siuntėjų domenai → institucijų pavadinimai (kaip saugomi kl-permits)
const IMAP_ORG_DOMAINS = [
  { org: 'AB ESO',                   domains: ['eso.lt'] },
  { org: 'Kauno miesto savivaldybė', domains: ['kaunas.lt'] },
  { org: 'Telia, Kaunas',            domains: ['telia.lt', 'telia.com'] },
  { org: 'Kauno energija',           domains: ['kaunoenergeija.lt', 'kaunoenergia.lt'] },
];

function detectOrgFromEmail(fromAddr) {
  if (!fromAddr) return null;
  const addr = fromAddr.toLowerCase();
  for (const { org, domains } of IMAP_ORG_DOMAINS) {
    if (domains.some((d) => addr.includes('@' + d))) return org;
  }
  return null;
}

function fmtDateSrv(d) {
  const dt = (d instanceof Date) ? d : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase()
    .replace(/ą/g,'a').replace(/č/g,'c').replace(/ę/g,'e').replace(/ė/g,'e')
    .replace(/į/g,'i').replace(/š/g,'s').replace(/ų/g,'u').replace(/ū/g,'u').replace(/ž/g,'z')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Kiek leidimo adreso žodžių sutampa su laiško tema (0–1)
function calcLocationScore(permitLocation, emailSubject) {
  const loc  = normalizeForMatch(permitLocation);
  const subj = normalizeForMatch(emailSubject);
  const words = loc.split(' ').filter((w) => w.length >= 4);
  if (!words.length) return 0;
  return words.filter((w) => subj.includes(w)).length / words.length;
}

// Rekursyviai suranda visus PDF priedus bodyStructure medyje
function findPdfParts(struct, acc = []) {
  if (!struct) return acc;
  if (Array.isArray(struct.childNodes) && struct.childNodes.length) {
    for (const child of struct.childNodes) findPdfParts(child, acc);
    return acc;
  }
  const type     = ((struct.type || '') + '/' + (struct.subtype || '')).toLowerCase().replace(/\/$/, '');
  const dispP    = (struct.disposition && struct.disposition.parameters) || {};
  const params   = struct.parameters || {};
  const filename = dispP.filename || dispP['filename*'] || params.name || '';
  if ((type.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) && struct.part) {
    acc.push({ part: struct.part, filename: filename || 'leidimas.pdf' });
  }
  return acc;
}

async function checkImapMail() {
  const IMAP_PASS = process.env.SMTP_PASS;
  if (!IMAP_PASS) {
    console.log('[IMAP] SMTP_PASS nenurodytas — tikrinimas praleidžiamas.');
    return { checked: 0, processed: 0 };
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  let checked = 0;
  let processed = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msgList = await client.search({ unseen: true });
      checked = msgList.length;

      if (!msgList.length) {
        console.log('[IMAP] Naujų laiškų nerasta.');
      } else {
        console.log(`[IMAP] Rasta ${msgList.length} naujų laiškų.`);

        for (const seq of msgList) {
          try {
            const msg = await client.fetchOne(seq, { envelope: true, bodyStructure: true });
            const fromList = msg.envelope.from || [];
            const fromAddr = fromList[0] ? (fromList[0].address || '') : '';
            const org      = detectOrgFromEmail(fromAddr);

            if (!org) {
              // Neatpažinta institucija — neliečiama (nežymima kaip skaityta)
              continue;
            }

            const subject = msg.envelope.subject || '';
            console.log(`[IMAP] ${org} | "${subject}" | ${fromAddr}`);

            const pdfParts = findPdfParts(msg.bodyStructure);

            if (!pdfParts.length) {
              console.log(`[IMAP] ${org}: laiškas be PDF priedo, praleidžiama.`);
              await client.messageFlagsAdd(seq, ['\\Seen']);
              continue;
            }

            // Surasti tinkamą paraišką (statusas "Pateikta", ta pati institucija)
            const permits    = dbGet('kl-permits') || [];
            const candidates = permits.filter((p) =>
              p.status === 'Pateikta' &&
              Array.isArray(p.organizations) &&
              p.organizations.includes(org)
            );

            let bestPermit = null;
            let bestScore  = 0;
            for (const p of candidates) {
              const score = calcLocationScore(p.location, subject);
              if (score > bestScore) { bestScore = score; bestPermit = p; }
            }

            const THRESHOLD = 0.4; // Bent 40 % adreso žodžių turi sutapti

            if (!bestPermit || bestScore < THRESHOLD) {
              console.log(`[IMAP] ${org}: nepavyko sugretinti paraiškos (score: ${bestScore.toFixed(2)}, tema: "${subject}")`);
              try {
                const warnHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;padding:20px">
                  <p>Sistema aptiko gautą laišką iš <strong>${org}</strong> (${fromAddr}), tačiau nepavyko automatiškai sugretinti su jokia paraiška.</p>
                  <p>Laiško tema: <em>${subject}</em></p>
                  <p>Patikrinkite, ar yra atitinkama paraiška su statusu „Pateikta". Jei taip — pakeiskite statusą į „Gautas leidimas" ir įkelkite PDF rankiniu būdu.</p>
                </body></html>`;
                await mailer.sendMail({
                  from: MAIL_FROM_INTERNAL,
                  to: 'uzklausos@energolt.eu',
                  subject: `Gautas leidimas iš ${org} — nepavyko automatiškai atpažinti paraiškos`,
                  html: warnHtml,
                });
              } catch (mailErr) {
                console.error(`[IMAP] Įspėjimo laiško klaida: ${mailErr.message}`);
              }
              await client.messageFlagsAdd(seq, ['\\Seen']);
              continue;
            }

            // Parsisiųsti ir išsaugoti PDF priedus
            const savedFiles = [];
            for (const pdfPart of pdfParts) {
              try {
                const dl = await client.download(seq, pdfPart.part);
                const chunks = [];
                for await (const chunk of dl.content) chunks.push(chunk);
                const buf   = Buffer.concat(chunks);
                const fname = `${srvUid()}_${safeName(pdfPart.filename)}`;
                fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
                savedFiles.push({
                  id:       srvUid(),
                  name:     pdfPart.filename,
                  filename: fname,
                  size:     buf.length,
                  url:      `/uploads/${fname}`,
                });
                console.log(`[IMAP] PDF išsaugotas: ${fname} (${(buf.length/1024).toFixed(1)} KB)`);
              } catch (dlErr) {
                console.error(`[IMAP] PDF parsisiuntimo klaida (part ${pdfPart.part}): ${dlErr.message}`);
              }
            }

            if (savedFiles.length > 0) {
              const today      = fmtDateSrv(new Date());
              const allPermits = dbGet('kl-permits') || [];
              const updated    = allPermits.map((p) => {
                if (p.id !== bestPermit.id) return p;
                return {
                  ...p,
                  status:          'Gautas leidimas',
                  files:           [...(p.files || []), ...savedFiles],
                  permitValidFrom: p.permitValidFrom || p.startDate || today,
                  permitValidUntil: p.permitValidUntil || p.endDate || '',
                  history: [...(p.history || []), {
                    status: 'Gautas leidimas',
                    date:   today,
                    note:   `Leidimas gautas automatiškai iš ${org} (${fromAddr})`,
                  }],
                };
              });
              dbSet('kl-permits', updated);
              const shortId = bestPermit.id.slice(-5).toUpperCase();
              console.log(`[IMAP] ✅ Paraiška #${shortId} → "Gautas leidimas" | ${org} | ${savedFiles.length} PDF`);
              processed++;
            }

            await client.messageFlagsAdd(seq, ['\\Seen']);
          } catch (msgErr) {
            console.error(`[IMAP] Klaida apdorojant laišką seq=${seq}: ${msgErr.message}`);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (connErr) {
    console.error('[IMAP] Prisijungimo klaida:', connErr.message);
    try { await client.logout(); } catch (_) {}
  }

  return { checked, processed };
}

// Rankinis IMAP tikrinimo paleidimas per API
app.post('/api/admin/check-mail', async (req, res) => {
  try {
    const result = await checkImapMail();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AD email sync ─────────────────────────────────────────────
async function syncAdEmailsPromise(emailDomain) {
  const users = dbGet('kl-users') || [];
  const adUsers = users.filter((u) => u.adAuth);
  const domain = (emailDomain || '').replace(/^@/, '').trim();
  if (adUsers.length === 0) return { updated: 0, log: ['AD vartotojų nerasta.'] };

  const log = [`AD vartotojų tikrinama: ${adUsers.length}`];

  function searchOneUser(username) {
    return new Promise((resolve) => {
      const client = ldap.createClient({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000, reconnect: false });
      client.on('error', () => { resolve(domain ? `${username}@${domain}` : null); });

      client.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (bindErr) => {
        if (bindErr) {
          try { client.destroy(); } catch (_) {}
          return resolve(domain ? `${username}@${domain}` : null);
        }
        const opts = {
          filter: `(&(objectClass=user)(sAMAccountName=${username}))`,
          scope: 'sub',
          attributes: ['mail', 'userPrincipalName'],
          timeLimit: 8,
        };
        let email = null;
        let done = false;
        function finish() {
          if (done) return;
          done = true;
          try { client.destroy(); } catch (_) {}
          if (!email && domain) email = `${username}@${domain}`;
          resolve(email);
        }
        client.search(LDAP_USERS_BASE, opts, (err, result) => {
          if (err) { try { client.destroy(); } catch (_) {} return resolve(domain ? `${username}@${domain}` : null); }
          result.on('searchEntry', (entry) => {
            const attrs = {};
            (entry.attributes || []).forEach((a) => {
              attrs[a.type] = a.values && a.values.length === 1 ? a.values[0] : a.values;
            });
            const upn = attrs.userPrincipalName || '';
            const mailAttr = attrs.mail || '';
            const upnEmail = !upn.toLowerCase().endsWith('@hata.local') ? upn : '';
            email = mailAttr || upnEmail || null;
          });
          result.on('searchReference', () => {});
          result.on('error', () => { finish(); });
          result.on('end',   () => { finish(); });
        });
      });
    });
  }

  const emailMap = {};
  for (const u of adUsers) {
    emailMap[u.username] = await searchOneUser(u.username);
  }

  const current = dbGet('kl-users') || [];
  let updatedCount = 0;
  const updated = current.map((u) => {
    if (!u.adAuth) return u;
    const fetched = emailMap[u.username];
    if (!fetched) { log.push(`  ⚠ ${u.username}: el. paštas AD nerastas`); return u; }
    if (fetched === u.email) { log.push(`  ✓ ${u.username}: ${fetched} (nepakeista)`); return u; }
    updatedCount++;
    log.push(`  ✅ ${u.username}: ${u.email || '(tuščia)'} → ${fetched}`);
    return Object.assign({}, u, { email: fetched });
  });
  if (updatedCount > 0) dbSet('kl-users', updated);
  return { updated: updatedCount, log };
}

app.post('/api/admin/sync-ad-emails', async (req, res) => {
  try {
    const domain = (req.body && req.body.domain) || '';
    const result = await syncAdEmailsPromise(domain);
    res.json(result);
  } catch (e) {
    res.status(500).json({ updated: 0, log: [`Klaida: ${e.message}`] });
  }
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🚧 Kasimo leidimai veikia: http://localhost:${PORT}\n`);
  console.log(`  🗄️  Duomenų bazė: ${DB_FILE}`);

  setTimeout(() => {
    const settings = dbGet('kl-settings') || {};
    syncAdEmailsPromise(settings.emailDomain || '').then((r) => {
      console.log('[SYNC] El. pašto sinchronizacija:', r.log.join('\n       '));
    });
  }, 3000);

  // IMAP tikrinimas: iš karto po 10 sek., tada kas 15 min.
  setTimeout(() => {
    checkImapMail().then((r) => {
      if (r.checked > 0) console.log(`[IMAP] Pradinis tikrinimas: ${r.checked} laiškų, ${r.processed} apdorota.`);
    });
    setInterval(() => {
      checkImapMail().then((r) => {
        if (r.checked > 0) console.log(`[IMAP] Tikrinimas: ${r.checked} laiškų, ${r.processed} apdorota.`);
      });
    }, 15 * 60 * 1000); // kas 15 minučių
  }, 10000);
});
