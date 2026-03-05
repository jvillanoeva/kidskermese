require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Stripe = require('stripe');

const app = express();
app.use(cors());
app.use(express.json());

// ── Root → redirect to Colectivo login ──
app.get('/', (req, res) => {
  res.redirect('https://colectivo.live/login');
});

// Serve success.html and other static assets (but NOT Kids Kermesse index)
app.use(express.static(path.join(__dirname, 'public')));

// Init clients
// supabase: service role — for admin operations + JWT verification
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
// supabaseAnon: anon key — for user-facing auth (signIn)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const BASE_URL = process.env.BASE_URL || 'https://api.colectivo.live';

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const token = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token inválido o expirado.' });
  req.user = user;
  // Attach role so all endpoints can scope by it without extra queries
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  req.user.role = profile?.role || 'promoter';
  next();
}

async function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere superadmin.' });
  }
  next();
}

// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos.' });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Credenciales incorrectas.' });

  // Fetch role from profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  return res.status(200).json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
      role: profile?.role || 'promoter'
    }
  });
});

// GET /auth/me — verify token + return user info
app.get('/auth/me', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', req.user.id)
    .single();

  return res.status(200).json({
    id: req.user.id,
    email: req.user.email,
    role: profile?.role || 'promoter'
  });
});

// POST /auth/set-password — invited user sets their password using token from email
app.post('/auth/set-password', async (req, res) => {
  const { access_token, refresh_token, password } = req.body;
  if (!access_token || !password) {
    return res.status(400).json({ error: 'Token y contraseña requeridos.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  try {
    // Create a client scoped to this user's session
    const { createClient: createUserClient } = require('@supabase/supabase-js');
    const userClient = createUserClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // Set the session with the invite tokens
    const { error: sessionError } = await userClient.auth.setSession({ access_token, refresh_token });
    if (sessionError) return res.status(401).json({ error: 'Token inválido o expirado.' });

    // Update the password
    const { data, error: updateError } = await userClient.auth.updateUser({ password });
    if (updateError) return res.status(500).json({ error: 'Error al establecer la contraseña.' });

    // Return a fresh token so they can log in immediately
    const { data: session } = await userClient.auth.getSession();
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', data.user.id).single();

    return res.status(200).json({
      success: true,
      token: session?.session?.access_token,
      user: { id: data.user.id, email: data.user.email, role: profile?.role || 'promoter' }
    });
  } catch (err) {
    console.error('Set password error:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /auth/invite — superadmin invites a new promoter
app.post('/auth/invite', requireAuth, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido.' });

  // Generate invite link — we send our own email via Resend instead of Supabase default
  const { data: linkData, error } = await supabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: 'https://colectivo.live/set-password' }
  });

  if (error) {
    console.error('Invite error:', error);
    const msg =
      error.message?.toLowerCase().includes('already registered') ||
      error.message?.toLowerCase().includes('already been invited') ||
      error.code === 'email_exists'
        ? 'Este correo ya tiene una cuenta en Colectivo.'
        : `Error: ${error.message || 'desconocido'}`;
    return res.status(500).json({ error: msg });
  }

  const inviteUrl = linkData.properties.action_link;

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: 'Te invitaron a Colectivo — Activa tu cuenta',
      html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#080808;font-family:monospace,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080808;padding:48px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr><td style="padding:0 0 40px;text-align:center;">
          <span style="font-family:monospace;font-size:13px;font-weight:700;letter-spacing:6px;color:#f5f0e8;">COLECTIVO</span>
        </td></tr>
        <tr><td style="background:#111111;border:1px solid #222222;padding:48px 40px;">
          <p style="margin:0 0 6px;font-family:monospace;font-size:10px;letter-spacing:4px;color:#FF3B1F;text-transform:uppercase;">// Invitación</p>
          <h1 style="margin:0 0 20px;font-family:monospace;font-size:28px;font-weight:700;letter-spacing:-1px;color:#f5f0e8;line-height:1.1;">BIENVENIDO<br/>A COLECTIVO</h1>
          <p style="margin:0 0 32px;font-family:monospace;font-size:13px;color:#888888;line-height:1.8;">
            Fuiste invitado a unirte a la plataforma de Colectivo como promotor.<br/>
            Haz clic en el botón para crear tu contraseña y activar tu cuenta.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:0 0 32px;">
              <a href="${inviteUrl}" style="display:inline-block;background:#FF3B1F;color:#ffffff;font-family:monospace;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;text-decoration:none;padding:16px 36px;">
                ACTIVAR CUENTA →
              </a>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #222222;padding-top:24px;">
            <p style="margin:0;font-family:monospace;font-size:10px;color:#444444;line-height:1.7;">
              Si no solicitaste esta invitación, puedes ignorar este correo.<br/>
              El enlace expira en 24 horas.
            </p>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:24px 0 0;text-align:center;">
          <p style="margin:0;font-family:monospace;font-size:9px;letter-spacing:3px;color:#333333;text-transform:uppercase;">
            ACCESO POR INVITACIÓN · COLECTIVO.LIVE
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
    });
  } catch (emailErr) {
    console.error('Resend invite error:', emailErr);
    return res.status(500).json({ error: 'Error al enviar el correo de invitación.' });
  }

  return res.status(200).json({ success: true, email });
});

