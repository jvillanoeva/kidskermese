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
app.use(express.static(path.join(__dirname, 'public')));

// Init clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const BASE_URL = process.env.BASE_URL || 'https://api.colectivo.live';

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
  // tiers stored as array: [{ id, label, price, capacity }]
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
    // Legacy fallback for caballeros-aniversario
    tiers = {
      early:   { label: 'Early Bird',  price: 65000,  capacity: 150 },
      general: { label: 'General',     price: 95000,  capacity: 500 },
      vip:     { label: 'VIP',         price: 180000, capacity: 50  }
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
    // Legacy fallback
    tiers = {
      early:   { label: 'Early Bird',  price: 65000,  capacity: 150 },
      general: { label: 'General',     price: 95000,  capacity: 500 },
      vip:     { label: 'VIP',         price: 180000, capacity: 50  }
    };
    eventName = 'Aniversario Caballeros';
  }

  const tierData = tiers[tier];
  if (!tierData) {
    return res.status(400).json({ error: 'Tipo de acceso no válido.' });
  }

  const qty = Math.min(Math.max(parseInt(quantity) || 1, 1), 4);

  try {
    // Check available capacity
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

    // Generate one UUID per ticket upfront for deduplication
    const registrationIds = Array.from({ length: qty }, () => uuidv4()).join(',');
    const tierLabel = `${eventName} — ${tierData.label}`;
    const chargedAmount = Math.round(tierData.price * 1.06);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: chargedAmount,
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
    // Verify payment with Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Pago no completado.' });
    }

    const { registrationIds, name, student_name, email, phone, quantity, event_slug } = session.metadata;
    const ids = registrationIds.split(',');
    const qty = parseInt(quantity) || 1;

    // Dedup check — use first ID
    const { data: existing } = await supabase
      .from('registrations')
      .select('payment_status')
      .eq('id', ids[0])
      .single();

    if (existing?.payment_status === 'paid') {
      return res.status(200).json({ success: true, alreadyConfirmed: true, name, email, quantity: qty });
    }

    // Generate QR codes — both dataURL (inline) and Buffer (attachment)
    const qrCodes = [];
    const attachments = [];
    const insertRows = [];

    for (let i = 0; i < ids.length; i++) {
      const ticketId = ids[i];
      const [qrDataURL, qrBuffer] = await Promise.all([
        QRCode.toDataURL(ticketId, {
          width: 300, margin: 2,
          color: { dark: '#080808', light: '#ffffff' }
        }),
        QRCode.toBuffer(ticketId, {
          width: 300, margin: 2,
          color: { dark: '#080808', light: '#ffffff' }
        })
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

    const { error: insertError } = await supabase
      .from('registrations')
      .insert(insertRows);
    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Error al guardar el registro.' });
    }

    // Get event display name for email subject
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
        QRCode.toDataURL(ticketId, {
          width: 300, margin: 2,
          color: { dark: '#080808', light: '#ffffff' }
        }),
        QRCode.toBuffer(ticketId, {
          width: 300, margin: 2,
          color: { dark: '#080808', light: '#ffffff' }
        })
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
        📎 <strong>¿No ves el QR?</strong> También está adjunto como imagen PNG en este correo — búscalo en los archivos adjuntos.
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
    return res.status(200).json({
      status: 'already_checked_in',
      message: 'Ya ingresó al evento.',
      registration: data
    });
  }

  await supabase
    .from('registrations')
    .update({ checked_in: true, checked_in_at: new Date().toISOString() })
    .eq('id', id);

  return res.status(200).json({
    status: 'success',
    message: '¡Acceso válido!',
    registration: data
  });
});

// ─────────────────────────────────────────────
//  EVENT CRUD — PUBLIC
// ─────────────────────────────────────────────

// GET /events/:slug — public event page data
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
//  EVENT CRUD — ADMIN
// ─────────────────────────────────────────────

// GET /admin/events — list all events
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

// GET /admin/events/:slug — get single event (includes unpublished)
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

// POST /admin/events — create event
app.post('/admin/events', async (req, res) => {
  const { password, ...eventData } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  if (!eventData.slug || !eventData.name) {
    return res.status(400).json({ error: 'slug y name son requeridos.' });
  }

  // Sanitize slug
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

// PUT /admin/events/:slug — update event
app.put('/admin/events/:slug', async (req, res) => {
  const { password, ...eventData } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  // Don't allow slug change via this endpoint
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

// DELETE /admin/events/:slug — delete event (soft: set published=false)
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
//  START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Colectivo server running on http://localhost:${PORT}`);
});
