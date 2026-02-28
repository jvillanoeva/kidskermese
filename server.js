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

// Ticket tiers — source of truth for pricing (never trust client-side amounts)
const TIERS = {
  early:   { label: 'Early Bird',  price: 65000  },
  general: { label: 'General',     price: 95000  },
  vip:     { label: 'VIP',         price: 180000 }
};

// POST /create-checkout — creates Stripe checkout session
app.post('/create-checkout', async (req, res) => {
  const { name, email, tier } = req.body;

  if (!name || !email || !tier) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  const tierData = TIERS[tier];
  if (!tierData) {
    return res.status(400).json({ error: 'Tipo de acceso no válido.' });
  }

  try {
    const registrationId = uuidv4();
    const tierLabel = `Aniversario Caballeros — ${tierData.label}`;

    // Apply 6% Colectivo service fee on top of base price
    const chargedAmount = Math.round(tierData.price * 1.06);

    // Create Stripe Checkout session FIRST — save to DB only after payment confirmed
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: chargedAmount,
          product_data: {
            name: `Aniversario Caballeros — ${tierData.label}`,
            description: `Acceso ${tierData.label} · incluye cargo por servicio Colectivo`
          }
        },
        quantity: 1
      }],
      metadata: { registrationId, name, student_name: tierLabel, email, tier },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: 'Error al crear el pago.' });
  }
});

// POST /confirm-payment — called after Stripe redirect, verifies + sends QR email
app.post('/confirm-payment', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Session ID requerido.' });

  try {
    // Verify payment with Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Pago no completado.' });
    }

    const { registrationId, name, student_name, email } = session.metadata;

    // Check if already confirmed (prevent duplicate emails)
    const { data: existing } = await supabase
      .from('registrations')
      .select('payment_status')
      .eq('id', registrationId)
      .single();

    if (existing?.payment_status === 'paid') {
      return res.status(200).json({ success: true, alreadyConfirmed: true, name, email });
    }

    if (existing) {
      // Record exists as pending — update to paid
      await supabase
        .from('registrations')
        .update({ payment_status: 'paid' })
        .eq('id', registrationId);
    } else {
      // First time — insert the record
      await supabase
        .from('registrations')
        .insert([{ id: registrationId, name, student_name, email, payment_status: 'paid' }]);
    }

    // Generate QR code
    const qrDataURL = await QRCode.toDataURL(registrationId, {
      width: 300, margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    const qrBase64 = qrDataURL.split(',')[1];

    // Send confirmation email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: '🎟️ Tu acceso — Aniversario Caballeros',
      html: buildEmailHTML({ name, student_name, registrationId, qrDataURL })
    });

    return res.status(200).json({ success: true, name, email });

  } catch (err) {
    console.error('Confirm error:', err);
    return res.status(500).json({ error: 'Error al confirmar el pago.' });
  }
});

// Email HTML template
function buildEmailHTML({ name, student_name, registrationId, qrDataURL }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #080808; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: #111111; border-radius: 16px; overflow: hidden; }
    .header { background: #080808; padding: 40px; text-align: center; border-bottom: 1px solid #222; }
    .header-tag { font-family: monospace; font-size: 10px; letter-spacing: 4px; color: #FF3B1F; text-transform: uppercase; margin-bottom: 12px; }
    .header h1 { color: #f5f0e8; font-size: 32px; margin: 0; font-weight: 800; letter-spacing: -1px; }
    .header p { color: #555; font-size: 13px; margin-top: 6px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 17px; font-weight: 700; color: #f5f0e8; margin-bottom: 8px; }
    .info { font-size: 14px; color: #888; line-height: 1.7; margin-bottom: 28px; }
    .detail-box { background: #1a1a1a; border: 1px solid #222; border-radius: 8px; padding: 20px 24px; margin-bottom: 32px; }
    .detail-box p { margin: 0 0 6px; font-size: 13px; color: #666; }
    .detail-box p:last-child { margin-bottom: 0; }
    .detail-box strong { color: #f5f0e8; }
    .qr-section { text-align: center; margin-bottom: 32px; background: #1a1a1a; border: 1px solid #222; border-radius: 8px; padding: 32px; }
    .qr-label { font-family: monospace; font-size: 10px; letter-spacing: 3px; color: #555; text-transform: uppercase; margin-bottom: 20px; }
    .qr-img { width: 200px; height: 200px; border-radius: 8px; border: 3px solid #FF3B1F; display: block; margin: 0 auto; }
    .qr-note { font-size: 12px; color: #555; margin-top: 16px; }
    .footer { background: #080808; padding: 24px 40px; text-align: center; border-top: 1px solid #1a1a1a; }
    .footer p { font-size: 11px; color: #333; margin: 0; font-family: monospace; letter-spacing: 2px; }
    .id-code { font-family: monospace; font-size: 10px; color: #222; margin-top: 8px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-tag">// Caballeros presenta</div>
      <h1>ANIVERSARIO</h1>
      <p>Tu acceso está confirmado</p>
    </div>
    <div class="body">
      <p class="greeting">Hola, ${name} 👋</p>
      <p class="info">Tu pago fue procesado. Aquí está tu código QR de acceso — preséntalo en la entrada el día del evento.</p>

      <div class="detail-box">
        <p>Nombre: <strong>${name}</strong></p>
        <p>Tipo de acceso: <strong>${student_name}</strong></p>
      </div>

      <div class="qr-section">
        <div class="qr-label">// Tu código de acceso</div>
        <img src="${qrDataURL}" alt="Código QR" class="qr-img" />
        <div class="qr-note">Muestra este código en la entrada</div>
      </div>
    </div>
    <div class="footer">
      <p>COLECTIVO.LIVE · CABALLEROS</p>
      <p class="id-code">ID: ${registrationId}</p>
    </div>
  </div>
</body>
</html>
  `;
}

// GET /admin/registrations — returns all registrations (password protected)
app.get('/admin/registrations', async (req, res) => {
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Error al obtener registros.' });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(data);
});

// POST /verify — scans QR, verifies registration, marks checked_in
app.post('/verify', async (req, res) => {
  const { id, password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  if (!id) return res.status(400).json({ error: 'ID requerido.' });

  // Look up registration
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

  // Mark as checked in
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Kids Kermesse server running on http://localhost:${PORT}`);
});