// ─────────────────────────────────────────────
//  HELPER: load tiers for a given event slug
// ─────────────────────────────────────────────
async function getEventTiers(eventSlug) {
  if (!eventSlug) return null;
  const { data, error } = await supabase
    .from('events')
    .select('tiers, name')
    .eq('slug', eventSlug)
    .eq('published', true)
    .single();
  if (error || !data) return null;
  const map = {};
  for (const t of data.tiers || []) {
    map[t.id] = { label: t.label, price: t.price, capacity: t.capacity };
  }
  return { tiers: map, eventName: data.name };
}

// ─────────────────────────────────────────────
//  GET /availability
// ─────────────────────────────────────────────
app.get('/availability', async (req, res) => {
  const { event } = req.query;
  let tiers;

  if (event) {
    const eventData = await getEventTiers(event);
    if (!eventData) return res.status(404).json({ error: 'Evento no encontrado.' });
    tiers = eventData.tiers;
  } else {
    tiers = {
      early:   { label: 'Early Bird',  price: 650,  capacity: 150 },
      general: { label: 'General',     price: 950,  capacity: 500 },
      vip:     { label: 'VIP',         price: 1800, capacity: 50  }
    };
  }

  const result = {};
  for (const [key, tier] of Object.entries(tiers)) {
    const { count } = await supabase
      .from('registrations')
      .select('*', { count: 'exact', head: true })
      .eq('payment_status', 'paid')
      .like('student_name', `%${tier.label}%`)
      .eq('event_slug', event || 'caballeros-aniversario');
    const sold = count || 0;
    result[key] = { label: tier.label, capacity: tier.capacity, sold, available: Math.max(0, tier.capacity - sold) };
  }
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(result);
});

// ─────────────────────────────────────────────
//  POST /create-checkout
// ─────────────────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  const { name, email, phone, tier, quantity, event: eventSlug } = req.body;

  if (!name || !email || !tier) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  let tiers, eventName;

  if (eventSlug) {
    const eventData = await getEventTiers(eventSlug);
    if (!eventData) return res.status(404).json({ error: 'Evento no encontrado.' });
    tiers = eventData.tiers;
    eventName = eventData.eventName;
  } else {
    tiers = {
      early:   { label: 'Early Bird',  price: 65000,  capacity: 150 },
      general: { label: 'General',     price: 95000,  capacity: 500 },
      vip:     { label: 'VIP',         price: 180000, capacity: 50  }
    };
    eventName = 'Aniversario Caballeros';
    tiers = {
      early:   { label: 'Early Bird',  price: 650,  capacity: 150 },
      general: { label: 'General',     price: 950,  capacity: 500 },
      vip:     { label: 'VIP',         price: 1800, capacity: 50  }
    };
  }

  const tierData = tiers[tier];
  if (!tierData) {
    return res.status(400).json({ error: 'Tipo de acceso no válido.' });
  }

  const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 4);

  try {
    const { count: sold } = await supabase
      .from('registrations')
      .select('*', { count: 'exact', head: true })
      .eq('payment_status', 'paid')
      .like('student_name', `%${tierData.label}%`)
      .eq('event_slug', eventSlug || 'caballeros-aniversario');

    const available = tierData.capacity - (sold || 0);
    if (available < qty) {
      return res.status(400).json({
        error: available <= 0
          ? 'Este tier está agotado.'
          : `Solo quedan ${available} lugares disponibles para este tier.`
      });
    }

    const registrationIds = Array.from({ length: qty }, () => uuidv4()).join(',');
    const tierLabel = `${eventName} — ${tierData.label}`;
    const chargedAmount = Math.round(tierData.price * 1.08); // in pesos

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: chargedAmount * 100, // Stripe expects centavos
          product_data: {
            name: `${eventName} — ${tierData.label}`,
            description: `Acceso ${tierData.label} · incluye cargo por servicio Colectivo`
          }
        },
        quantity: qty
      }],
      metadata: {
        registrationIds, name,
        student_name: tierLabel,
        email,
        phone: phone || '',
        tier,
        quantity: String(qty),
        event_slug: eventSlug || 'caballeros-aniversario'
      },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: 'Error al crear el pago.' });
  }
});

