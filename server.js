const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');
const ldap = require('ldapjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const pdfParse    = require('pdf-parse');
const PizZip      = require('pizzip');
const Docxtemplater = require('docxtemplater');

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
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// index.html — įterpiame APP_VERSION iš package.json
app.get('/', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(
      '<script type="text/babel">',
      `<script>window.APP_VERSION="${pkg.version}";</script>\n  <script type="text/babel">`
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

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
// Visi laiškai per mail.energolt.eu (192.168.1.101:465) SSL/TLS su autentikacija
// PM2: pm2 set digpoint SMTP_PASS Uzkl2026TR
const SMTP_PASS = process.env.SMTP_PASS || process.env.npm_package_config_SMTP_PASS || '';

const _smtpOpts = {
  host: '192.168.1.101',
  port: 465,
  secure: true,                           // SSL/TLS (ne STARTTLS)
  auth: { user: 'uzklausos@energolt.eu', pass: SMTP_PASS },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
};

const mailer         = nodemailer.createTransport(_smtpOpts);
const mailerInternal = nodemailer.createTransport(_smtpOpts); // tas pats serveris

console.log(`[SMTP] mail.energolt.eu (192.168.1.101:465) SSL auth=${!!SMTP_PASS}`);

const MAIL_FROM_INTERNAL = '"Digpoint" <uzklausos@energolt.eu>';   // perspėjimai, uždarymas
const MAIL_FROM_EXTERNAL = '"EnergoLT užklausos" <uzklausos@energolt.eu>';  // Telia, KE, ESO, review
const ESO_EMAIL   = 'uzklausos@energolt.eu';
const TELIA_EMAIL = 'ligita.rutkauskiene@telia.lt';

// Siųsti išorinį laišką per Zimbra + IMAP append į Sent
async function sendAndSave(opts) {
  const info = await mailer.sendMail(opts);
  // IMAP Sent išsaugojimas — blokuojantis (portas 993 atidarytas)
  if (SMTP_PASS) {
    try {
      const tmpT = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
      const si   = await tmpT.sendMail(opts);
      const chunks = [];
      await new Promise((resolve, reject) => {
        si.message.on('data', (d) => chunks.push(d));
        si.message.on('end', resolve);
        si.message.on('error', reject);
      });
      const raw = Buffer.concat(chunks);
      const ic  = new ImapFlow({
        host: IMAP_HOST, port: IMAP_PORT, secure: true,
        auth: { user: IMAP_USER, pass: SMTP_PASS  },
        logger: false, tls: { rejectUnauthorized: false },
        connectionTimeout: 8000,
      });
      await ic.connect();
      await ic.append('Sent', raw, ['\\Seen'], new Date());
      await ic.logout();
      console.log(`[IMAP] Sent išsaugotas: ${opts.subject}`);
    } catch (saveErr) {
      console.error('[IMAP] Sent išsaugojimo klaida:', saveErr.message);
    }
  }
  return info;
}

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
    const info = await sendAndSave(mailOptions);
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
    const info = await sendAndSave({ from: MAIL_FROM_INTERNAL, to: 'uzklausos@energolt.eu', subject, html });
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
    const info = await sendAndSave({ from: MAIL_FROM_EXTERNAL, to: permit.email, subject, html });
    console.log(`  📨 ESO pateikimo patvirtinimas → ${permit.email} | #${permitNo} | ${info.messageId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`  ❌ ESO patvirtinimo laiško klaida → ${permit.email}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── IMAP el. pašto tikrinimas ─────────────────────────────────
const IMAP_HOST = '192.168.1.101';
const IMAP_PORT = 993;
const IMAP_USER = 'uzklausos@energolt.eu';

// Siuntėjų domenai → institucijų pavadinimai (kaip saugomi kl-permits)
const IMAP_ORG_DOMAINS = [
  { org: 'AB ESO',                  domains: ['eso.lt'] },
  { org: 'Kauno miesto savivaldybe', domains: ['kaunas.lt'] },
  { org: 'Telia, Kaunas',           domains: ['telia.lt'] },
  { org: 'Kauno energija',          domains: ['kaunoenergeija.lt', 'kaunoenergia.lt'] },
  { org: 'Kauno vandenys',          domains: ['kaunovandenys.lt'] },
  { org: 'LitGrid',                 domains: ['litgrid.eu', 'litgrid.lt'] },
];

// Spausdintuvo/skaitytuvo siuntėjų adresai → institucija
const SCANNER_SENDERS = [
  { email: 'bizhub220@energolt.eu', org: 'Kauno vandenys' },
];

function detectOrgFromEmail(fromAddr) {
  if (!fromAddr) return null;
  const addr = fromAddr.toLowerCase();
  // Pirma: tikrinti ar tai skaitytuvas (tikslus adresas)
  const scanner = SCANNER_SENDERS.find((s) => addr.includes(s.email));
  if (scanner) return scanner.org;
  // Tada: tikrinti domeną
  for (const { org, domains } of IMAP_ORG_DOMAINS) {
    if (domains.some((d) => addr.includes('@' + d))) return org;
  }
  return null;
}

// Aptikti instituciją pagal raktažodžius laiško tekste (testiniam naudojimui / neatpažintiems domenams)
function detectOrgFromText(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('telia')) return 'Telia, Kaunas';
  if (t.includes('kauno energija') || t.includes('kaunoenergia') || t.includes('kauno energ')) return 'Kauno energija';
  if (t.includes('kauno vandenys') || t.includes('kaunovandenys')) return 'Kauno vandenys';
  if (t.includes('savivaldyb') || t.includes('kauno miesto')) return 'Kauno miesto savivaldybe';
  if (/\beso\b/.test(t)) return 'AB ESO';
  return null;
}

// Ištraukia VISUS investicinius numerius iš PDF teksto (pvz. E1N2547991, E9109481)
function extractAllInvestNos(text) {
  const matches = [...(text || '').matchAll(/[A-Z][0-9][A-Z][0-9]{5,10}/g)];
  const unique = [...new Set(matches.map((m) => m[0]))];
  return unique;
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

// Kiek leidimo adreso žodžių sutampa su tekstu (0–1)
function calcLocationScore(permitLocation, text) {
  const loc   = normalizeForMatch(permitLocation);
  const haystack = normalizeForMatch(text);
  const words = loc.split(' ').filter((w) => w.length >= 4);
  if (!words.length) return 0;
  return words.filter((w) => haystack.includes(w)).length / words.length;
}

// 2 žingsnis — ar PDF yra leidimo dokumentas?
// Tikrinama ar tekste yra leidimą/sutikimą reiškiantys žodžiai.
const PERMIT_KEYWORDS = [
  'leidimas', 'leidima', 'leidimai',
  'sutikimas', 'sutikima',
  'leistina', 'leisti kasimo',
  'kasimo darbai', 'kasimo leidim',
  'žemės kasimo', 'zemes kasimo',
  'suderintas', 'suderinta',
  'patvirtintas', 'patvirtinta',
];
function isPdfPermitDocument(pdfText) {
  const t = normalizeForMatch(pdfText);
  return PERMIT_KEYWORDS.some((kw) => t.includes(normalizeForMatch(kw)));
}

// 3 žingsnis — ištraukti adresą iš PDF teksto
// Ieško gatvės pavadinimo šalia adreso žymių.
function extractLocationFromPdf(pdfText) {
  const patterns = [
    // Titulinio lapo lentelė: "VIETA/ LOCATION" arba "VIETA LOCATION"
    /VIETA[\/\s]+LOCATION\s+([A-ZĄČĘĖĮŠŲŪŽ][^\n\r]{3,80})/i,
    // ESO specifinis: "vykdymo vieta" arba "kasimo darbų vieta"
    /(?:vykdymo\s+vieta|kasimo\s+darb[uų]\s+viet[ao])[:\s\n]+([^\n(]{5,100})/i,
    /(?:darbų\s+vieta|objekto\s+vieta|adresas|statybos\s+vieta|vieta)[:\s]+([^\n]{5,80})/i,
    /(?:gatvė|g\.|pr\.|al\.|pl\.)[:\s]*([A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž][^\n]{3,60})/i,
  ];
  for (const pat of patterns) {
    const m = pdfText.match(pat);
    if (m) {
      let v = m[1].replace(/\s+/g, ' ').trim();
      // Pjauname ties sekančia stambių didžiųjų raidžių grupe (kita lentelės antraštė)
      const cut = v.search(/\b[A-ZĄČĘĖĮŠŲŪŽ]{4,}\s+[A-ZĄČĘĖĮŠŲŪŽ]{4,}/);
      if (cut > 3) v = v.substring(0, cut).trim();
      if (v.length > 3) return v;
    }
  }
  return null;
}

// Ištraukti ESO leidimo datas iš PDF teksto
// ESO formate: "pradžia  2026-05-21  pabaiga  2026-08-20"
function extractEsoDatesFromPdf(pdfText) {
  if (!pdfText) return { start: null, end: null };
  // ISO formato datos (2026-05-21)
  let m = pdfText.match(/prad[žz][iī]a\s+(\d{4}-\d{2}-\d{2})\s+pabaiga\s+(\d{4}-\d{2}-\d{2})/i);
  if (m) return { start: m[1], end: m[2] };
  // Su papildomais tarpais/naujomis eilutėmis
  m = pdfText.match(/prad[žz][iī]a[\s\n]+(\d{4}-\d{2}-\d{2})[\s\S]{0,80}?pabaiga[\s\n]+(\d{4}-\d{2}-\d{2})/i);
  if (m) return { start: m[1], end: m[2] };
  // Tik pradžios data (jei pabaigos nėra)
  m = pdfText.match(/prad[žz][iī]a[\s\n]+(\d{4}-\d{2}-\d{2})/i);
  if (m) return { start: m[1], end: null };
  return { start: null, end: null };
}

// Rekursyviai suranda teksto dalis (text/plain arba text/html) bodyStructure medyje
function findTextPart(struct, acc = []) {
  if (!struct) return acc;
  if (Array.isArray(struct.childNodes) && struct.childNodes.length) {
    for (const child of struct.childNodes) findTextPart(child, acc);
    return acc;
  }
  const type = ((struct.type || '') + '/' + (struct.subtype || '')).toLowerCase().replace(/\/$/, '');
  if ((type === 'text/plain' || type === 'text/html') && struct.part) {
    acc.push({ part: struct.part, type });
  }
  return acc;
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
  const IMAP_PASS = SMTP_PASS; // process.env.SMTP_PASS || process.env.npm_package_config_SMTP_PASS
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
    connectionTimeout: 8000,
  });

  let checked = 0;
  let processed = 0;

  // Apdorotų laiškų ID saugomi DB, kad nekartotume
  const doneIds = new Set(dbGet('kl-imap-done') || []);

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Ieškoti laiškų iš paskutinių 7 dienų (nepriklausomai ar skaityti)
      const since7 = new Date();
      since7.setDate(since7.getDate() - 7);
      const msgList = await client.search({ since: since7 });
      checked = msgList.length;

      if (!msgList.length) {
        console.log('[IMAP] Laiškų per paskutines 7 dienas nerasta.');
      } else {
        console.log(`[IMAP] Rasta ${msgList.length} neskaitytų laiškų. Jau apdorota: ${doneIds.size}.`);

        for (const seq of msgList) {
          try {
            const msg = await client.fetchOne(seq, { envelope: true, bodyStructure: true });
            const msgId = msg.envelope.messageId || `seq-${seq}`;

            // Praleisti jau apdorotus laiškus
            if (doneIds.has(msgId)) continue;

            const fromList = msg.envelope.from || [];
            const fromAddr = fromList[0] ? (fromList[0].address || '') : '';
            const subject  = msg.envelope.subject || '';
            let org        = detectOrgFromEmail(fromAddr);

            if (!org) {
              // Neatpažintas domenas — praleisti ir pažymėti kaip skaitytą
              console.log(`[IMAP] Neatpažintas domenas, praleidžiama: ${fromAddr} | "${subject}"`);
              doneIds.add(msgId);
              await client.messageFlagsAdd(seq, ['\\Seen']);
              continue;
            }

            // ── Patikrinti ar yra paraiškų šiai institucijai be PDF ──
            const allPermitsEarly = dbGet('kl-permits') || [];
            const TRULY_FINAL     = new Set(['Atmestas', 'Nebegalioja']);
            const orgKey0 = org === 'Telia, Kaunas' ? 'telia'
                          : org === 'Kauno energija' ? 'ke'
                          : org === 'Kauno vandenys'  ? 'vandenys'
                          : org === 'AB ESO'           ? 'eso'
                          : org === 'LitGrid'          ? 'litgrid'
                          : null;
            // Telia domenui priskiriame abi Telia organizacijas
            const matchOrgs = org === 'Telia, Kaunas'
              ? ['Telia, Kaunas', 'Telia, investiciniai']
              : [org];
            const pendingForOrg = allPermitsEarly.filter((p) => {
              if (TRULY_FINAL.has(p.status)) return false;
              const orgs = Array.isArray(p.organizations) && p.organizations.length > 0
                ? p.organizations : p.organization ? [p.organization] : [];
              if (!matchOrgs.some((o) => orgs.includes(o))) return false;
              // Jei žinome orgKey — tikrinti ar jau turi šios institucijos PDF
              // Telia: tikrinti pagal konkrečią organizacijos rūšį
              if (org === 'Telia, Kaunas') {
                const hasTelia    = p.permitPdfs && p.permitPdfs.telia    && p.permitPdfs.telia.name;
                const hasTeliaInv = p.permitPdfs && p.permitPdfs.telia_inv && p.permitPdfs.telia_inv.name;
                if (orgs.includes('Telia, Kaunas')        && hasTelia)    return false;
                if (orgs.includes('Telia, investiciniai') && hasTeliaInv) return false;
                return true;
              }
              if (orgKey0 && p.permitPdfs && p.permitPdfs[orgKey0] && p.permitPdfs[orgKey0].name) return false;
              return true;
            });

            if (!pendingForOrg.length) {
              // Jei yra paraiškų šiai institucijai, bet visos jau turi PDF —
              // šis laiškas jau buvo apdorotas anksčiau. Žymime kaip perskaitytą,
              // kad nebūtų tikrinamas iš naujo (net išvalius kl-imap-done).
              const anyForOrg = allPermitsEarly.some((p) => {
                if (TRULY_FINAL.has(p.status)) return false;
                const orgs = Array.isArray(p.organizations) && p.organizations.length > 0
                  ? p.organizations : p.organization ? [p.organization] : [];
                return matchOrgs.some((o) => orgs.includes(o));
              });
              if (anyForOrg) {
                console.log(`[IMAP] ${org}: visos paraiškos jau turi PDF — laiškas jau apdorotas, žymimas perskaitytu.`);
                doneIds.add(msgId);
                dbSet('kl-imap-done', [...doneIds]);
                await client.messageFlagsAdd(seq, ['\\Seen']);
              }
              // Jei nėra nė vienos paraiškos šiai institucijai — galima nauja paraiška,
              // paliekame nepažymėtą (kitąkart patikrinsime)
              continue;
            }

            console.log(`[IMAP] ${org} | "${subject}" | ${fromAddr} | paraiškų be PDF: ${pendingForOrg.length}`);

            // ── AB ESO: informacinio laiško filtras (PRIEŠ PDF atsisiuntimą) ──
            // ESO siunčia: (1) patvirtinimas „prašymas gautas" su projekto PDF (ne leidimas)
            // (2) tikrasis leidimas/atsakymas su leidimo PDF.
            // Pirmą reikia praleisti — pažymėti skaitytą ir NEBEPRISKIRTI.
            if (org === 'AB ESO') {
              let esoBodyTextEarly = '';
              const textPartsEarly = findTextPart(msg.bodyStructure);
              for (const tp of textPartsEarly.slice(0, 2)) {
                try {
                  const dl = await client.download(seq, tp.part);
                  const chunks = [];
                  for await (const chunk of dl.content) chunks.push(chunk);
                  esoBodyTextEarly += ' ' + Buffer.concat(chunks).toString('utf8').slice(0, 3000);
                } catch (_) {}
              }
              const esoEarlyText = esoBodyTextEarly + ' ' + subject;
              const isInfoConfirm =
                /gavome.*praším|praším.*gauta|pateiksime.*ne\s+v[eė]liau|automatinis\s+prane[sš]im|neatsakin[eė]ti.*šį.*laišk|prašom[ao].*neatsakin[eė]ti/i.test(esoEarlyText);
              const hasApproval =
                /suteikiam[as]*\s+leidim|leidžiama\s+vykdyti|suderint[a]\s+kasimo|leisti\s+kasimo|kasimo\s+leidim[as]*\s+suteikt|leidimas\s+išduot|išduodam[as]*\s+leidim/i.test(esoEarlyText);
              if (isInfoConfirm && !hasApproval) {
                // Išsaugoti reg. nr. → investNo sąsają, kad vėliau pagal "Sutikimas {regNo}" rastume paraišką
                const regNoMatch = esoEarlyText.match(/registracijos\s+numeris[^A-Z0-9]*([A-Z][0-9]+)/i);
                const regNo = regNoMatch ? regNoMatch[1].trim() : null;
                const invNosFromBody = extractAllInvestNos(esoEarlyText);
                const invNoFromBody = invNosFromBody.length > 0 ? invNosFromBody[0] : null;
                if (regNo) {
                  const regMap = dbGet('kl-eso-reg-map') || {};
                  regMap[regNo] = { investNo: invNoFromBody, date: fmtDateSrv(new Date()) };
                  dbSet('kl-eso-reg-map', regMap);
                  console.log(`[IMAP] AB ESO: 📋 reg. nr. ${regNo} → inv. nr. ${invNoFromBody || '(nerasta)'} išsaugota sąsajų lentelėje`);
                }
                console.log(`[IMAP] AB ESO: ⏭️ informacinis patvirtinimas (prašymas gautas) — PDF neparsisiunčiamas, praleidžiama. Tema: "${subject}"`);
                doneIds.add(msgId);
                dbSet('kl-imap-done', [...doneIds]);
                await client.messageFlagsAdd(seq, ['\\Seen']);
                continue;
              }
            }

            const pdfParts = findPdfParts(msg.bodyStructure);

            if (!pdfParts.length) {
              // Kauno sav. pranešimas be PDF — tikrinti ar "Darbų tvirtinimas"
              if (org === 'Kauno miesto savivaldybe' && fromAddr.toLowerCase().includes('kasimo.darbai@kaunas.lt')) {
                let bodyText = '';
                const textPartsClose = findTextPart(msg.bodyStructure);
                for (const tp of textPartsClose.slice(0, 2)) {
                  try {
                    const dl = await client.download(seq, tp.part);
                    const chunks = [];
                    for await (const chunk of dl.content) chunks.push(chunk);
                    bodyText += Buffer.concat(chunks).toString('utf8');
                  } catch (_) {}
                }

                if (/išduotas leidimas/i.test(bodyText + ' ' + subject)) {
                  // Išsaugome laišką — vartotojas atsakys su nuotraukomis
                  const addrMatchI = bodyText.match(/Darb[uų]\s+vieta\s*\(prad[žz][iī]a\)[:\s]+([^\n(]{5,100})/i);
                  const rawAddrI   = addrMatchI ? addrMatchI[1].trim() : '';
                  const closeRequests = dbGet('kl-sav-close-requests') || [];
                  const alreadyStored = closeRequests.some((r) => r.messageId === msgId);
                  if (!alreadyStored) {
                    closeRequests.push({
                      id: srvUid(), messageId: msgId, subject,
                      from: fromAddr, date: new Date().toISOString(),
                      address: rawAddrI, bodyPreview: bodyText.slice(0, 600),
                    });
                    dbSet('kl-sav-close-requests', closeRequests);
                    console.log(`[IMAP] 📬 Kauno sav. "Išduotas leidimas" išsaugotas laukti atsakymo: "${subject}" | adresas: ${rawAddrI||'—'}`);
                  }
                } else if (/darb[uų]\s+tvirtinimas/i.test(bodyText + ' ' + subject)) {
                  // Ištraukiame adresą iš "Darbų vieta (pradžia):" eilutės
                  const addrMatch = bodyText.match(/Darb[uų]\s+vieta\s*\(prad[žz][iī]a\)[:\s]+([^\n(]{5,100})/i);
                  const rawAddr   = addrMatch ? addrMatch[1].trim() : '';
                  // Seniūnija (skliaustuose po adreso)
                  const senMatch  = bodyText.match(/\(([^)]*seni[uū]nija[^)]*)\)/i);
                  const senName   = senMatch ? senMatch[1].trim() : null;
                  // Datos
                  const datesMatch = bodyText.match(/Galiojimas[:\s]+(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})/i);
                  const validFrom  = datesMatch ? datesMatch[1] : null;
                  const validUntil = datesMatch ? datesMatch[2] : null;

                  console.log(`[IMAP] 🏁 Kauno sav. Darbų tvirtinimas | adresas: "${rawAddr}" | seniūnija: ${senName||'—'}`);

                  // Surasti paraišką pagal adresą
                  const allPermits = dbGet('kl-permits') || [];
                  const candidates = allPermits.filter((p) => {
                    if (p.status === 'Uždarytas' || p.status === 'Atmestas') return false;
                    const orgs = Array.isArray(p.organizations) ? p.organizations : (p.organization ? [p.organization] : []);
                    return orgs.includes('Kauno miesto savivaldybe');
                  });

                  let bestPermit = null;
                  let bestScore  = 0;
                  for (const p of candidates) {
                    const score = calcLocationScore(p.location || '', rawAddr + ' ' + bodyText);
                    if (score > bestScore) { bestScore = score; bestPermit = p; }
                  }

                  const THRESHOLD = candidates.length === 1 ? 0 : 0.4;

                  if (!bestPermit || bestScore < THRESHOLD) {
                    console.log(`[IMAP] Kauno sav. Darbų tvirtinimas: paraiška nerasta (score: ${bestScore.toFixed(2)})`);
                    // Įspėjimas
                    try {
                      await mailerInternal.sendMail({
                        from: MAIL_FROM_INTERNAL, to: 'uzklausos@energolt.eu',
                        subject: 'Gautas Darbų tvirtinimas — paraiška nerasta Digpoint',
                        html: `<p>Gautas Kauno sav. „Darbų tvirtinimas" laiškas, tačiau nepavyko surasti atitinkančios paraiškos.</p><p>Adresas: <strong>${rawAddr}</strong></p><p>Gretinimo rezultatas: ${bestScore.toFixed(2)} (reikia ≥ ${THRESHOLD})</p>`,
                      });
                    } catch (_) {}
                  } else {
                    console.log(`[IMAP] Kauno sav. Darbų tvirtinimas → #${bestPermit.id.slice(-5).toUpperCase()} (score: ${bestScore.toFixed(2)})`);
                    const today = fmtDateSrv(new Date());
                    // Surasti visą grupę (manualGroupId arba tik ši paraiška)
                    const groupId = bestPermit.manualGroupId || null;
                    const updatedPermits = allPermits.map((p) => {
                      const inGroup = groupId
                        ? (p.id === bestPermit.id || p.manualGroupId === groupId)
                        : p.id === bestPermit.id;
                      if (!inGroup) return p;
                      if (p.status === 'Uždarytas') return p;
                      return {
                        ...p,
                        status: 'Uždarytas',
                        closingDone: true,
                        closingDoneAt: today,
                        seniunijaName: senName || p.seniunijaName || null,
                        permitValidFrom:  p.permitValidFrom  || validFrom  || '',
                        permitValidUntil: p.permitValidUntil || validUntil || '',
                        history: [...(p.history || []), {
                          status: 'Uždarytas', date: today,
                          note: `Darbų tvirtinimas gautas automatiškai iš Kauno m. sav. (${rawAddr})`,
                        }],
                      };
                    });
                    dbSet('kl-permits', updatedPermits);
                    const closedCount = updatedPermits.filter((p) => {
                      const inGroup = groupId ? (p.id === bestPermit.id || p.manualGroupId === groupId) : p.id === bestPermit.id;
                      return inGroup && p.status === 'Uždarytas';
                    }).length;
                    console.log(`[IMAP] ✅ Uždarytos ${closedCount} paraiška(-ų) | seniūnija: ${senName||'—'}`);
                    processed++;
                  }
                } else {
                  console.log(`[IMAP] Kauno sav.: laiškas be PDF, be "Išduotas leidimas" ir be "Darbų tvirtinimas" — praleidžiama.`);
                }
              } else {
                console.log(`[IMAP] ${org}: laiškas be PDF priedo, praleidžiama.`);
              }
              doneIds.add(msgId);
              await client.messageFlagsAdd(seq, ['\\Seen']);
              continue;
            }

            // ── ŽINGSNIS 1: parsisiųsti ir išsaugoti PDF ──────────────
            const savedFiles = [];
            const pdfTexts   = [];
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
                try {
                  const parsed = await pdfParse(buf);
                  if (parsed.text) pdfTexts.push(parsed.text);
                } catch (parseErr) {
                  console.log(`[IMAP] PDF tekstas neištrauktas (${pdfPart.filename}): ${parseErr.message}`);
                }
              } catch (dlErr) {
                console.error(`[IMAP] PDF parsisiuntimo klaida (part ${pdfPart.part}): ${dlErr.message}`);
              }
            }

            // ── ŽINGSNIS 1b: ar šis PDF jau priskirtas kuriai nors paraiškai? ──
            // Apsaugo nuo pakartotinio priskyrimo, jei laiškas buvo pažymėtas
            // "neperskaitytu" rankiniu būdu arba iš naujo apdorojamas po kl-imap-done išvalymo.
            if (savedFiles.length > 0) {
              const savedOrigNames = savedFiles.map((f) => f.name);
              const allPermitsNow  = dbGet('kl-permits') || [];
              const alreadyUsed = allPermitsNow.some((p) => {
                const pdfs = p.permitPdfs || {};
                return Object.values(pdfs).some((pdf) => pdf && savedOrigNames.includes(pdf.name));
              });
              if (alreadyUsed) {
                console.log(`[IMAP] ${org}: PDF "${savedOrigNames.join(', ')}" jau priskirtas kitai paraiškai — laiškas žymimas perskaitytu, praleidžiama.`);
                doneIds.add(msgId);
                dbSet('kl-imap-done', [...doneIds]);
                await client.messageFlagsAdd(seq, ['\\Seen']);
                continue;
              }
            }

            // ── ŽINGSNIS 2: ar PDF atrodo kaip leidimas? ──────────────
            const fullPdfText = pdfTexts.join(' ');
            const looksLikePermit = pdfTexts.length > 0 ? isPdfPermitDocument(fullPdfText) : true;
            if (!looksLikePermit) {
              console.log(`[IMAP] ${org}: ⚠️ PDF raktažodžiai nerasti — gali būti ne leidimas, bet tęsiama.`);
            }

            // ── ŽINGSNIS 2b: Kauno vandenys skaitytuvas — daugiaobjektinis PDF ──
            // Jei viename PDF yra keli investiciniai numeriai — priskirti kiekvienam
            if (org === 'Kauno vandenys' && fullPdfText) {
              const allInvNos = extractAllInvestNos(fullPdfText);
              if (allInvNos.length > 1) {
                console.log(`[IMAP] Kauno vandenys: daugiaobjektinis PDF — rasti inv. nr.: ${allInvNos.join(', ')}`);
                const allPermitsForSplit = dbGet('kl-permits') || [];
                let assignedCount = 0;
                const updatedForSplit = allPermitsForSplit.map((p) => {
                  const pInv = (p.investNo || '').trim();
                  if (!pInv || !allInvNos.includes(pInv)) return p;
                  const pOrgs = Array.isArray(p.organizations) && p.organizations.length > 0
                    ? p.organizations : p.organization ? [p.organization] : [];
                  if (!pOrgs.includes('Kauno vandenys')) return p;
                  if (p.permitPdfs && p.permitPdfs.vandenys && p.permitPdfs.vandenys.name) return p;
                  assignedCount++;
                  const updPdfs = { ...(p.permitPdfs || {}), vandenys: savedFiles[0] };
                  return { ...p, permitPdfs: updPdfs,
                    files: [...(p.files || []), ...savedFiles],
                    history: [...(p.history || []), { status: p.status, date: fmtDateSrv(new Date()),
                      note: `Kauno vandenys leidimas gautas automatiškai (daugiaobjektinis PDF, inv. ${pInv})` }],
                  };
                });
                if (assignedCount > 0) {
                  dbSet('kl-permits', updatedForSplit);
                  console.log(`[IMAP] ✅ Kauno vandenys daugiaobjektinis PDF priskirtas ${assignedCount} paraiška(-oms)`);
                  processed += assignedCount;
                  doneIds.add(msgId);
                  dbSet('kl-imap-done', [...doneIds]);
                  await client.messageFlagsAdd(seq, ['\\Seen']);
                  continue;
                }
              }
            }

            // ── ŽINGSNIS 3: surasti atitinkančią paraišką ────────────
            // AB ESO: pirma patikrinti ar tema "Sutikimas {regNo}" — naudoti saugomą reg→inv sąsają
            let bestPermitByInvNo = null;
            if (org === 'AB ESO') {
              const sutikimasMatch = subject.match(/Sutikimas\s+([A-Z][0-9]+)/i);
              if (sutikimasMatch) {
                const subjectRegNo = sutikimasMatch[1].trim();
                const regMap = dbGet('kl-eso-reg-map') || {};
                const mapped = regMap[subjectRegNo];
                if (mapped && mapped.investNo) {
                  const found = pendingForOrg.find((p) => (p.investNo || '').trim() === mapped.investNo);
                  if (found) {
                    bestPermitByInvNo = found;
                    console.log(`[IMAP] AB ESO: ✅ surastas pagal reg. nr. ${subjectRegNo} → inv. nr. ${mapped.investNo}`);
                  } else {
                    console.log(`[IMAP] AB ESO: reg. nr. ${subjectRegNo} → inv. nr. ${mapped.investNo} — paraiška nerasta tarp kandidačių`);
                  }
                } else {
                  console.log(`[IMAP] AB ESO: tema "Sutikimas ${subjectRegNo}" — reg. nr. ${subjectRegNo} sąsajų lentelėje nerastas`);
                }
              }
            }

            // Visoms org: bandyti pagal investicinį numerį iš PDF teksto
            if (!bestPermitByInvNo && fullPdfText) {
              const invNos = extractAllInvestNos(fullPdfText);
              if (invNos.length >= 1) {
                // Ieškome paraišką kurios investNo sutampa su kuriuo nors iš PDF nr.
                for (const inv of invNos) {
                  const found = pendingForOrg.find((p) => (p.investNo || '').trim() === inv);
                  if (found) { bestPermitByInvNo = found; console.log(`[IMAP] ${org}: surastas pagal inv. nr. ${inv}`); break; }
                }
              }
            }

            const pdfLocation = extractLocationFromPdf(fullPdfText);
            const searchText  = subject + ' ' + fullPdfText + (pdfLocation ? ' ' + pdfLocation : '');

            // Rūšiuojame kandidatus: pirmiausia "Pateikta", tada pagal sukūrimo datą (naujausios pirmos)
            // Tai užtikrina, kad ties lygiomis score'u parenka naujausią/pateiktą paraišką
            const candidates = [...pendingForOrg].sort((a, b) => {
              const aSubmitted = a.status === 'Pateikta' ? 1 : 0;
              const bSubmitted = b.status === 'Pateikta' ? 1 : 0;
              if (bSubmitted !== aSubmitted) return bSubmitted - aSubmitted; // Pateikta pirma
              return (b.createdAt || '').localeCompare(a.createdAt || '');   // Naujesnė pirma
            });

            console.log(`[IMAP] ${org}: kandidatės — ${candidates.length} (po rūšiavimo). PDF adresas: "${pdfLocation || '—'}"`);
            if (candidates.length > 1) {
              candidates.forEach((c, i) => console.log(`[IMAP]   [${i}] #${c.id.slice(-5).toUpperCase()} status=${c.status} inv=${c.investNo||'—'} loc=${(c.location||'').slice(0,40)}`));
            }

            let bestPermit = bestPermitByInvNo;
            let bestScore  = bestPermitByInvNo ? 1.0 : 0;
            if (!bestPermit) for (const p of candidates) {
              // Adresas: teliaRouteTo > teliaRouteFrom > location
              const permitAddr = p.teliaRouteTo || p.teliaRouteFrom || p.location || '';
              const score = calcLocationScore(permitAddr, searchText);
              // >= leidžia pakeisti tik jei tikrai geresnis (rūšiavimas jau užtikrino prioritetus)
              if (score > bestScore) { bestScore = score; bestPermit = p; }
            }

            // Jei tik viena kandidatė ir neturi adreso — priimame be score patikros
            const hasAddr = candidates.some((p) => p.teliaRouteTo || p.teliaRouteFrom || p.location);
            const THRESHOLD = (candidates.length === 1 && !hasAddr) ? 0 : 0.4;

            if (!bestPermit || bestScore < THRESHOLD) {
              console.log(`[IMAP] ${org}: nepavyko sugretinti paraiškos (score: ${bestScore.toFixed(2)}, threshold: ${THRESHOLD})`);
              // PDF jau išsaugoti — įspėjimas su nuorodomis į failus
              try {
                const fileLinks = savedFiles.map((f) =>
                  `<li><a href="https://digpoint.energolt.eu${f.url}">${f.name}</a> (${(f.size/1024).toFixed(0)} KB)</li>`
                ).join('');
                const warnHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;padding:20px">
                  <p>Sistema aptiko gautą laišką iš <strong>${org}</strong> (${fromAddr}), tačiau nepavyko automatiškai sugretinti su jokia paraiška.</p>
                  <p>Laiško tema: <em>${subject}</em></p>
                  ${pdfLocation ? `<p>PDF adresas: <strong>${pdfLocation}</strong></p>` : ''}
                  <p>Gretinimo rezultatas: <strong>${bestScore.toFixed(2)}</strong> (reikalinga ≥ ${THRESHOLD})</p>
                  <p><strong>PDF failai išsaugoti</strong> — prisekite prie tinkamos paraiškos rankiniu būdu:</p>
                  <ul>${fileLinks}</ul>
                  <p>Paraiška turi turėti instituciją „${org}".</p>
                </body></html>`;
                await mailerInternal.sendMail({
                  from: MAIL_FROM_INTERNAL,
                  to: 'uzklausos@energolt.eu',
                  subject: `Gautas leidimas iš ${org} — reikalingas rankinis priskyrimas`,
                  html: warnHtml,
                });
              } catch (mailErr) {
                console.error(`[IMAP] Įspėjimo laiško klaida: ${mailErr.message}`);
              }
              doneIds.add(msgId);
              dbSet('kl-imap-done', [...doneIds]);
              await client.messageFlagsAdd(seq, ['\\Seen']);
              continue;
            }

            console.log(`[IMAP] ${org}: gretinimas sėkmingas → #${bestPermit.id.slice(-5).toUpperCase()} (score: ${bestScore.toFixed(2)})`);


            // ── ŽINGSNIS 4: priskirti PDF ir pakeisti statusą ────────
            if (savedFiles.length > 0) {
              const today      = fmtDateSrv(new Date());
              const allPermits = dbGet('kl-permits') || [];
              // Ištraukiame datas ir adresą iš PDF teksto (ESO leidimams)
              const esoDates = org === 'AB ESO' ? extractEsoDatesFromPdf(fullPdfText) : { start: null, end: null };
              const pdfLocExtracted = fullPdfText ? extractLocationFromPdf(fullPdfText) : null;
              if (org === 'AB ESO' && esoDates.start) {
                console.log(`[IMAP] AB ESO datos iš PDF: pradžia=${esoDates.start} pabaiga=${esoDates.end||'(nėra)'}`);
              }
              // Nustatome permitPdfs raktą pagal RASTOS PARAIŠKOS organizaciją
              // (Telia domenui gali priklausyti ir Telia, Kaunas, ir Telia, investiciniai)
              const bestOrgs = Array.isArray(bestPermit.organizations) && bestPermit.organizations.length > 0
                ? bestPermit.organizations : [bestPermit.organization || ''];
              const orgKey = bestOrgs.includes('Telia, investiciniai') && !bestOrgs.includes('Telia, Kaunas')
                           ? 'telia_inv'
                           : (bestOrgs.includes('Telia, Kaunas') || org === 'Telia, Kaunas') ? 'telia'
                           : org === 'Kauno energija' ? 'ke'
                           : org === 'Kauno vandenys'  ? 'vandenys'
                           : org === 'AB ESO'           ? 'eso'
                           : org === 'LitGrid'          ? 'litgrid'
                           : null;
              const updated    = allPermits.map((p) => {
                if (p.id !== bestPermit.id) return p;
                // Papildome permitPdfs su gautu failu
                const updatedPermitPdfs = orgKey
                  ? { ...(p.permitPdfs || {}), [orgKey]: savedFiles[0] }
                  : (p.permitPdfs || {});
                // Perskaičiuojame statusą pagal gautus PDF
                const orgs = Array.isArray(p.organizations) && p.organizations.length > 0
                  ? p.organizations
                  : p.organization ? [p.organization] : [];
                const teliaNeed    = orgs.includes('Telia, Kaunas');
                const teliaInvNeed = orgs.includes('Telia, investiciniai');
                const keNeed       = orgs.includes('Kauno energija');
                const vandenysNeed = orgs.includes('Kauno vandenys');
                const esoNeed      = orgs.includes('AB ESO');
                const litgridNeed  = orgs.includes('LitGrid');
                const teliaDone    = updatedPermitPdfs.telia     && updatedPermitPdfs.telia.name;
                const teliaInvDone = updatedPermitPdfs.telia_inv && updatedPermitPdfs.telia_inv.name;
                const keDone       = updatedPermitPdfs.ke        && updatedPermitPdfs.ke.name;
                const vandenysDone = updatedPermitPdfs.vandenys  && updatedPermitPdfs.vandenys.name;
                const esoDone      = updatedPermitPdfs.eso       && updatedPermitPdfs.eso.name;
                const litgridDone  = updatedPermitPdfs.litgrid   && updatedPermitPdfs.litgrid.name;
                const allDone  = (!teliaNeed || teliaDone) && (!teliaInvNeed || teliaInvDone)
                               && (!keNeed || keDone) && (!vandenysNeed || vandenysDone)
                               && (!esoNeed || esoDone) && (!litgridNeed || litgridDone);
                const someDone = (teliaNeed && teliaDone) || (teliaInvNeed && teliaInvDone)
                               || (keNeed && keDone) || (vandenysNeed && vandenysDone)
                               || (esoNeed && esoDone) || (litgridNeed && litgridDone);
                const anyNeed  = teliaNeed || teliaInvNeed || keNeed || vandenysNeed || esoNeed || litgridNeed;
                const newStatus = anyNeed
                  ? (allDone ? 'Gautas leidimas' : (someDone ? 'Gautas dalinai' : p.status))
                  : 'Gautas leidimas';
                const pdfStart = esoDates.start;
                const pdfEnd   = esoDates.end;
                return {
                  ...p,
                  status:           newStatus,
                  files:            [...(p.files || []), ...savedFiles],
                  permitPdfs:       updatedPermitPdfs,
                  location:         p.location || pdfLocExtracted || '',
                  startDate:        p.startDate || pdfStart || '',
                  endDate:          p.endDate   || pdfEnd   || '',
                  permitValidFrom:  p.permitValidFrom  || pdfStart || p.startDate    || p.teliaStartDate || p.keStartDate || today,
                  permitValidUntil: p.permitValidUntil || pdfEnd   || p.endDate      || p.teliaEndDate   || p.keEndDate   || '',
                  history: [...(p.history || []), {
                    status: newStatus,
                    date:   today,
                    note:   `Leidimas gautas automatiškai iš ${org} (${fromAddr})`,
                  }],
                };
              });
              dbSet('kl-permits', updated);
              const shortId = bestPermit.id.slice(-5).toUpperCase();
              const updatedPermit = updated.find((p) => p.id === bestPermit.id);
              console.log(`[IMAP] ✅ Paraiška #${shortId} → "${updatedPermit?.status}" | ${org} | ${savedFiles.length} PDF`);
              processed++;

              // Pranešimas užsakovui apie gautą leidimą
              if (bestPermit.email && updatedPermit) {
                try {
                  const permitNo = shortId;
                  const gRows = [
                    `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px">Paraiška Nr.:</td><td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">#${permitNo}</td></tr>`,
                    `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px">Institucija:</td><td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${org}</td></tr>`,
                    `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px">Vieta:</td><td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${bestPermit.location || '-'}</td></tr>`,
                    updatedPermit.permitValidFrom ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px">Galioja nuo:</td><td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${updatedPermit.permitValidFrom}</td></tr>` : '',
                    updatedPermit.permitValidUntil ? `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px">Galioja iki:</td><td style="padding:4px 0;color:#111827;font-size:13px;font-weight:600">${updatedPermit.permitValidUntil}</td></tr>` : '',
                  ].join('');
                  const gHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif">
<div style="max-width:540px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
<div style="padding:20px 28px 0 28px">
  <p style="margin:0 0 4px;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.5px">Kasimo leidimai</p>
  <h2 style="margin:0 0 16px;color:#10B981;font-size:17px;font-weight:700">Leidimas gautas</h2>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:0 0 20px"/>
</div>
<div style="padding:0 28px 24px">
  <p style="color:#374151;font-size:14px;margin:0 0 16px">Gerb. <strong>${bestPermit.manager || ''}</strong>,<br><br>informuojame, kad Jūsų kasimo leidimo paraiška <strong>#${permitNo}</strong> yra patvirtinta ir leidimas gautas iš <strong>${org}</strong>.</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px">${gRows}</table>
</div>
<div style="padding:12px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF">EnergoLT &middot; Kasimo leidų valdymo sistema &middot; <a href="mailto:uzklausos@energolt.eu" style="color:#6B7280">uzklausos@energolt.eu</a></div>
</div></body></html>`;
                  await sendAndSave({
                    from: MAIL_FROM_INTERNAL,
                    to: bestPermit.email,
                    subject: `Kasimo leidimas gautas — ${org} #${permitNo}`,
                    html: gHtml,
                  });
                  console.log(`[IMAP] Pranešimas užsakovui išsiųstas → ${bestPermit.email}`);
                } catch (notifyErr) {
                  console.error(`[IMAP] Pranešimo klaida: ${notifyErr.message}`);
                }
              }
            }

            doneIds.add(msgId);
            dbSet('kl-imap-done', [...doneIds]);
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
    return { checked, processed, connError: connErr.message, connCode: connErr.code || null };
  }

  return { checked, processed };
}

// ── Seniūnijų el. paštai ─────────────────────────────────────
const SENIUNIJA_MAP = [
  { name: 'Panemunės-Šančių seniūnija',  email: 'panemune-sanciai@kaunas.lt',
    keywords: ['panemun','šanč','sanciu','ivinskio','karklup','šančių','panemunė'] },
  { name: 'Centro-Žaliakalnio seniūnija', email: 'centras@kaunas.lt',
    keywords: ['žaliakalnis','zaliakalnis','gedimino','donelaičio','laisvės al','mickevičiaus','vytauto pr','savanorių pr'] },
  { name: 'Dainavos seniūnija',           email: 'dainava@kaunas.lt',
    keywords: ['dainav','draugystės','taikos pr','studentų','vydūno','partizanų'] },
  { name: 'Eigulių seniūnija',            email: 'eiguliai@kaunas.lt',
    keywords: ['eiguliai','eigulių','perkūno','romaičių','baltijos','giraitė','smėliai'] },
];

function detectSeniunija(address) {
  if (!address) return null;
  const a = address.toLowerCase()
    .replace(/ą/g,'a').replace(/č/g,'c').replace(/ę/g,'e').replace(/ė/g,'e')
    .replace(/į/g,'i').replace(/š/g,'s').replace(/ų/g,'u').replace(/ū/g,'u').replace(/ž/g,'z');
  for (const s of SENIUNIJA_MAP) {
    const hit = s.keywords.some((kw) => {
      const k = kw.toLowerCase()
        .replace(/ą/g,'a').replace(/č/g,'c').replace(/ę/g,'e').replace(/ė/g,'e')
        .replace(/į/g,'i').replace(/š/g,'s').replace(/ų/g,'u').replace(/ū/g,'u').replace(/ž/g,'z');
      return a.includes(k);
    });
    if (hit) return s;
  }
  return null;
}

// Seniūnijos auto-detekcija iš adreso
app.get('/api/admin/detect-seniunija', (req, res) => {
  const address = (req.query.address || '').trim();
  const detected = detectSeniunija(address);
  res.json({ ok: true, seniunija: detected, all: SENIUNIJA_MAP.map((s) => ({ name: s.name, email: s.email })) });
});

// ── Seniūnijos dokumentų sujungimas į vieną PDF ──────────────
// POST /api/admin/merge-seniunija-docs { permitId, filenames: ['xxx.jpg', ...] }
// Grąžina: { content: base64, filename: 'dokumentai.pdf' }
app.post('/api/admin/merge-seniunija-docs', async (req, res) => {
  const { permitId, filenames } = req.body || {};
  if (!permitId || !Array.isArray(filenames) || !filenames.length) {
    return res.status(400).json({ error: 'Trūksta permitId arba filenames.' });
  }

  const { PDFDocument } = require('pdf-lib');
  const fontkit = require('@pdf-lib/fontkit');

  try {
    const merged = await PDFDocument.create();
    merged.registerFontkit(fontkit);

    for (const fname of filenames) {
      const safeBase = path.basename(fname);
      const fpath = path.join(UPLOAD_DIR, safeBase);
      if (!fs.existsSync(fpath)) { console.warn(`[MERGE] Failas nerastas: ${safeBase}`); continue; }
      const buf = fs.readFileSync(fpath);
      const ext = safeBase.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-4);

      if (ext === 'pdf') {
        try {
          const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages  = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
          pages.forEach((p) => merged.addPage(p));
        } catch (e) { console.warn(`[MERGE] PDF merge klaida (${safeBase}): ${e.message}`); }
      } else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') {
        try {
          const img  = ext === 'png' ? await merged.embedPng(buf) : await merged.embedJpg(buf);
          const { width, height } = img.scale(1);
          // Mastelis — telpame A4 (595x842) su paraštėmis
          const maxW = 550, maxH = 800;
          const scale = Math.min(maxW / width, maxH / height, 1);
          const w = width * scale, h = height * scale;
          const page = merged.addPage([w + 20, h + 20]);
          page.drawImage(img, { x: 10, y: 10, width: w, height: h });
        } catch (e) { console.warn(`[MERGE] Pav. embed klaida (${safeBase}): ${e.message}`); }
      } else {
        console.warn(`[MERGE] Nežinomas formatas, praleidžiama: ${safeBase}`);
      }
    }

    if (merged.getPageCount() === 0) {
      return res.status(400).json({ error: 'Nė vienas failas nebuvo sėkmingai apdorotas.' });
    }

    const pdfBytes = await merged.save();
    const b64 = Buffer.from(pdfBytes).toString('base64');
    console.log(`[MERGE] Sujungta ${merged.getPageCount()} psl. iš ${filenames.length} failų`);
    res.json({ ok: true, content: b64, filename: 'dokumentai_seniunijai.pdf', pages: merged.getPageCount() });
  } catch (e) {
    console.error('[MERGE] Klaida:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Laiškas seniūnijai apie atliktus darbus ───────────────────
// Dangų linksniuotės serverio pusėje
const SURFACE_SHORT_SRV = {
  'Asfaltbetonis': 'asfalto',
  'Žvyras':        'žvyro',
  'Trinkelės':     'trinkelių',
  'Plytelės':      'plytelių',
  'Gruntas':       'grunto',
  'Betonas':       'betono',
  'Žalieji plotai':'žalioji',
  'Kietos dangos': 'kietos',
};

function buildSurfaceTextSrv(surfaces) {
  if (!surfaces || !surfaces.length) return 'danga atstatyta';
  if (surfaces.length === 1 && surfaces[0] === 'Žalieji plotai') return 'žalieji plotai atstatyti';
  const shorts = surfaces.map((s) => SURFACE_SHORT_SRV[s] || s.toLowerCase());
  return shorts.join('/') + ' danga atstatyta';
}

app.post('/api/admin/send-seniunija-closure', async (req, res) => {
  const { permitId, workType, surfaces, seniunijaEmail, seniunijaName } = req.body || {};
  if (!permitId || !seniunijaEmail || !seniunijaName) {
    return res.status(400).json({ error: 'Trūksta permitId, seniunijaEmail arba seniunijaName.' });
  }

  const permits = dbGet('kl-permits') || [];
  const permit  = permits.find((p) => p.id === permitId);
  if (!permit) return res.status(404).json({ error: 'Paraiška nerasta.' });

  const startDate = permit.startDate || '—';
  const endDate   = permit.endDate   || '—';
  const location  = permit.location  || '—';
  const desc      = permit.description || 'įrengimas';
  const wt        = workType || 'planinius';
  const surfTxt   = buildSurfaceTextSrv(Array.isArray(surfaces) ? surfaces : []);

  const emailSubject = `Informacija apie atliktus kasimo darbus ir gerbūvio atstatymą — ${location}`;
  const bodyText =
`Laba diena,

Nuo ${startDate} iki ${endDate} vykdėme ${wt} kasimo darbus ${seniunijaName}, ${location}, elektros tinklų ${desc}.
Darbai yra baigti, ${surfTxt}. Pridedam gerbūvio nuotraukas, nuotraukas prieš darbus ir Kauno m. sav. išduotą leidimą.

Pagarbiai,
EnergoLT`;

  // Priedai — sujungtas PDF (jei pateiktas) arba atskiri failai
  const attachments = [];
  const { mergedContent, mergedFilename } = req.body || {};
  if (mergedContent) {
    attachments.push({
      filename: mergedFilename || 'dokumentai_seniunijai.pdf',
      content: Buffer.from(mergedContent, 'base64'),
      contentType: 'application/pdf',
    });
  } else {
    // Fallback: atskiri failai
    for (const f of [...(permit.beforeFiles || []), ...(permit.closeFiles || [])]) {
      const fp = path.join(UPLOAD_DIR, f.filename || '');
      if (fs.existsSync(fp)) attachments.push({ filename: f.name, content: fs.readFileSync(fp) });
    }
    const savPdf = (permit.permitPdfs || {}).sav || null;
    if (savPdf && savPdf.filename) {
      const fp = path.join(UPLOAD_DIR, savPdf.filename);
      if (fs.existsSync(fp)) attachments.push({ filename: savPdf.name || 'leidimas.pdf', content: fs.readFileSync(fp) });
    }
  }

  try {
    await sendAndSave({
      from: MAIL_FROM_EXTERNAL,
      to: seniunijaEmail,
      subject: emailSubject,
      text: bodyText,
      attachments,
    });
    console.log(`[SENIUNIJA] Laiškas išsiųstas → ${seniunijaEmail} (${seniunijaName}) | ${location} | ${attachments.length} priedai`);
  } catch (e) {
    console.error(`[SENIUNIJA] Klaida: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }

  // Žymime kaip išsiųstą
  const today = fmtDateSrv(new Date());
  dbSet('kl-permits', permits.map((p) => p.id !== permitId ? p : {
    ...p,
    seniunijaSent: true,
    seniunijaSentAt: today,
    seniunijaName,
    history: [...(p.history || []), {
      status: p.status, date: today,
      note: `Seniūnijai (${seniunijaName}) išsiųstas informacinis laiškas apie atliktus darbus`,
    }],
  }));

  res.json({ ok: true });
});

// ── Kauno sav. uždarymo pranešimų sąrašas ────────────────────
app.get('/api/admin/sav-close-requests', (req, res) => {
  res.json({ ok: true, requests: dbGet('kl-sav-close-requests') || [] });
});

// ── Atsakymas į Kauno sav. uždarymo pranešimą ────────────────
// POST /api/admin/reply-sav-closure { requestId, permitId }
app.post('/api/admin/reply-sav-closure', async (req, res) => {
  const { requestId, permitId } = req.body || {};
  if (!requestId || !permitId) return res.status(400).json({ error: 'Trūksta requestId arba permitId.' });

  const requests = dbGet('kl-sav-close-requests') || [];
  const request  = requests.find((r) => r.id === requestId);
  if (!request) return res.status(404).json({ error: 'Uždarymo pranešimas nerastas.' });

  const permits = dbGet('kl-permits') || [];
  const permit  = permits.find((p) => p.id === permitId);
  if (!permit) return res.status(404).json({ error: 'Paraiška nerasta.' });

  // Priedai — objekto nuotraukos iš closeFiles
  const attachments = (permit.closeFiles || []).map((f) => {
    const fpath = path.join(UPLOAD_DIR, f.filename || '');
    if (!fpath || !fs.existsSync(fpath)) return null;
    return { filename: f.name, content: fs.readFileSync(fpath) };
  }).filter(Boolean);

  const replySubject = request.subject.startsWith('Re:') ? request.subject : 'Re: ' + request.subject;
  const replyText = 'Laba diena,\n\nDarbai baigti, pridedu gerbūvio nuotraukas.\n\nPagarbiai,\nEnergoLT';

  try {
    await sendAndSave({
      from: MAIL_FROM_EXTERNAL,
      to: request.from,
      subject: replySubject,
      text: replyText,
      inReplyTo: request.messageId,
      references: request.messageId,
      attachments,
    });
    console.log(`[SAV-CLOSE] Atsakymas išsiųstas → ${request.from} | ${replySubject} | ${attachments.length} priedai`);
  } catch (e) {
    console.error(`[SAV-CLOSE] Laiško klaida: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }

  // Atnaujinti paraiškos statusą
  const today = fmtDateSrv(new Date());
  const updatedPermits = permits.map((p) => p.id !== permitId ? p : {
    ...p,
    status: 'Uždarytas',
    closingDone: true,
    closingDoneAt: today,
    history: [...(p.history || []), {
      status: 'Uždarytas',
      date: today,
      note: 'Savivaldybei išsiųstas atsakymas apie darbų pabaigimą',
    }],
  });
  dbSet('kl-permits', updatedPermits);

  // Pašalinti iš sąrašo
  dbSet('kl-sav-close-requests', requests.filter((r) => r.id !== requestId));

  res.json({ ok: true });
});

// Išvalyti apdorotų laiškų sąrašą — leidžia iš naujo patikrinti visus laiškus
app.post('/api/admin/clear-imap-done', (req, res) => {
  dbSet('kl-imap-done', []);
  console.log('[IMAP] kl-imap-done išvalytas — kitas tikrinimas apdoros visus laiškus iš naujo.');
  res.json({ ok: true, message: 'IMAP done sąrašas išvalytas.' });
});

// Priskirti jau atsisiųstus PDF prie paraiškų kurios dar neturi permitPdfs
// Naudojama: paraiška turi files[] su PDF, bet permitPdfs tuščias
app.post('/api/admin/reprocess-unattached', async (req, res) => {
  const permits = dbGet('kl-permits') || [];
  const TRULY_FINAL = new Set(['Atmestas', 'Nebegalioja']);
  let assigned = 0;
  const log = [];

  const updated = permits.map((p) => {
    if (TRULY_FINAL.has(p.status)) return p;
    const orgs = Array.isArray(p.organizations) && p.organizations.length > 0
      ? p.organizations : p.organization ? [p.organization] : [];
    const needTelia = orgs.includes('Telia, Kaunas');
    const needKE    = orgs.includes('Kauno energija');
    if (!needTelia && !needKE) return p;

    const pdfs = p.permitPdfs || {};
    let changed = false;
    const newPdfs = { ...pdfs };

    // Renkame PDF failus iš p.files kurie neatrodo kaip projekto failai
    const pdfFiles = (p.files || []).filter((f) => f.name && f.name.match(/\.pdf$/i));

    if (needTelia && !(pdfs.telia && pdfs.telia.name)) {
      // Ieškome failo kuris atrodo kaip Telia sutikimas
      const teliaFile = pdfFiles.find((f) =>
        /telia|sutik|derinimas|pritarim/i.test(f.name)
      ) || (pdfFiles.length === 1 ? pdfFiles[0] : null);
      if (teliaFile) {
        newPdfs.telia = { name: teliaFile.name, url: teliaFile.url || null, filename: teliaFile.filename || null };
        changed = true;
        log.push(`#${p.id.slice(-5).toUpperCase()} → Telia: ${teliaFile.name}`);
      }
    }
    if (needKE && !(pdfs.ke && pdfs.ke.name)) {
      const keFile = pdfFiles.find((f) =>
        /kauno.energ|ke|sutik|derinimas|pritarim/i.test(f.name)
      ) || (pdfFiles.length === 1 && !newPdfs.telia ? pdfFiles[0] : null);
      if (keFile) {
        newPdfs.ke = { name: keFile.name, url: keFile.url || null, filename: keFile.filename || null };
        changed = true;
        log.push(`#${p.id.slice(-5).toUpperCase()} → KE: ${keFile.name}`);
      }
    }

    if (!changed) return p;
    assigned++;

    // Perskaičiuoti statusą
    const teliaDone = newPdfs.telia && newPdfs.telia.name;
    const keDone    = newPdfs.ke    && newPdfs.ke.name;
    const allDone   = (!needTelia || teliaDone) && (!needKE || keDone);
    const someDone  = (needTelia && teliaDone) || (needKE && keDone);
    const newStatus = allDone ? 'Gautas leidimas' : (someDone ? 'Gautas dalinai' : p.status);
    const today = fmtDateSrv(new Date());
    return {
      ...p,
      permitPdfs: newPdfs,
      status: newStatus !== p.status ? newStatus : p.status,
      history: newStatus !== p.status
        ? [...(p.history || []), { status: newStatus, date: today, note: 'Leidimo PDF priskirtas rankiniu būdu (reprocess)' }]
        : p.history,
    };
  });

  if (assigned > 0) dbSet('kl-permits', updated);
  console.log(`[REPROCESS] Priskirta: ${assigned} paraiška(-ų). ${log.join('; ')}`);
  res.json({ ok: true, assigned, log });
});

// Rankinis IMAP tikrinimo paleidimas per API
app.post('/api/admin/check-mail', async (req, res) => {
  const meta = {
    server: IMAP_HOST,
    port:   IMAP_PORT,
    secure: 'SSL/TLS',
    user:   IMAP_USER,
    passSet: !!SMTP_PASS,
    time:   new Date().toISOString(),
  };
  try {
    const result = await checkImapMail();
    const ok = !result.connError;
    res.json({ ok, ...meta, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, ...meta, connError: e.message, checked: 0, processed: 0 });
  }
});

// Paraiškos statuso atnaujinimas — naudoja Claude po automatinio pateikimo
app.post('/api/permits/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body || {};
  if (!status) return res.status(400).json({ error: 'Trūksta statuso.' });
  const permits = dbGet('kl-permits') || [];
  const idx = permits.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Paraiška nerasta.' });
  const today = fmtDateSrv(new Date());
  const updated = { ...permits[idx], status,
    history: [...(permits[idx].history || []), { status, date: today, note: note || '' }],
  };
  permits[idx] = updated;
  dbSet('kl-permits', permits);
  console.log(`[STATUS] Paraiška ${id.slice(-5).toUpperCase()} → "${status}"${note ? ' ('+note+')' : ''}`);
  res.json({ ok: true, permit: updated });
});

// Pranešimas administratoriui — Claude išsiunčia po formos užpildymo
app.post('/api/admin/notify', async (req, res) => {
  const { to, subject, html, text } = req.body || {};
  const recipient = to || 'eimutis.simkus@energolt.eu';
  try {
    await sendAndSave({
      from: MAIL_FROM_INTERNAL,
      to: recipient,
      subject: subject || 'Digpoint pranešimas',
      html: html || `<p>${text || 'Pranešimas iš Digpoint.'}</p>`,
    });
    console.log(`[NOTIFY] Pranešimas išsiųstas → ${recipient}: ${subject}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[NOTIFY] Klaida:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Išvalyti apdorotų laiškų sąrašą (kad perprocessintų iš naujo — testavimui)
app.post('/api/admin/clear-imap-done', (req, res) => {
  dbSet('kl-imap-done', []);
  console.log('[IMAP] kl-imap-done išvalytas rankiniu būdu.');
  res.json({ ok: true, message: 'kl-imap-done išvalytas.' });
});

// ── Nepriskirti PDF → priskirti paraiškai automatiškai ──────────
// Greitas nepriskirtų PDF sąrašas be parsavimo
app.get('/api/admin/list-unattached', (req, res) => {
  try {
    const permits     = dbGet('kl-permits') || [];
    const attachedSet = new Set();
    permits.forEach((p) => (p.files || []).forEach((f) => f.filename && attachedSet.add(f.filename)));
    const allFiles   = fs.readdirSync(UPLOAD_DIR);
    const unattached = allFiles.filter((fn) => fn.endsWith('.pdf') && !attachedSet.has(fn));
    res.json({ ok: true, count: unattached.length, files: unattached });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Suranda failus /uploads/ kurie nepriklauso nė vienai paraiškai,
// bando sugretinti pagal PDF tekstą ir teliaRouteTo/From/location.
// Jei aktyvių kandidatų nėra — ieško ir tarp jau gautų leidimų (prideda failą be statuso keitimo).
app.post('/api/admin/reprocess-unattached', async (req, res) => {
  try {
    const permits     = dbGet('kl-permits') || [];
    const attachedSet = new Set();
    permits.forEach((p) => (p.files || []).forEach((f) => f.filename && attachedSet.add(f.filename)));

    const allFiles   = fs.readdirSync(UPLOAD_DIR);
    const unattached = allFiles.filter((fn) => fn.endsWith('.pdf') && !attachedSet.has(fn));

    console.log(`[REPROCESS] Nepriskirti PDF: ${unattached.length} (iš ${allFiles.length} failų)`);
    if (!unattached.length) return res.json({ ok: true, processed: 0, message: 'Nepriskirtu PDF nerasta.' });

    const FINAL_STATUSES = new Set(['Gautas leidimas', 'Atmestas', 'Nebegalioja']);
    const today = fmtDateSrv(new Date());
    const results = [];

    for (const fname of unattached) {
      const fpath = path.join(UPLOAD_DIR, fname);
      let pdfText = '';
      try {
        const buf = fs.readFileSync(fpath);
        const parsed = await pdfParse(buf);
        pdfText = parsed.text || '';
      } catch (_) {}

      // Aptikti instituciją iš PDF teksto arba failo pavadinimo
      let org = detectOrgFromText(pdfText);
      if (!org) org = detectOrgFromText(fname); // fallback: iš failo pavadinimo
      if (!org) {
        results.push({ file: fname, result: 'org nerasta PDF tekste ir pavadinime — praleista' });
        continue;
      }

      const pdfLocation = extractLocationFromPdf(pdfText);
      const searchText  = pdfText + (pdfLocation ? ' ' + pdfLocation : '') + ' ' + fname;

      // 1) Pirmiausia aktyvios paraiškos
      const activeCandidates = permits.filter((p) =>
        !FINAL_STATUSES.has(p.status) && (
          (Array.isArray(p.organizations) && p.organizations.includes(org)) ||
          p.organization === org
        )
      );

      // 2) Jei aktyvių nėra — galutinės (failas pridedamas be statuso keitimo)
      const finalCandidates = activeCandidates.length === 0
        ? permits.filter((p) =>
            FINAL_STATUSES.has(p.status) && (
              (Array.isArray(p.organizations) && p.organizations.includes(org)) ||
              p.organization === org
            )
          )
        : [];

      const candidates  = activeCandidates.length > 0 ? activeCandidates : finalCandidates;
      const isFallback  = activeCandidates.length === 0 && finalCandidates.length > 0;

      let bestPermit = null;
      let bestScore  = 0;
      for (const p of candidates) {
        const permitAddr = p.teliaRouteTo || p.teliaRouteFrom || p.location || '';
        const score = calcLocationScore(permitAddr, searchText);
        if (score > bestScore) { bestScore = score; bestPermit = p; }
      }

      const hasAddr = candidates.some((p) => p.teliaRouteTo || p.teliaRouteFrom || p.location);
      const THRESHOLD = (candidates.length === 1 && !hasAddr) ? 0 : 0.35;

      if (!bestPermit || bestScore < THRESHOLD) {
        results.push({ file: fname, org, score: bestScore, result: 'paraiška nerasta (per žemas score)' });
        continue;
      }

      // Priskirti failą paraiškai
      const fstat     = fs.statSync(fpath);
      const fileEntry = { id: srvUid(), name: fname.replace(/^[a-z0-9]+_/, ''), filename: fname, size: fstat.size, url: `/uploads/${fname}` };
      const allPermits = dbGet('kl-permits') || [];
      const updated    = allPermits.map((p) => {
        if (p.id !== bestPermit.id) return p;
        const alreadyHas = (p.files || []).some((f) => f.filename === fname);
        if (alreadyHas) return p;
        const newFiles   = [...(p.files || []), fileEntry];
        const newHistory = [...(p.history || []), {
          status: isFallback ? p.status : 'Gautas leidimas',
          date:   today,
          note:   `Failas priskirtas rankiniu būdu (reprocess) iš ${org}${isFallback ? ' [papildomas prie jau gauto leidimo]' : ''}`,
        }];
        if (isFallback) {
          // Paraiška jau baigta — tik pridedame failą, nekeičiame statuso
          return { ...p, files: newFiles, history: newHistory };
        }
        return {
          ...p,
          status:           'Gautas leidimas',
          files:            newFiles,
          permitValidFrom:  p.permitValidFrom || p.startDate || today,
          permitValidUntil: p.permitValidUntil || p.endDate || '',
          history:          newHistory,
        };
      });
      dbSet('kl-permits', updated);
      // Atnaujinti lokali kintamasis tolimesniam ciklui
      permits.splice(0, permits.length, ...updated);
      const tag = isFallback ? '✅ priskirta (prie jau gauto)' : '✅ priskirta';
      results.push({ file: fname, org, score: bestScore, permit: bestPermit.id.slice(-5), result: tag });
      console.log(`[REPROCESS] ${fname} → #${bestPermit.id.slice(-5)} (${org}, score: ${bestScore.toFixed(2)})${isFallback ? ' [fallback]' : ''}`);
    }

    res.json({ ok: true, processed: results.filter((r) => r.result.startsWith('✅')).length, total: unattached.length, results });
  } catch (e) {
    console.error('[REPROCESS] Klaida:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SMTP ryšio testas — grąžina detalų rezultatą be laiško siuntimo
app.get('/api/admin/smtp-test', async (req, res) => {
  const info = {
    server:  '192.168.1.101',
    port:    465,
    secure:  'SSL/TLS',
    user:    'uzklausos@energolt.eu',
    passSet: !!SMTP_PASS,
    time:    new Date().toISOString(),
  };
  try {
    await mailer.verify();
    res.json({ ok: true, ...info, result: 'Prisijungta sėkmingai' });
  } catch (e) {
    res.status(500).json({ ok: false, ...info, error: e.message, code: e.code || null, command: e.command || null });
  }
});

// IMAP ryšio testas — prisijungia ir atsijungia, nieko nekeičia
app.get('/api/admin/imap-test', async (req, res) => {
  const info = {
    server:  IMAP_HOST,
    port:    IMAP_PORT,
    secure:  'SSL/TLS',
    user:    IMAP_USER,
    passSet: !!SMTP_PASS,
    time:    new Date().toISOString(),
  };
  if (!SMTP_PASS) return res.status(500).json({ ok: false, ...info, error: 'SMTP_PASS nenustatytas' });
  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: IMAP_USER, pass: SMTP_PASS },
    logger: false, tls: { rejectUnauthorized: false },
    connectionTimeout: 8000,
  });
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    await client.logout();
    res.json({ ok: true, ...info, result: 'Prisijungta sėkmingai', messages: status.messages, unseen: status.unseen });
  } catch (e) {
    try { await client.logout(); } catch (_) {}
    res.status(500).json({ ok: false, ...info, error: e.message, code: e.code || null });
  }
});

// Diagnostika: parodo kas pašte yra, nieko nekeičia
app.get('/api/admin/check-mail-debug', async (req, res) => {
  const IMAP_PASS = SMTP_PASS;
  if (!IMAP_PASS) return res.status(500).json({ error: 'SMTP_PASS nenustatytas' });

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 8000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const emails = [];
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const msgList = await client.search({ since });
      for (const seq of msgList.slice(0, 20)) { // max 20
        const msg = await client.fetchOne(seq, { envelope: true, bodyStructure: true });
        const from = (msg.envelope.from || [])[0];
        const fromAddr = from ? (from.address || '') : '';
        const pdfParts = findPdfParts(msg.bodyStructure);
        emails.push({
          seq,
          messageId: msg.envelope.messageId,
          date:      msg.envelope.date,
          from:      fromAddr,
          subject:   msg.envelope.subject,
          orgMatch:  detectOrgFromEmail(fromAddr) || '—',
          pdfCount:  pdfParts.length,
          alreadyDone: (dbGet('kl-imap-done') || []).includes(msg.envelope.messageId),
        });
      }
    } finally { lock.release(); }
    await client.logout();
    res.json({ connected: true, found: emails.length, emails });
  } catch (e) {
    try { await client.logout(); } catch (_) {}
    res.status(500).json({ connected: false, error: e.message });
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

// ── PDF šablono užpildymas su pdf-lib (koordinatinis overlay) ────
// Uždeda tikras reikšmes tiesiai ant PDF šablono, išsaugant originalų formatavimą.
// Koordinatės (x, y nuo puslapio apačios kairės) kalibruotos pagal LitGrid prašymą.
async function fillPdfTemplateAsync(pdfBuf, data) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const fontkit = require('@pdf-lib/fontkit');

  const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  pdfDoc.registerFontkit(fontkit);

  // Ieškome sistemos Unicode šrifto (su lietuviškų simbolių palaikymu)
  let font = null;
  const fontCandidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
    path.join(__dirname, 'public', 'font.ttf'),
  ];
  for (const fp of fontCandidates) {
    try {
      if (fs.existsSync(fp)) {
        font = await pdfDoc.embedFont(fs.readFileSync(fp));
        console.log('[fill-pdf] Šriftas:', fp);
        break;
      }
    } catch (_) {}
  }
  if (!font) {
    // Fallback: Helvetica (ASCII only — lietuviški simboliai bus praleisti)
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    console.warn('[fill-pdf] Unicode šriftas nerastas — naudojamas Helvetica');
  }

  const page = pdfDoc.getPages()[0];
  const { height } = page.getSize(); // A4 ≈ 841.89 pt

  const SZ = 9;      // pagrindinis teksto dydis dokumente
  const W = rgb(1, 1, 1); // balta
  const B = rgb(0, 0, 0); // juoda

  // Koordinatės kalibruotos pagal LitGrid prašymą (A4, matuojamos nuo apačios).
  // Jei tekstas nesutampa — tikslinti x/y reikšmes (po ~5-10 pt vienu metu).
  const overlay = [
    // key(duomenyse)          x     y nuo apačios         width (vietos kiekis)
    ['regionas',               50,   height - 167,         300 ],
    ['data',                   225,  height - 200,         120 ],
    ['adresas',                152,  height - 238,         230 ],
    // derinimo data šablone yra bet duomenyse nesiųčiama — paliekame tuščią:
    // ['derinimo data',       318,  height - 259,         120 ],
    ['darbu_vadovas',          159,  height - 368,         190 ],
    ['tel',                    402,  height - 368,         120 ],
    ['nuo',                    267,  height - 384,          80 ],
    ['iki',                    368,  height - 384,          80 ],
  ];

  for (const [key, x, y, w] of overlay) {
    const val = String((data || {})[key] || '');
    // Piešiame baltą stačiakampį (dengia originalų placeholder tekstą)
    page.drawRectangle({ x: x - 1, y: y - 2, width: w, height: SZ + 4, color: W, borderWidth: 0 });
    if (val) {
      page.drawText(val, { x, y, size: SZ, font, color: B, maxWidth: w - 2 });
    }
  }

  return Buffer.from(await pdfDoc.save());
}

app.post('/api/fill-pdf-template', async (req, res) => {
  try {
    const { docUrl, data } = req.body || {};
    if (!docUrl) return res.status(400).json({ error: 'Trūksta docUrl' });

    const rawBasename = path.basename(docUrl.replace(/\?.*$/, ''));
    const basename = (() => { try { return decodeURIComponent(rawBasename); } catch(_) { return rawBasename; } })();
    const p1 = path.join(UPLOAD_DIR, basename);
    const p2 = path.join(UPLOAD_DIR, rawBasename);
    const p3 = path.join(__dirname, 'public', basename);
    const p4 = path.join(__dirname, 'public', rawBasename);
    const resolvedPath = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : fs.existsSync(p3) ? p3 : fs.existsSync(p4) ? p4 : null;
    if (!resolvedPath) return res.status(404).json({ error: `Failas nerastas: ${basename}` });

    const pdfBuf = fs.readFileSync(resolvedPath);
    const filled = await fillPdfTemplateAsync(pdfBuf, data || {});
    const outName = basename.replace(/(_filled)?\.pdf$/i, '') + '.pdf';

    res.json({ content: filled.toString('base64'), filename: outName, mimeType: 'application/pdf' });
  } catch (e) {
    console.error('[fill-pdf] Klaida:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── LitGrid DOCX šablono užpildymas ir PDF konvertavimas ─────
// Priima: { docUrl, data: { data, adresas, projekto_nr, darbu_vadovas, tel, nuo, iki } }
// Grąžina: { content (base64), filename, mimeType }
// Ištaiso Word padalintus {{tag}} per kelis XML <w:r> elementus
function fixDocxSplitTags(zipFile) {
  const xmlFiles = Object.keys(zipFile.files).filter(f =>
    /word\/(document|header\d*|footer\d*|numbering)\.xml$/i.test(f)
  );
  xmlFiles.forEach(fn => {
    try {
      let xml = zipFile.files[fn].asText();
      for (let pass = 0; pass < 8; pass++) {
        const before = xml;
        // Suranda pirmąjį <w:t> su atvirais {{ ir jungią su kitu <w:t>
        xml = xml.replace(
          /<w:t([^>]*)>([^<]*\{[^<]*)<\/w:t><\/w:r>(?:<w:proofErr[^>]*\/>)*(?:<w:bookmarkStart[^>]*\/>)*(?:<w:bookmarkEnd[^>]*\/>)*<w:r(?:\s[^>]*)?>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t([^>]*)>([^<]*)<\/w:t>/g,
          function(m, a1, t1, a2, t2) {
            // Jungiam tik jei t1 turi neuždarytų {{ (daugiau {{ nei }})
            var opens = (t1.match(/\{\{/g) || []).length;
            var closes = (t1.match(/\}\}/g) || []).length;
            if (opens > closes) return '<w:t' + a1 + '>' + t1 + t2 + '</w:t>';
            // Arba t1 baigiasi { (padalintas vienas simbolis)
            if (t1.slice(-1) === '{') return '<w:t' + a1 + '>' + t1 + t2 + '</w:t>';
            return m;
          }
        );
        if (xml === before) break;
      }
      zipFile.file(fn, xml);
    } catch (_) {}
  });
}

// ── LitGrid PDF generavimas nuo nulio (be šablono) ─────────────
let _cachedFontBytes = null;
async function loadUnicodeFontBytes() {
  if (_cachedFontBytes) return _cachedFontBytes;
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
    path.join(__dirname, '.font-cache.ttf'),
  ];
  for (const fp of candidates) {
    try { if (fs.existsSync(fp)) { _cachedFontBytes = fs.readFileSync(fp); return _cachedFontBytes; } } catch (_) {}
  }
  // Atsisiunčiame vieną kartą ir talpinime
  const cacheFile = path.join(__dirname, '.font-cache.ttf');
  try {
    const buf = await new Promise((resolve, reject) => {
      require('https').get('https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf', r => {
        const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks))); r.on('error', reject);
      }).on('error', reject);
    });
    fs.writeFileSync(cacheFile, buf);
    _cachedFontBytes = buf;
    console.log('[font] Atsisiųstas ir išsaugotas NotoSans');
  } catch (e) { console.warn('[font] Nepavyko atsisiųsti:', e.message); }
  return _cachedFontBytes;
}

async function generateLitgridPdf(d) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const fontkit = require('@pdf-lib/fontkit');

  const regionas      = d.regionas      || '';
  const docDate       = d.data          || '';
  const adresas       = d.adresas       || '';
  const darbuVadovas  = d.darbu_vadovas || '';
  const tel           = d.tel           || '';
  const nuo           = d.nuo           || '';
  const iki           = d.iki           || '';

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const fontBytes = await loadUnicodeFontBytes();
  let font, fontB;
  if (fontBytes) {
    font  = await pdfDoc.embedFont(fontBytes);
    fontB = font;
  } else {
    font  = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const PW = 595.28, PH = 841.89;
  const page = pdfDoc.addPage([PW, PH]);
  const ML = 45, MR = PW - 45;
  const BK = rgb(0,0,0), GR = rgb(0.35,0.35,0.35), WH = rgb(1,1,1);

  const t = (text, x, y, sz=9, f=font, col=BK) => {
    if (text == null || text === '') return;
    page.drawText(String(text), { x, y, size: sz, font: f, color: col });
  };
  const tC = (text, y, sz=9, f=font) => {
    const w = f.widthOfTextAtSize(String(text||''), sz);
    t(text, (PW - w) / 2, y, sz, f);
  };
  const tR = (text, rx, y, sz=9, f=font) => {
    const w = f.widthOfTextAtSize(String(text||''), sz);
    t(text, rx - w, y, sz, f);
  };
  const hl = (x1, x2, y, th=0.5) => page.drawLine({ start:{x:x1,y}, end:{x:x2,y}, thickness:th, color:BK });
  const box = (x, y, w, h, th=0.5) => page.drawRectangle({ x, y, width:w, height:h, borderColor:BK, borderWidth:th, color:WH });

  // 1. Viršutinė antraštė (dešinė)
  ['LITGRID AB leidimų darbams,',
   'sutikimų statyti statinius elektros linijų apsaugos',
   'zonose išdavimo tvarkos aprašo priedas Nr. 1'
  ].forEach((l, i) => tR(l, MR, PH - 28 - i*9, 7));

  // 2. Pareiškėjo lentelė (viršuje)
  const tblTop = PH - 65, rowH = 20;
  const tblRows = [
    ['UAB „EnergoLT" įm.k. 302551560',                    '(fizinio asmens vardas, pavardė; juridinio asmens pavadinimas, įmonės kodas)'],
    ['V. Krėvės pr. 120, LT-51119 Kaunas',                '(fizinio asmens gyvenamoji vieta; juridinio asmens buveinės adresas, )'],
    [[(d.el_pastas || 'uzklausos@energolt.eu'), d.tel].filter(Boolean).join(', '), '(kontaktiniai duomenys: telefonas, faksas, el. pašto adresas)'],
    ['------',                                             '(atstovo duomenys, jei atstovauja įgaliotas asmuo, įgaliojimo data ir numeris)'],
  ];
  box(ML, tblTop - tblRows.length * rowH, MR - ML, tblRows.length * rowH);
  tblRows.forEach(([main, sub], i) => {
    const ry = tblTop - (i+1)*rowH;
    if (i > 0) hl(ML, MR, tblTop - i*rowH);
    tC(main, ry + 11, 9.5, fontB);
    tC(sub,  ry + 3,  7,   font);
  });

  // 3. Gavėjas
  let y = tblTop - tblRows.length * rowH - 22;
  t('LITGRID AB', ML, y, 10, fontB);       y -= 12;
  t('Perdavimo tinklo departamento', ML, y, 10); y -= 12;
  t('Infrastruktūros priežiūros centro', ML, y, 10); y -= 12;
  t(regionas, ML, y, 10);

  // 4. Pavadinimas
  y -= 28;
  const title = 'PRAŠYMAS LEISTI VYKDYTI DARBUS ELEKTROS LINIJOS APSAUGOS ZONOJE';
  tC(title, y, 10, fontB);

  // 5. Data / vieta
  y -= 20;
  const dW = font.widthOfTextAtSize(docDate||' ', 9);
  const dX = (PW - dW) / 2;
  t(docDate, dX, y, 9); hl(dX-5, dX+dW+5, y-1);
  tC('(data)', y-9, 7); y -= 20;
  tC('Kaunas', y, 9);
  const kW = font.widthOfTextAtSize('Kaunas', 9); hl((PW-kW)/2, (PW+kW)/2, y-1);
  tC('(vieta)', y-9, 7);

  // 6. Pagrindinis tekstas
  y -= 24;
  const lh = 12;
  t('Prašau leisti vykdyti¹ _____elektros tinklų įrengimo___ darbus, žemės sklype, esančiame', ML, y, 9);
  y -= 8; t('(nurodomas darbų pobūdis)', ML+115, y, 7, font, GR);
  y -= lh;

  const adLbl = 'adresu ________';
  const adX = ML + font.widthOfTextAtSize(adLbl, 9);
  t(adLbl, ML, y, 9);
  t(adresas, adX, y, 9);
  const adW = Math.max(font.widthOfTextAtSize(adresas, 9), 150);
  hl(adX, adX+adW, y-1);
  t(' kadastrinis -', adX+adW, y, 9);
  y -= 8; t('(žemės sklypo adresas)', ML, y, 7, font, GR); t('(unikalus numeris)', ML+290, y, 7, font, GR);
  y -= lh;

  t('sklypo Nr. _-___, koordinatėmis ', ML, y, 9);
  const skX = ML + font.widthOfTextAtSize('sklypo Nr. _-___, koordinatėmis ', 9);
  t('prisegtas suderintas brėžinys', skX, y, 9); hl(skX, skX+font.widthOfTextAtSize('prisegtas suderintas brėžinys', 9), y-1);
  t('. Projekto Litgrid AB', skX+font.widthOfTextAtSize('prisegtas suderintas brėžinys', 9), y, 9);
  y -= 8; t('(kadastrinis numeris)', ML, y, 7, font, GR); t('(žemės sklypo koordinatės)', ML+190, y, 7, font, GR);
  y -= lh;

  const derinData = d.derinimo_data || '';
  t('suderinimo numeris ____ bei data ', ML, y, 9);
  const derX = ML + font.widthOfTextAtSize('suderinimo numeris ____ bei data ', 9);
  t(derinData, derX, y, 9);
  const derW = Math.max(font.widthOfTextAtSize(derinData, 9), 100);
  hl(derX, derX + derW, y - 1);
  t(' (jei toks derinimas yra).', derX + derW, y, 9);
  y -= 8; t('(derinimo numeris)', ML, y, 7, font, GR); t('(derinimo išdavimo data)', ML+190, y, 7, font, GR);
  y -= lh + 6;

  // 7. Priedai
  t('Priedai:', ML, y, 9, fontB); y -= lh;
  t('Žemėlapis su nurodyta darbo vieta.', ML, y, 9); y -= lh + 6;

  // 8. Vykdytojas
  const vyk = 'Darbus vykdys: UAB „EnergoLT" V. Krėvės pr. 120, LT-51119 Kaunas, įm. kodas 302551560';
  const vykUlX = ML + font.widthOfTextAtSize('Darbus vykdys: ', 9);
  t(vyk, ML, y, 9);
  hl(vykUlX, ML+font.widthOfTextAtSize(vyk, 9), y-1);
  y -= 8; t('(juridinio asmens –pavadinimas, fizinio asmens – vardas pavardė, adresas)', ML+70, y, 7, font, GR);
  y -= lh + 3;

  // 9. Technika
  const tech = 'Naudojami kėlimo mechanizmai:   Mini ekskavatorius, kryptinio gręžimo įranga';
  const techUlX = ML + font.widthOfTextAtSize('Naudojami kėlimo mechanizmai:   ', 9);
  t(tech, ML, y, 9);
  hl(techUlX, ML+font.widthOfTextAtSize(tech, 9), y-1);
  y -= 8; t('(kėlimo kranai ar/ir savaeigiai keltuvai žmonėms kelti)', ML+110, y, 7, font, GR);
  y -= 8; hl(ML, MR, y, 0.8); y -= 14;

  // 10. Darbų vadovas
  t('Darbų vadovas: ', ML, y, 9);
  const vadX = ML + font.widthOfTextAtSize('Darbų vadovas: ', 9);
  t(darbuVadovas, vadX, y, 9);
  const vadW = Math.max(font.widthOfTextAtSize(darbuVadovas, 9), 120);
  hl(vadX, vadX+vadW, y-1);
  const telLX = vadX + vadW + 2;
  t(', tel.: ', telLX, y, 9);
  const telX = telLX + font.widthOfTextAtSize(', tel.: ', 9);
  t(tel, telX, y, 9);
  const telW = Math.max(font.widthOfTextAtSize(tel, 9), 80);
  hl(telX, telX+telW, y-1);
  y -= 8; t('(vardas, pavardė)', ML+50, y, 7, font, GR); y -= lh;

  t('Pageidaujamas darbų vykdymo laikas nuo ', ML, y, 9);
  const nuoX = ML + font.widthOfTextAtSize('Pageidaujamas darbų vykdymo laikas nuo ', 9);
  t(nuo, nuoX, y, 9);
  const nuoW = Math.max(font.widthOfTextAtSize(nuo, 9), 60);
  hl(nuoX, nuoX+nuoW, y-1);
  const ikiLX = nuoX + nuoW + 2;
  t(' iki ', ikiLX, y, 9);
  const ikiX = ikiLX + font.widthOfTextAtSize(' iki ', 9);
  t(iki, ikiX, y, 9);
  const ikiW = Math.max(font.widthOfTextAtSize(iki, 9), 60);
  hl(ikiX, ikiX+ikiW, y-1);
  t(' .', ikiX+ikiW, y, 9);
  y -= 8; t('(data)', nuoX, y, 7, font, GR); t('(data)', ikiX, y, 7, font, GR);
  y -= lh + 8;

  // 11. Parašas
  t('Prašymą užpildė žemės savininkas/ žemės savininko įgaliotas fizinis ar juridinis asmuo:', ML, y, 9);

  // Pozicijos: kairėje — vardas, dešinėje — parašo paveiksliukas
  const nameLineX = 165;
  const nameLineW = 140;
  const sigLineX  = 385;
  const sigLineW  = 90;

  // Parašo paveiksliukas — iš signatureFilename (uploads) arba public/signature.png
  let resolvedSigPath = null;
  if (d.signatureFilename) {
    const uploadedSig = path.join(UPLOAD_DIR, d.signatureFilename);
    if (fs.existsSync(uploadedSig)) resolvedSigPath = uploadedSig;
  }
  if (!resolvedSigPath) {
    const defaultSig = path.join(__dirname, 'public', 'signature.png');
    if (fs.existsSync(defaultSig)) resolvedSigPath = defaultSig;
  }

  // Įkelti ir išmatuoti paveikslėlį
  let _sigImg = null, _sigW = 0, _sigH = 0;
  if (resolvedSigPath) {
    try {
      const sigBytes = fs.readFileSync(resolvedSigPath);
      const ext = resolvedSigPath.toLowerCase();
      _sigImg = ext.endsWith('.png') ? await pdfDoc.embedPng(sigBytes) : await pdfDoc.embedJpg(sigBytes);
      const sc = _sigImg.scale(0.30);
      _sigW = sc.width; _sigH = sc.height;
    } catch (_) {}
  }

  // Patraukiame žemyn tiek, kad tilptų paveikslėlis virš linijos
  y -= Math.max(_sigH + 14, 46);

  // Piešiame parašo paveikslėlį VIRŠ dešinės linijos (centruojame horizontaliai)
  if (_sigImg) {
    const imgX = sigLineX + (sigLineW - _sigW) / 2;
    page.drawImage(_sigImg, { x: imgX, y: y + 3, width: _sigW, height: _sigH });
  }

  // Pasirašančiojo vardas VIRŠ linijos
  const nm = d.signatoryName || 'Eimutis Šimkus';
  const nmW = font.widthOfTextAtSize(nm, 9);
  t(nm, nameLineX + (nameLineW - nmW) / 2, y + 10, 9);

  // Horizontalios linijos
  hl(nameLineX, nameLineX + nameLineW, y);
  hl(sigLineX, sigLineX + sigLineW, y);
  y -= 8;

  t('(vardas, pavardė)', nameLineX, y, 7, font, GR);
  t('(parašas)', sigLineX + 8, y, 7, font, GR);

  // 2 puslapis — pastaba
  const p2 = pdfDoc.addPage([PW, PH]);
  const footnoteLines = [
    '¹Darbai, kuriems reikalingas perdavimo tinklų operatoriaus leidimas dirbti oro linijų apsaugos zonoje:',
    '1.  statinių statyba, remontas, rekonstravimas arba griovimas;',
    '2.  kalnakasybos, krovimo, dugno gilinimo, žemės kasimo, sprogdinimo, melioravimo, užtvindymo darbai;',
    '3.  mechanizuotas žemės ūkio kultūrų laistymas, gyvulių laikymo aikštelių, vielinių užtvarų ir metalinių tvorų įrengimas;',
    '4.  medžių kirtimas arba sodinimas linijų apsaugos zonose, taip pat medžių, galinčių griūti ant laidų ir atramų kirtimas už apsaugos zonos;',
    '5.  žemės darbai giliau kaip 0,3 metro, taip pat grunto lyginimas požeminių elektros kabelių linijų apsaugos zonoje.',
  ];
  let fy = PH - 50;
  footnoteLines.forEach(line => {
    p2.drawText(line, { x: ML, y: fy, size: 9, font, color: BK, maxWidth: MR - ML });
    fy -= 14;
  });

  return Buffer.from(await pdfDoc.save());
}

app.post('/api/generate-litgrid-pdf', async (req, res) => {
  try {
    const { data } = req.body || {};
    const pdfBuf = await generateLitgridPdf(data || {});
    res.json({ content: pdfBuf.toString('base64'), filename: 'Litgrid_prašymas kasimo darbams.pdf', mimeType: 'application/pdf' });
  } catch (e) {
    console.error('[generate-litgrid-pdf] Klaida:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/generate-docx-pdf', (req, res) => {
  try {
    const { docUrl, data } = req.body || {};
    if (!docUrl) return res.status(400).json({ error: 'Trūksta docUrl' });

    // Failo kelias — URL decode + tik uploads aplanke
    const rawBasename = path.basename(docUrl.replace(/\?.*$/, ''));
    const basename = (() => { try { return decodeURIComponent(rawBasename); } catch(_) { return rawBasename; } })();
    const docxPath = path.join(UPLOAD_DIR, basename);
    const docxPathRaw = path.join(UPLOAD_DIR, rawBasename);
    const resolvedPath = fs.existsSync(docxPath) ? docxPath : fs.existsSync(docxPathRaw) ? docxPathRaw : null;
    if (!resolvedPath)
      return res.status(404).json({ error: `Failas nerastas: ${basename}` });

    // Užpildyti kintamuosius — paprastas string replace (patikimiau nei docxtemplater)
    const content = fs.readFileSync(resolvedPath, 'binary');
    const zip = new PizZip(content);

    // Procesina document.xml + header/footer failus
    const xmlTargets = Object.keys(zip.files).filter(f =>
      /^word\/(document|header\d*|footer\d*)\.xml$/i.test(f)
    );
    xmlTargets.forEach(xmlFile => {
      try {
        let xml = zip.files[xmlFile].asText();
        // Kiekvieną kintamąjį pakeičiame reikšme
        Object.keys(data || {}).forEach(key => {
          xml = xml.split(`{{${key}}}`).join(data[key] != null ? String(data[key]) : '');
        });
        // Likusius neužpildytus tagus — išvalome
        xml = xml.replace(/\{\{[^{}]+\}\}/g, '');
        zip.file(xmlFile, xml);
      } catch (_) {}
    });

    const filledBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    // Bandome konvertuoti į PDF per LibreOffice
    let pdfBuf = null;
    try {
      const tmpDocx = path.join(os.tmpdir(), `kl_${Date.now()}.docx`);
      fs.writeFileSync(tmpDocx, filledBuf);
      // LibreOffice: Linux — libreoffice, Windows — soffice
      const sofficeBin = process.platform === 'win32' ? 'soffice' : 'libreoffice';
      execSync(`${sofficeBin} --headless --convert-to pdf --outdir "${os.tmpdir()}" "${tmpDocx}"`, { timeout: 30000 });
      const pdfPath = tmpDocx.replace(/\.docx$/, '.pdf');
      if (fs.existsSync(pdfPath)) {
        pdfBuf = fs.readFileSync(pdfPath);
        try { fs.unlinkSync(pdfPath); } catch (_) {}
      }
      try { fs.unlinkSync(tmpDocx); } catch (_) {}
    } catch (loErr) {
      console.log('[DOCX→PDF] LibreOffice nepasiekiama — siunčiama DOCX:', loErr.message.slice(0, 80));
    }

    if (pdfBuf) {
      res.json({ content: pdfBuf.toString('base64'), filename: basename.replace(/\.docx$/i, '.pdf'), mimeType: 'application/pdf' });
    } else {
      res.json({ content: filledBuf.toString('base64'), filename: basename, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
  } catch (e) {
    console.error('[DOCX→PDF] Klaida:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Deploy endpoint — git pull + pm2 restart ─────────────────
// Pataisymas: Telia/KE paraiškoms su tuščiu permitValidUntil — užpildome iš teliaEndDate/keEndDate
app.post('/api/admin/fix-permit-dates', (req, res) => {
  const permits = dbGet('kl-permits') || [];
  let fixed = 0;
  const updated = permits.map((p) => {
    if (p.permitValidUntil && p.permitValidUntil.trim()) return p; // jau turi
    if (p.status !== 'Gautas leidimas' && p.status !== 'Gautas dalinai') return p;
    const fallback = p.teliaEndDate || p.keEndDate || p.endDate || '';
    if (!fallback) return p;
    fixed++;
    return { ...p, permitValidUntil: fallback };
  });
  if (fixed > 0) dbSet('kl-permits', updated);
  res.json({ ok: true, fixed });
});

app.post('/api/admin/deploy', (req, res) => {
  const dir = __dirname;
  exec(`cd ${dir} && git pull && npm install --omit=dev && pm2 restart digpoint`, { timeout: 120000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout, stderr, error: err ? err.message : null });
    if (!err) console.log('[DEPLOY] git pull + npm install + pm2 restart OK');
    else console.error('[DEPLOY] Klaida:', err.message);
  });
});

// ── Savivaldybės ištraukimas iš PDF ──────────────────────────
// Patikrina PDF failo tekstą ir grąžina savivaldybės pavadinimą.
// POST /api/extract-municipality  { filename: "..." arba url: "/uploads/..." }
app.post('/api/extract-municipality', async (req, res) => {
  const { filename, url } = req.body || {};
  try {
    let fpath;
    if (filename) {
      fpath = path.join(__dirname, 'uploads', path.basename(filename));
    } else if (url) {
      // url gali būti "/uploads/xxx.pdf" arba "/public/xxx.pdf"
      const rel = url.replace(/^\/+/, '');
      fpath = path.join(__dirname, rel);
      if (!fs.existsSync(fpath)) fpath = path.join(__dirname, 'public', rel);
    }
    if (!fpath || !fs.existsSync(fpath)) {
      return res.json({ municipality: null, error: 'Failas nerastas: ' + (fpath || '?') });
    }
    const buf = fs.readFileSync(fpath);
    const parsed = await pdfParse(buf);
    const text = parsed.text || '';

    // Ieškome savivaldybės pavadinimo PDF tekste
    const municipality = extractMunicipalityFromText(text);
    console.log('[MUN] Iš PDF:', path.basename(fpath), '→', municipality || 'nerasta');
    res.json({ municipality, text: text.slice(0, 800) });
  } catch (e) {
    console.warn('[MUN] Klaida:', e.message);
    res.json({ municipality: null, error: e.message });
  }
});

function extractMunicipalityFromText(text) {
  if (!text) return null;
  // 1. Ieškome "X r. sav." arba "X m. sav." (pilnas pavadinimas)
  const m1 = text.match(/([A-ZŠŽČĘĖĮŪĄ][a-ząšžčęėįūąA-ZŠŽČĘĖĮŪĄ\-]+(?: [a-ząšžčęėįūą]+)?)\s+(?:r|m)\.\s*sav\./);
  if (m1) return m1[0].replace(/\s+/g, ' ').trim();
  // 2. Ieškome "X sav." (pvz. Marijampolės sav., Elektrėnų sav.)
  const m2 = text.match(/([A-ZŠŽČĘĖĮŪĄ][a-ząšžčęėįūąA-ZŠŽČĘĖĮŪĄ\-]+(?: [a-ząšžčęėįūą]+)?)\s+sav\./);
  if (m2) return m2[0].replace(/\s+/g, ' ').trim();
  return null;
}

// ── Versija iš package.json ───────────────────────────────────
app.get('/api/version', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({ version: pkg.version });
  } catch (e) {
    res.json({ version: '?' });
  }
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
