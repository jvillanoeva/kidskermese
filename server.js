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

const BASE_URL = process.env.BASE_URL || 'https://kidskermese-production.up.railway.app';

// POST /create-checkout — creates Stripe checkout session
app.post('/create-checkout', async (req, res) => {
  const { name, student_name, email } = req.body;

  if (!name || !student_name || !email) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  try {
    const registrationId = uuidv4();
    const ticketPriceCents = parseInt(process.env.TICKET_PRICE_CENTS) || 2000;

    // Create Stripe Checkout session FIRST — save to DB only after payment confirmed
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: ticketPriceCents,
          product_data: {
            name: 'Kids Kermesse — Entrada',
            description: `Acceso para: ${student_name}`
          }
        },
        quantity: 1
      }],
      metadata: { registrationId, name, student_name, email },
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
      subject: '🎪 Tu acceso a Kids Kermesse',
      html: buildEmailHTML({ name, student_name, registrationId }),
      attachments: [{
        filename: 'acceso-kermesse.png',
        content: qrBase64,
        content_type: 'image/png'
      }]
    });

    return res.status(200).json({ success: true, name, email });

  } catch (err) {
    console.error('Confirm error:', err);
    return res.status(500).json({ error: 'Error al confirmar el pago.' });
  }
});

// Email HTML template
function buildEmailHTML({ name, student_name, registrationId }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff8f0; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .header { background: #ff6b35; padding: 36px 40px; text-align: center; }
    .header h1 { color: white; font-size: 28px; margin: 0; font-weight: 800; }
    .header p { color: rgba(255,255,255,0.85); font-size: 14px; margin-top: 6px; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 12px; }
    .info { font-size: 15px; color: #555; line-height: 1.7; margin-bottom: 24px; }
    .detail-box { background: #fff8f0; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px; }
    .detail-box p { margin: 0; font-size: 14px; color: #888; }
    .detail-box strong { color: #1a1a2e; }
    .qr-section { text-align: center; margin-bottom: 28px; }
    .qr-section p { font-size: 13px; color: #aaa; margin-top: 12px; }
    .qr-img { width: 200px; height: 200px; border-radius: 12px; border: 3px solid #ff6b35; }
    .footer { background: #fafafa; padding: 20px 40px; text-align: center; }
    .footer p { font-size: 12px; color: #ccc; margin: 0; }
    .id-code { font-family: monospace; font-size: 11px; color: #ccc; margin-top: 8px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎪 Kids Kermesse</h1>
      <p>Tu acceso está confirmado</p>
    </div>
    <div class="body">
      <p class="greeting">Hola, ${name} 👋</p>
      <p class="info">
        Gracias por registrarte. Adjuntamos tu código QR de acceso para el evento.
        Preséntalo en la entrada el día de la Kermesse.
      </p>

      <div class="detail-box">
        <p>Registrado por: <strong>${name}</strong></p>
        <p>Estudiante: <strong>${student_name}</strong></p>
      </div>

      <div class="qr-section">
        <p style="font-weight:700; color:#1a1a2e; font-size:15px; margin-bottom:16px;">Tu código de acceso</p>
        <img src="cid:qr-code" alt="Código QR" class="qr-img" />
        <p>Muestra este código en la entrada</p>
      </div>
    </div>
    <div class="footer">
      <p>Kids Kermesse · Evento familiar</p>
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
