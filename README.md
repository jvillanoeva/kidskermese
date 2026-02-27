# Kids Kermesse — Registration System

A simple registration + QR ticketing system. No payments, no friction. Attendees register, get an email with their QR code, and present it at the door.

## Stack
- **Frontend**: Plain HTML/CSS/JS
- **Backend**: Node.js + Express
- **Database**: Supabase
- **QR Generation**: `qrcode` npm package
- **Email**: Resend

---

## Setup

### 1. Clone and install
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```
Fill in your keys in `.env`.

### 3. Set up Supabase
- Go to your Supabase project → SQL Editor
- Run the contents of `supabase-schema.sql`
- Use the **Service Role** key (not the anon key) in your `.env`

### 4. Set up Resend
- Create a free account at resend.com
- Verify your sending domain
- Copy your API key to `.env`

### 5. Run
```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

Visit `http://localhost:3000`

---

## How it works

1. Attendee fills out the form (name, student name, email)
2. Backend generates a UUID for the registration
3. Record saved to Supabase
4. QR code generated from the UUID
5. Resend fires a confirmation email with the QR attached
6. At the door: scan QR → UUID → look up in Supabase → verify

---

## Future additions
- [ ] Admin dashboard to view registrations
- [ ] Door scanning app (camera reads QR, marks `checked_in = true`)
- [ ] Capacity limits
- [ ] Payment integration