// ─────────────────────────────────────────────
//  POST /confirm-payment
// ─────────────────────────────────────────────
app.post('/confirm-payment', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Session ID requerido.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Pago no completado.' });
    }

    const { registrationIds, name, student_name, email, phone, quantity, event_slug } = session.metadata;
    const ids = registrationIds.split(',');
    const qty = parseInt(quantity) || 1;

    const { data: existing } = await supabase
      .from('registrations')
      .select('payment_status')
      .eq('id', ids[0])
      .single();

    if (existing?.payment_status === 'paid') {
      return res.status(200).json({ success: true, alreadyConfirmed: true, name, email, quantity: qty });
    }

    const qrCodes = [];
    const attachments = [];
    const insertRows = [];

    for (let i = 0; i < ids.length; i++) {
      const ticketId = ids[i];
      const [qrDataURL, qrBuffer] = await Promise.all([
        QRCode.toDataURL(ticketId, { width: 300, margin: 2, color: { dark: '#080808', light: '#ffffff' } }),
        QRCode.toBuffer(ticketId, { width: 300, margin: 2, color: { dark: '#080808', light: '#ffffff' } })
      ]);

      qrCodes.push({ id: ticketId, qrDataURL });
      attachments.push({
        filename: qty > 1 ? `ticket-${i + 1}-de-${qty}.png` : 'ticket.png',
        content: qrBuffer,
        contentType: 'image/png'
      });
      insertRows.push({
        id: ticketId, name, student_name,
        email, phone: phone || null,
        payment_status: 'paid',
        event_slug: event_slug || 'caballeros-aniversario'
      });
    }

    const { error: insertError } = await supabase.from('registrations').insert(insertRows);
    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Error al guardar el registro.' });
    }

    const eventDisplay = student_name.split(' — ')[0] || 'Colectivo';
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: `🎟️ ${qty > 1 ? `Tus ${qty} accesos` : 'Tu acceso'} — ${eventDisplay}`,
      html: buildEmailHTML({ name, student_name, qrCodes }),
      attachments
    });

    return res.status(200).json({ success: true, name, email, quantity: qty });

  } catch (err) {
    console.error('Confirm error:', err);
    return res.status(500).json({ error: 'Error al confirmar el pago.' });
  }
});

