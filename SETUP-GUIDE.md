# The Nest on Tennyson — Setup & Deployment Guide

This is your complete direct booking website for Tennyson Street, Petone. Below is everything you need to get it live.

---

## What's Included

| File | Purpose |
|------|---------|
| `index.html` | The main website — SEO-optimised, responsive, with photo gallery and booking form |
| `booking-confirmed.html` | Post-payment success page |
| `server/index.js` | Node.js backend — handles Stripe payments, Airbnb calendar sync, Yale lock codes, guest emails |
| `images/` | Your 32 professional property photos |
| `package.json` | Node.js dependencies |
| `.env.example` | Template for your secret keys (copy to `.env`) |

---

## Architecture Overview

```
Guest visits site → Picks dates → Clicks "Book"
    ↓
Stripe Checkout (hosted by Stripe — PCI compliant)
    ↓
Payment confirmed (Stripe webhook)
    ↓
Three things happen automatically:
  1. Yale lock code generated (via Seam API) for check-in/checkout window
  2. Guest receives confirmation email with access code
  3. You (James) receive a notification email with booking details
```

The site also syncs with your Airbnb calendar (via iCal) to disable dates that are already booked on Airbnb — preventing double bookings.

---

## Step-by-Step Setup

### 1. Get a Domain Name

Suggested: **thenestontennyson.co.nz**

