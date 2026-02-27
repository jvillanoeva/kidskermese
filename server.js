require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

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

// POST /register
app.post('/register', async (req, res) => {
  const { name, student_name, email } = req.body;

  if (!name || !student_name || !email) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  try {
    // 1. Generate unique ID for this registration
    const registrationId = uuidv4();

    // 2. Save to Supabase
    const { error: dbError } = await supabase
      .from('registrations')
      .insert([{ id: registrationId, name, student_name, email }]);

    if (dbError) {
      console.error('Supabase error:', dbError);
      return res.status(500).json({ error: 'Error al guardar el registro.' });
    }

    // 3. Generate QR code as base64 PNG
    // QR encodes the registration ID — scan at door to verify
    const qrDataURL = await QRCode.toDataURL(registrationId, {
      width: 300,
      margin: 2,
      color: {
        dark: '#1a1a2e',
        light: '#ffffff'
      }
    });

    // Extract base64 part (remove "data:image/png;base64," prefix)
    const qrBase64 = qrDataURL.split(',')[1];

    // 4. Send confirmation email via Resend
    const { error: emailError } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: '🎪 Tu acceso a Kids Kermesse',
      html: buildEmailHTML({ name, student_name, registrationId }),
      attachments: [
        {
          filename: 'acceso-kermesse.png',
          content: qrBase64,
          content_type: 'image/png'
        }
      ]
    });

    if (emailError) {
      console.error('Resend error:', emailError);
      // Registration saved, but email failed — don't fail silently
      return res.status(500).json({ error: 'Registro guardado, pero error al enviar correo.' });
    }

    return res.status(200).json({ success: true, id: registrationId });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Error inesperado. Intenta de nuevo.' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Kids Kermesse server running on http://localhost:${PORT}`);
});