// ─────────────────────────────────────────────
//  POST /admin/resend-email
// ─────────────────────────────────────────────
app.post('/admin/resend-email', async (req, res) => {
  const { email, password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  if (!email) return res.status(400).json({ error: 'Email requerido.' });

  try {
    const { data: registrations, error } = await supabase
      .from('registrations')
      .select('*')
      .eq('email', email)
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: true });

    if (error || !registrations?.length) {
      return res.status(404).json({ error: 'No se encontraron boletos para este correo.' });
    }

    const { name, student_name } = registrations[0];
    const qty = registrations.length;
    const qrCodes = [];
    const attachments = [];

    for (let i = 0; i < registrations.length; i++) {
      const ticketId = registrations[i].id;
      const [qrDataURL, qrBuffer] = await Promise.all([
        QRCode.toDataURL(ticketId, { width: 300, margin: 2, color: { dark: '#080808', light: '#ffffff' } }),
        QRCode.toBuffer(ticketId, { width: 300, margin: 2, color: { dark: '#080808', light: '#ffffff' } })
      ]);
      qrCodes.push({ id: ticketId, qrDataURL });
      attachments.push({
        filename: qty > 1 ? `ticket-${i + 1}-de-${qty}.png` : 'ticket.png',
        content: qrBuffer,
        contentType: 'image/png'
      });
    }

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: `🔁 Reenvío de accesos — ${student_name.split(' — ')[0] || 'Colectivo'}`,
      html: buildEmailHTML({ name, student_name, qrCodes }),
      attachments
    });

    return res.status(200).json({ success: true, qty });

  } catch (err) {
    console.error('Resend email error:', err);
    return res.status(500).json({ error: 'Error al reenviar el email.' });
  }
});