Purchase from [Metaname](https://metaname.net) or [1st Domains](https://www.1stdomains.nz/) (NZ registrars). A `.co.nz` domain costs ~$25/year.

After purchase, update the `<link rel="canonical">` and Open Graph URLs in `index.html` to match.

### 2. Set Up Stripe (Payments)

1. Sign up at [stripe.com](https://stripe.com) (Stripe is available in NZ)
2. Complete identity verification (required for live payments)
3. Go to **Developers → API Keys**
4. Copy your **Secret Key** → put in `.env` as `STRIPE_SECRET_KEY`
5. Set up a webhook:
   - Go to **Developers → Webhooks → Add endpoint**
   - URL: `https://yourdomain.com/api/webhook`
   - Events: select `checkout.session.completed`
   - Copy the **Signing Secret** → put in `.env` as `STRIPE_WEBHOOK_SECRET`

**Stripe fees in NZ:** 2.7% + 30c per transaction. On a $1,330 booking (5 nights), that's ~$36 — far less than Airbnb's ~$200 in fees.

### 3. Set Up Airbnb Calendar Sync (Two-Way)

Your iCal export URL is already configured in `.env`.

**Direction 1 — Airbnb → Your site (already done):**
Your server fetches Airbnb's iCal feed to block dates that are booked on Airbnb.

**Direction 2 — Your site → Airbnb (set this up now):**
Your server exposes its own iCal feed of direct bookings at:
```
https://yourdomain.com/api/calendar.ics
```

To complete the two-way sync:
1. Log in to Airbnb → Go to your listing
2. **Availability → Pricing and availability**
3. Scroll to **"Import calendar"**
4. Paste your feed URL: `https://yourdomain.com/api/calendar.ics`
5. Name it "Direct Bookings"
6. Click **Import**

Airbnb will poll this feed periodically (usually every few hours) and automatically block dates that are booked directly on your site. This prevents double bookings in both directions.

**Note:** Airbnb's import polling isn't instant — it can take up to 3 hours to sync. For same-day bookings, you may still want to manually block the dates on Airbnb as a safety measure. The host notification email reminds you to do this.

### 4. Set Up Yale Lock Integration (Seam)

Your Yale lock (YR C/D 226/246/256) can be controlled via the **Seam API**, which provides a universal smart lock interface.

1. Sign up at [console.seam.co](https://console.seam.co)
2. Connect your Yale account (Yale Access / Yale Home app)
3. Select your lock device
4. Copy your **API Key** → `.env` as `SEAM_API_KEY`
5. Copy your **Device ID** → `.env` as `SEAM_DEVICE_ID`

Seam will generate time-bound PIN codes that activate at 3 PM on check-in and expire at 10 AM on checkout. The code is automatically included in the guest's confirmation email.

**Seam pricing:** Free for up to 5 devices. See [seam.co/pricing](https://www.seam.co/pricing).

**Fallback:** If Seam isn't configured, the server generates a random 4-digit code and includes it in the email. You'd need to manually program this into the lock.

### 5. Set Up Email

The server uses SMTP to send emails. The simplest option is Gmail:

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Generate an App Password for "Mail"
3. Fill in `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your_email@gmail.com
   SMTP_PASS=your_16_char_app_password
   EMAIL_FROM="The Nest on Tennyson <your_email@gmail.com>"
   ```

**Alternative:** For higher-volume sending, consider [SendGrid](https://sendgrid.com) (free tier: 100 emails/day) or [Resend](https://resend.com).

### 6. Deploy

The recommended hosting approach is **Railway** or **Render** — both are simple, affordable, and support Node.js:

#### Option A: Railway (Recommended)

1. Sign up at [railway.app](https://railway.app)
2. Connect your GitHub repo (push this `website/` folder to GitHub first)
3. Railway auto-detects Node.js and deploys
4. Add your `.env` variables in Railway's dashboard
5. Point your domain DNS to Railway
6. **Cost:** ~$5-10 USD/month

#### Option B: Render

1. Sign up at [render.com](https://render.com)
2. Create a new **Web Service** → connect your repo
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables
6. **Cost:** Free tier available (spins down when idle)

#### Option C: VPS (DigitalOcean/Vultr)

For more control, deploy to a $6/month droplet. You'd use PM2 to keep the server running and Nginx as a reverse proxy.

### 7. DNS Setup

After deploying, point your domain to your host:

1. In your domain registrar, add a **CNAME record**:
   - Name: `www`
   - Value: your Railway/Render URL
2. Add an **A record** or **ALIAS** for the root domain if supported
3. Enable HTTPS (Railway and Render do this automatically)

---

## SEO Checklist

The site already includes these SEO features:

- [x] Semantic HTML with proper heading hierarchy
- [x] Meta title and description optimised for "Petone accommodation" searches
- [x] Open Graph and Twitter Card tags for social sharing
- [x] JSON-LD structured data (LodgingBusiness + FAQPage)
- [x] Mobile-responsive design
- [x] Fast loading (no JavaScript frameworks, minimal dependencies)
- [x] Alt text on all images
- [x] Canonical URL
- [x] FAQ section (targets "People also ask" in Google)

### Post-Launch SEO Actions

1. **Google Search Console** — Submit your sitemap and verify your domain
2. **Google Business Profile** — Create a listing for "The Nest on Tennyson" in Petone
3. **Google Maps** — Add your property as an accommodation
4. **Image optimisation** — Convert JPGs to WebP format for faster loading (use `cwebp` or an online converter). The current images are high quality but large.
5. **Content** — Consider adding a blog section with posts like "Things to do in Petone", "Best cafes on Jackson Street", etc.

---

## Booking Workflow Summary

```
1. Guest visits thenestontennyson.co.nz
2. Guest selects dates → calendar checks Airbnb iCal for conflicts
3. Guest clicks "Book" → redirected to Stripe Checkout
4. Guest pays via credit card (Stripe handles all PCI compliance)
5. Stripe sends webhook to your server
6. Server:
   a. Records the booking
   b. Calls Seam API → generates Yale lock time-bound PIN
   c. Sends guest email with: confirmation details + lock code
   d. Sends you (James) a notification email
7. Guest arrives → enters PIN on Yale lock → enjoys their stay
8. Lock code automatically expires at 10 AM on checkout day
```

---

## Cost Comparison: Airbnb vs Direct

Based on your 2025 earnings ($61,687 gross, 241 nights):

| | Airbnb | Direct Booking |
|---|---|---|
| Gross revenue | $61,687 | $61,687 |
| Host service fee | -$1,929 | $0 |
| Airbnb-remitted GST | -$3,582 (from guests) | You collect & remit GST yourself |
| Stripe fees (2.7% + 30c) | N/A | ~$1,665 |
| Hosting | $0 | ~$120/year |
| Domain | $0 | ~$25/year |
| Seam (lock API) | N/A | Free (< 5 devices) |
| **Your net saving** | — | **~$1,800/year in platform fees** |

Plus: guests save on Airbnb's guest service fee (typically 14-16%), making your direct rate more attractive at the same price point to you.

---

## Customisation Notes

- **Nightly rate:** Change `NIGHTLY_RATE` in `.env` and update the `$250` references in `index.html`
- **Cleaning fee:** Change `CLEANING_FEE` in `.env` and in the booking summary HTML
- **Photos:** Add/remove images in the `images/` folder and update the `photos` array in the `<script>` section of `index.html`
- **Reviews:** Update the review cards in `index.html` with real guest reviews
- **Seasonal pricing:** The server can be extended to support variable nightly rates based on date ranges
- **Google Maps:** Replace the map iframe with your exact coordinates for better accuracy

---

## Future Enhancements

- **Multi-channel calendar sync** — Use a channel manager to sync availability bidirectionally with Airbnb, Booking.com, etc.
- **Automated Airbnb blocking** — When a direct booking comes in, automatically block those dates on Airbnb via their API
- **Guest review collection** — Send a follow-up email after checkout asking for a review
- **Returning guest discounts** — Offer a discount code to previous guests
- **Database** — Replace the in-memory bookings store with SQLite or PostgreSQL for persistence across server restarts

---

## Support

For questions about this setup, email the developer or refer to:

- Stripe docs: https://stripe.com/docs
- Seam docs: https://docs.seam.co
- Flatpickr (date picker): https://flatpickr.js.org
- Nodemailer: https://nodemailer.com