// ─────────────────────────────────────────────
//  EMAIL HTML TEMPLATE
// ─────────────────────────────────────────────
function buildEmailHTML({ name, student_name, qrCodes }) {
  const qty = qrCodes.length;
  const eventDisplay = student_name.split(' — ')[0] || 'Colectivo';
  const qrBlocks = qrCodes.map((qr, i) => `
    <div class="qr-section">
      <div class="qr-label">${qty > 1 ? `// Boleto ${i + 1} de ${qty}` : '// Tu código de acceso'}</div>
      <img src="${qr.qrDataURL}" alt="Código QR" class="qr-img" />
      <div class="qr-id">ID: ${qr.id}</div>
    </div>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #080808; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: #111111; overflow: hidden; }
    .header { background: #080808; padding: 40px; text-align: center; border-bottom: 1px solid #222; }
    .header-tag { font-family: monospace; font-size: 10px; letter-spacing: 4px; color: #FF3B1F; text-transform: uppercase; margin-bottom: 12px; }
    .header h1 { color: #f5f0e8; font-size: 32px; margin: 0; font-weight: 800; letter-spacing: -1px; }
    .header p { color: #555; font-size: 13px; margin-top: 6px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 17px; font-weight: 700; color: #f5f0e8; margin-bottom: 8px; }
    .info { font-size: 14px; color: #888; line-height: 1.7; margin-bottom: 28px; }
    .detail-box { background: #1a1a1a; border: 1px solid #222; padding: 20px 24px; margin-bottom: 32px; }
    .detail-box p { margin: 0 0 6px; font-size: 13px; color: #666; }
    .detail-box p:last-child { margin-bottom: 0; }
    .detail-box strong { color: #f5f0e8; }
    .attachment-note { background: #0f0f0f; border: 1px solid #1a1a1a; border-left: 3px solid #FF3B1F; padding: 14px 20px; margin-bottom: 28px; font-size: 13px; color: #666; }
    .attachment-note strong { color: #f5f0e8; }
    .qr-section { text-align: center; margin-bottom: 16px; background: #1a1a1a; border: 1px solid #222; padding: 32px; }
    .qr-label { font-family: monospace; font-size: 10px; letter-spacing: 3px; color: #555; text-transform: uppercase; margin-bottom: 20px; }
    .qr-img { width: 200px; height: 200px; border: 3px solid #FF3B1F; display: block; margin: 0 auto; }
    .qr-id { font-family: monospace; font-size: 10px; color: #333; margin-top: 12px; word-break: break-all; }
    .footer { background: #080808; padding: 24px 40px; text-align: center; border-top: 1px solid #1a1a1a; }
    .footer p { font-size: 11px; color: #333; margin: 0; font-family: monospace; letter-spacing: 2px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-tag">// Colectivo presenta</div>
      <h1>${eventDisplay.toUpperCase()}</h1>
      <p>${qty > 1 ? `${qty} accesos confirmados` : 'Tu acceso está confirmado'}</p>
    </div>
    <div class="body">
      <p class="greeting">Hola, ${name} 👋</p>
      <p class="info">Tu pago fue procesado. ${qty > 1 ? `Aquí están tus ${qty} códigos QR` : 'Aquí está tu código QR'} — preséntalo en la entrada el día del evento.</p>
      <div class="detail-box">
        <p>Nombre: <strong>${name}</strong></p>
        <p>Tipo de acceso: <strong>${student_name}</strong></p>
        ${qty > 1 ? `<p>Cantidad: <strong>${qty} boletos</strong></p>` : ''}
      </div>
      <div class="attachment-note">
        📎 <strong>¿No ves el QR?</strong> También está adjunto como imagen PNG en este correo.
      </div>
      ${qrBlocks}
    </div>
    <div class="footer">
      <p>COLECTIVO.LIVE</p>
    </div>
  </div>
</body>
</html>
  `;
}

// ─────────────────────────────────────────────
//  GET /admin/registrations
// ─────────────────────────────────────────────
app.get('/admin/registrations', async (req, res) => {
  const { password, event } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  let query = supabase
    .from('registrations')
    .select('*')
    .order('created_at', { ascending: false });

  if (event) query = query.eq('event_slug', event);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Error al obtener registros.' });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(data);
});

// ─────────────────────────────────────────────
//  POST /verify
// ─────────────────────────────────────────────
app.post('/verify', async (req, res) => {
  const { id, password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  if (!id) return res.status(400).json({ error: 'ID requerido.' });

  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return res.status(404).json({ status: 'not_found', message: 'Registro no encontrado.' });
  }

  if (data.checked_in) {
    return res.status(200).json({ status: 'already_checked_in', message: 'Ya ingresó al evento.', registration: data });
  }

  await supabase
    .from('registrations')
    .update({ checked_in: true, checked_in_at: new Date().toISOString() })
    .eq('id', id);

  return res.status(200).json({ status: 'success', message: '¡Acceso válido!', registration: data });
});

// ─────────────────────────────────────────────
//  EVENT CRUD — PUBLIC
// ─────────────────────────────────────────────

app.get('/events/:slug', async (req, res) => {
  const { slug } = req.params;
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('slug', slug)
    .eq('published', true)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Evento no encontrado.' });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(data);
});

// ─────────────────────────────────────────────
//  EVENT CRUD — ADMIN (legacy password auth)
// ─────────────────────────────────────────────

app.get('/admin/events', async (req, res) => {
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const { data, error } = await supabase
    .from('events')
    .select('id, slug, name, date_label, published, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Error al obtener eventos.' });
  return res.status(200).json(data);
});

app.get('/admin/events/:slug', async (req, res) => {
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('slug', req.params.slug)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Evento no encontrado.' });
  return res.status(200).json(data);
});

app.post('/admin/events', async (req, res) => {
  const { password, ...eventData } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  if (!eventData.slug || !eventData.name) {
    return res.status(400).json({ error: 'slug y name son requeridos.' });
  }
  eventData.slug = eventData.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const { data, error } = await supabase
    .from('events')
    .insert([eventData])
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Ya existe un evento con ese slug.' });
    return res.status(500).json({ error: 'Error al crear el evento.' });
  }
  return res.status(201).json(data);
});

app.put('/admin/events/:slug', async (req, res) => {
  const { password, ...eventData } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  delete eventData.slug;
  delete eventData.id;
  delete eventData.created_at;

  const { data, error } = await supabase
    .from('events')
    .update(eventData)
    .eq('slug', req.params.slug)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Error al actualizar el evento.' });
  if (!data) return res.status(404).json({ error: 'Evento no encontrado.' });
  return res.status(200).json(data);
});

app.delete('/admin/events/:slug', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  const { error } = await supabase
    .from('events')
    .update({ published: false })
    .eq('slug', req.params.slug);

  if (error) return res.status(500).json({ error: 'Error al eliminar el evento.' });
  return res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────
//  EVENT CRUD — v2 (JWT auth)
// ─────────────────────────────────────────────

// GET /v2/admin/events
app.get('/v2/admin/events', requireAuth, async (req, res) => {
  let query = supabase
    .from('events')
    .select('id, slug, name, date_label, published, created_at, user_id')
    .order('created_at', { ascending: false });
  // Promoters only see their own events; superadmin sees all
  if (req.user.role !== 'superadmin') {
    query = query.eq('user_id', req.user.id);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Error al obtener eventos.' });
  return res.status(200).json(data);
});

// GET /v2/admin/events/:slug
app.get('/v2/admin/events/:slug', requireAuth, async (req, res) => {
  let query = supabase.from('events').select('*').eq('slug', req.params.slug);
  if (req.user.role !== 'superadmin') {
    query = query.eq('user_id', req.user.id);
  }
  const { data, error } = await query.single();
  if (error || !data) return res.status(404).json({ error: 'Evento no encontrado.' });
  return res.status(200).json(data);
});

// POST /v2/admin/events
app.post('/v2/admin/events', requireAuth, async (req, res) => {
  const eventData = { ...req.body };
  delete eventData.password;
  if (!eventData.slug || !eventData.name) {
    return res.status(400).json({ error: 'slug y name son requeridos.' });
  }
  eventData.slug = eventData.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  eventData.user_id = req.user.id;
  eventData.user_email = req.user.email;

  const { data, error } = await supabase
    .from('events').insert([eventData]).select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Ya existe un evento con ese slug.' });
    return res.status(500).json({ error: 'Error al crear el evento.' });
  }
  return res.status(201).json(data);
});

// PUT /v2/admin/events/:slug
app.put('/v2/admin/events/:slug', requireAuth, async (req, res) => {
  const eventData = { ...req.body };
  delete eventData.password;
  delete eventData.slug;
  delete eventData.id;
  delete eventData.created_at;

  let query = supabase.from('events').update(eventData).eq('slug', req.params.slug);
  if (req.user.role !== 'superadmin') {
    query = query.eq('user_id', req.user.id);
  }
  const { data, error } = await query.select().single();
  if (error) return res.status(500).json({ error: 'Error al actualizar el evento.' });
  if (!data) return res.status(404).json({ error: 'Evento no encontrado o sin permiso.' });
  return res.status(200).json(data);
});

// DELETE /v2/admin/events/:slug
app.delete('/v2/admin/events/:slug', requireAuth, async (req, res) => {
  let query = supabase.from('events').update({ published: false }).eq('slug', req.params.slug);
  if (req.user.role !== 'superadmin') {
    query = query.eq('user_id', req.user.id);
  }
  const { error } = await query;
  if (error) return res.status(500).json({ error: 'Error al eliminar el evento.' });
  return res.status(200).json({ success: true });
});

// GET /v2/admin/events/:slug/stats
app.get('/v2/admin/events/:slug/stats', requireAuth, async (req, res) => {
  const { slug } = req.params;

  let evQuery = supabase.from('events').select('*').eq('slug', slug);
  if (req.user.role !== 'superadmin') {
    evQuery = evQuery.eq('user_id', req.user.id);
  }
  const { data: event, error: evErr } = await evQuery.single();
  if (evErr || !event) return res.status(404).json({ error: 'Evento no encontrado.' });

  const { data: registrations } = await supabase
    .from('registrations')
    .select('*')
    .eq('event_slug', slug)
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false });

  const regs = registrations || [];
  const tiers = event.tiers || [];

  const tierStats = tiers.map(tier => {
    const tierRegs = regs.filter(r => r.student_name?.includes(tier.label));
    const sold = tierRegs.length;
    return {
      id: tier.id,
      label: tier.label,
      price: tier.price,
      capacity: tier.capacity,
      sold,
      available: Math.max(0, tier.capacity - sold),
      revenue: sold * tier.price
    };
  });

  const totalSold = tierStats.reduce((s, t) => s + t.sold, 0);
  const totalRevenue = tierStats.reduce((s, t) => s + t.revenue, 0);
  const totalCapacity = tierStats.reduce((s, t) => s + t.capacity, 0);

  return res.status(200).json({
    event: { slug: event.slug, name: event.name, date_label: event.date_label, venue: event.venue },
    stats: {
      totalSold,
      totalRevenue,
      totalCapacity,
      fillRate: totalCapacity > 0 ? Math.round((totalSold / totalCapacity) * 100) : 0
    },
    tiers: tierStats,
    registrations: regs.map(r => ({
      id: r.id, name: r.name, email: r.email,
      phone: r.phone, student_name: r.student_name,
      created_at: r.created_at, checked_in: r.checked_in,
      checked_in_at: r.checked_in_at
    }))
  });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Colectivo server running on http://localhost:${PORT}`);
});
