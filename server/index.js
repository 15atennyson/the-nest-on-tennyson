/**
 * The Nest on Tennyson — Booking Server
 *
 * Handles:
 * 1. Stripe Checkout for payments
 * 2. Airbnb iCal sync to prevent double bookings
 * 3. Yale smart lock code generation (via Seam API)
 * 4. Guest email notifications
 * 5. Webhook processing for confirmed payments
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────
const PRICING_TIERS = [
    { minNights: 28, rate: 190, label: 'Monthly rate' },
    { minNights: 14, rate: 210, label: 'Fortnightly rate' },
    { minNights: 7,  rate: 230, label: 'Weekly rate' },
    { minNights: 1,  rate: 250, label: 'Standard rate' },
];
const CLEANING_FEE = 150;
const EXTRA_GUEST_FEE = 15;  // per night, per guest above 2
const BASE_GUESTS = 2;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

function getRateForNights(nights) {
    for (const tier of PRICING_TIERS) {
        if (nights >= tier.minNights) return tier;
    }
    return PRICING_TIERS[PRICING_TIERS.length - 1];
}

function getAllInRate(nights, guests) {
    const tier = getRateForNights(nights);
    const extraGuests = Math.max(0, guests - BASE_GUESTS);
    const cleaningPerNight = Math.round(CLEANING_FEE / nights);
    const guestFeePerNight = extraGuests * EXTRA_GUEST_FEE;
    const allInRate = tier.rate + cleaningPerNight + guestFeePerNight;
    const total = allInRate * nights;
    return { tier, allInRate, total, nights };
}

// ─── Middleware ──────────────────────────────────────────
// Stripe webhooks need raw body, so this must come BEFORE express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ─── Health Check ──────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        stripe: !!process.env.STRIPE_SECRET_KEY,
        email: !!process.env.SMTP_USER,
        airbnb: !!process.env.AIRBNB_ICAL_URL,
        seam: !!process.env.SEAM_API_KEY,
    });
});

// ─── Email Transport ────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// ─── In-Memory Bookings Store ───────────────────────────
// In production, use a database (e.g., PostgreSQL, SQLite)
const bookings = [];

// ═══════════════════════════════════════════════════════════
// 1. AVAILABILITY — Fetch Airbnb iCal + local bookings
// ═══════════════════════════════════════════════════════════

app.get('/api/availability', async (req, res) => {
    try {
        const bookedDates = await getBookedDates();
        res.json({ bookedDates });
    } catch (err) {
        console.error('Error fetching availability:', err);
        res.json({ bookedDates: [] });
    }
});

async function getBookedDates() {
    const dates = new Set();

    // 1. Fetch from Airbnb iCal
    if (process.env.AIRBNB_ICAL_URL) {
        try {
            const response = await fetch(process.env.AIRBNB_ICAL_URL);
            const icalText = await response.text();
            const airbnbDates = parseICalDates(icalText);
            airbnbDates.forEach(d => dates.add(d));
        } catch (err) {
            console.error('Failed to fetch Airbnb calendar:', err.message);
        }
    }

    // 2. Add locally confirmed bookings
    bookings
        .filter(b => b.status === 'confirmed')
        .forEach(b => {
            const dateRange = getDatesInRange(b.checkin, b.checkout);
            dateRange.forEach(d => dates.add(d));
        });

    return Array.from(dates).sort();
}

/**
 * Parse iCal format to extract booked date ranges.
 * Airbnb exports VEVENT blocks with DTSTART/DTEND for each booking.
 */
function parseICalDates(icalText) {
    const dates = [];
    const events = icalText.split('BEGIN:VEVENT');

    for (const event of events) {
        const startMatch = event.match(/DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/);
        const endMatch = event.match(/DTEND;VALUE=DATE:(\d{4})(\d{2})(\d{2})/);

        // Skip available/unblocked events
        const summary = event.match(/SUMMARY:(.*)/);
        if (summary && summary[1].trim().toLowerCase().includes('available')) continue;

        if (startMatch && endMatch) {
            const start = `${startMatch[1]}-${startMatch[2]}-${startMatch[3]}`;
            const end = `${endMatch[1]}-${endMatch[2]}-${endMatch[3]}`;
            const range = getDatesInRange(start, end);
            dates.push(...range);
        }
    }

    return dates;
}

function getDatesInRange(startStr, endStr) {
    const dates = [];
    const start = new Date(startStr);
    const end = new Date(endStr);
    const current = new Date(start);

    while (current < end) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }

    return dates;
}

// ═══════════════════════════════════════════════════════════
// 2. STRIPE CHECKOUT — Create payment session
// ═══════════════════════════════════════════════════════════

app.post('/api/create-checkout', async (req, res) => {
    try {
        const { checkin, checkout, guests } = req.body;

        // Validate dates
        if (!checkin || !checkout) {
            return res.status(400).json({ error: 'Check-in and checkout dates are required' });
        }

        const nights = Math.ceil(
            (new Date(checkout) - new Date(checkin)) / (1000 * 60 * 60 * 24)
        );

        if (nights < 1) {
            return res.status(400).json({ error: 'Checkout must be after check-in' });
        }

        // Check availability
        const bookedDates = await getBookedDates();
        const requestedDates = getDatesInRange(checkin, checkout);
        const conflict = requestedDates.find(d => bookedDates.includes(d));

        if (conflict) {
            return res.status(409).json({
                error: 'Some of your selected dates are no longer available',
                conflictDate: conflict
            });
        }

        // Calculate all-inclusive pricing (cleaning + guest fees baked into nightly rate)
        const pricing = getAllInRate(nights, guests);

        console.log(`💰 Pricing: ${nights} nights × $${pricing.allInRate}/night (${pricing.tier.label}, ${guests} guests) = $${pricing.total}`);

        // Create Stripe Checkout Session — single line item, all-inclusive
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            customer_creation: 'always',
            line_items: [
                {
                    price_data: {
                        currency: 'nzd',
                        product_data: {
                            name: `The Nest on Tennyson — ${nights} night${nights > 1 ? 's' : ''}`,
                            description: `${checkin} to ${checkout} · ${guests} guest${guests > 1 ? 's' : ''} · $${pricing.allInRate}/night`,
                            images: [`${SITE_URL}/images/IMG_0180.JPG`],
                        },
                        unit_amount: pricing.total * 100, // Stripe uses cents
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                checkin,
                checkout,
                guests: guests.toString(),
                nights: nights.toString(),
            },
            success_url: `${SITE_URL}/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${SITE_URL}/#booking`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// ═══════════════════════════════════════════════════════════
// 3. STRIPE WEBHOOK — Handle confirmed payments
// ═══════════════════════════════════════════════════════════

async function handleWebhook(req, res) {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        await handleSuccessfulBooking(session);
    }

    res.json({ received: true });
}

async function handleSuccessfulBooking(session) {
    const { checkin, checkout, guests, nights } = session.metadata;
    const customerEmail = session.customer_details.email;
    const customerName = session.customer_details.name;
    const amountPaid = (session.amount_total / 100).toFixed(2);

    console.log(`\n✅ New booking confirmed!`);
    console.log(`   Guest: ${customerName} (${customerEmail})`);
    console.log(`   Dates: ${checkin} → ${checkout} (${nights} nights)`);
    console.log(`   Amount: $${amountPaid} NZD\n`);

    // Store booking
    const booking = {
        id: session.id,
        checkin,
        checkout,
        guests: parseInt(guests),
        nights: parseInt(nights),
        customerEmail,
        customerName,
        amountPaid,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
    };
    bookings.push(booking);

    // Generate Yale lock access code
    let accessCode = null;
    try {
        accessCode = await generateAccessCode(checkin, checkout, customerName);
        booking.accessCode = accessCode;
    } catch (err) {
        console.error('Failed to generate lock code:', err.message);
    }

    // Send confirmation emails
    try {
        await sendGuestConfirmation(booking, accessCode);
        await sendHostNotification(booking);
    } catch (err) {
        console.error('Failed to send emails:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════
// 4. YALE LOCK — Generate time-limited access codes via Seam
// ═══════════════════════════════════════════════════════════

async function generateAccessCode(checkin, checkout, guestName) {
    if (!process.env.SEAM_API_KEY || !process.env.SEAM_DEVICE_ID) {
        console.log('⚠️  Seam not configured — skipping lock code generation');
        // Generate a random manual code as fallback
        const manualCode = String(Math.floor(1000 + Math.random() * 9000));
        console.log(`   Manual fallback code: ${manualCode}`);
        return manualCode;
    }

    const Seam = require('seam');
    const seam = new Seam({ apiKey: process.env.SEAM_API_KEY });

    // Create a time-bound access code
    // Active from 3 PM on check-in to 10 AM on checkout
    const startsAt = new Date(`${checkin}T15:00:00+12:00`); // NZST
    const endsAt = new Date(`${checkout}T10:00:00+12:00`);

    const accessCode = await seam.accessCodes.create({
        device_id: process.env.SEAM_DEVICE_ID,
        name: `Guest: ${guestName} (${checkin})`,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        // Let Seam generate a random code, or specify one:
        // code: '1234',
    });

    console.log(`🔐 Lock code created: ${accessCode.code} (active ${checkin} 3PM - ${checkout} 10AM)`);
    return accessCode.code;
}

// ═══════════════════════════════════════════════════════════
// 5. EMAIL — Guest confirmation & host notification
// ═══════════════════════════════════════════════════════════

async function sendGuestConfirmation(booking, accessCode) {
    const { customerName, customerEmail, checkin, checkout, nights, guests, amountPaid } = booking;

    const firstName = customerName ? customerName.split(' ')[0] : 'there';
    const checkinFormatted = new Date(checkin).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const checkoutFormatted = new Date(checkout).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const accessCodeSection = accessCode
        ? `
        <div style="background: #E8F0EC; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="margin: 0 0 8px; color: #6B6B6B; font-size: 14px;">Your door access code</p>
            <p style="margin: 0; font-size: 36px; font-weight: 700; color: #2C5F4B; letter-spacing: 8px;">${accessCode}</p>
            <p style="margin: 8px 0 0; color: #6B6B6B; font-size: 13px;">Active from 3:00 PM on check-in to 10:00 AM on checkout</p>
        </div>`
        : `<p style="color: #6B6B6B;">Your access code will be sent separately before check-in.</p>`;

    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #1A1A1A;">
        <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #E5E5E0;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 400; font-family: Georgia, serif;">The Nest on Tennyson</h1>
        </div>

        <div style="padding: 32px 24px;">
            <h2 style="margin: 0 0 16px; font-size: 22px;">Booking confirmed! 🎉</h2>
            <p>Hi ${firstName},</p>
            <p>Your stay at Tennyson Street, Petone is confirmed. Here are your booking details:</p>

            <div style="background: #FAFAF8; border: 1px solid #E5E5E0; border-radius: 12px; padding: 24px; margin: 24px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px 0; color: #6B6B6B;">Check-in</td>
                        <td style="padding: 8px 0; text-align: right; font-weight: 600;">${checkinFormatted} from 3:00 PM</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6B6B6B;">Checkout</td>
                        <td style="padding: 8px 0; text-align: right; font-weight: 600;">${checkoutFormatted} by 10:00 AM</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6B6B6B;">Duration</td>
                        <td style="padding: 8px 0; text-align: right; font-weight: 600;">${nights} night${nights > 1 ? 's' : ''}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6B6B6B;">Guests</td>
                        <td style="padding: 8px 0; text-align: right; font-weight: 600;">${guests}</td>
                    </tr>
                    <tr style="border-top: 1px solid #E5E5E0;">
                        <td style="padding: 12px 0 0; font-weight: 700;">Total paid</td>
                        <td style="padding: 12px 0 0; text-align: right; font-weight: 700; font-size: 18px;">$${amountPaid} NZD</td>
                    </tr>
                </table>
            </div>

            ${accessCodeSection}

            <h3 style="margin: 32px 0 12px;">Getting there</h3>
            <p>The property is on Tennyson Street, Petone, Lower Hutt. The exact address and parking instructions will be in a follow-up email closer to your check-in date.</p>

            <h3 style="margin: 24px 0 12px;">Need anything?</h3>
            <p>Feel free to reply to this email or reach out to James directly. I'm happy to help with restaurant recommendations, transport tips, or anything else to make your stay perfect.</p>

            <p style="margin-top: 32px;">Looking forward to hosting you!</p>
            <p><strong>James</strong><br>The Nest on Tennyson</p>
        </div>

        <div style="padding: 24px; text-align: center; border-top: 1px solid #E5E5E0; color: #6B6B6B; font-size: 13px;">
            <p>The Nest on Tennyson · Petone, Wellington, New Zealand</p>
        </div>
    </div>`;

    await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: customerEmail,
        subject: `Booking confirmed — The Nest on Tennyson (${checkinFormatted})`,
        html,
    });

    console.log(`📧 Guest confirmation sent to ${customerEmail}`);
}

async function sendHostNotification(booking) {
    const { customerName, customerEmail, checkin, checkout, nights, guests, amountPaid, accessCode } = booking;

    const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; color: #1A1A1A;">
        <h2>New Direct Booking! 🎉</h2>
        <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Guest</td><td><strong>${customerName}</strong></td></tr>
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Email</td><td>${customerEmail}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Dates</td><td>${checkin} → ${checkout} (${nights} nights)</td></tr>
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Guests</td><td>${guests}</td></tr>
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Total</td><td><strong>$${amountPaid} NZD</strong></td></tr>
            <tr><td style="padding: 6px 12px 6px 0; color: #666;">Lock code</td><td><strong>${accessCode || 'Not generated'}</strong></td></tr>
        </table>
        <p style="margin-top: 20px; color: #666; font-size: 13px;">Remember to block these dates on Airbnb to avoid double bookings.</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: process.env.SMTP_USER, // Send to yourself
        subject: `🏠 New booking: ${customerName} — ${checkin} to ${checkout}`,
        html,
    });

    console.log(`📧 Host notification sent`);
}

// ═══════════════════════════════════════════════════════════
// 6. iCAL EXPORT — So Airbnb can import your direct bookings
// ═══════════════════════════════════════════════════════════

app.get('/api/calendar.ics', (req, res) => {
    const confirmedBookings = bookings.filter(b => b.status === 'confirmed');

    let ical = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//The Nest on Tennyson//Direct Bookings//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:The Nest on Tennyson - Direct Bookings',
    ];

    for (const booking of confirmedBookings) {
        const dtstart = booking.checkin.replace(/-/g, '');
        const dtend = booking.checkout.replace(/-/g, '');
        const uid = `${booking.id}@thenestontennyson.co.nz`;
        const created = new Date(booking.createdAt).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        ical.push(
            'BEGIN:VEVENT',
            `DTSTART;VALUE=DATE:${dtstart}`,
            `DTEND;VALUE=DATE:${dtend}`,
            `UID:${uid}`,
            `DTSTAMP:${created}`,
            `SUMMARY:Reserved - Direct Booking`,
            `DESCRIPTION:Guest: ${booking.customerName} (${booking.guests} guests)`,
            `STATUS:CONFIRMED`,
            'END:VEVENT'
        );
    }

    ical.push('END:VCALENDAR');

    res.set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="nest-on-tennyson.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.send(ical.join('\r\n'));
});

// ═══════════════════════════════════════════════════════════
// 7. ADMIN — View bookings (basic)
// ═══════════════════════════════════════════════════════════

app.get('/api/bookings', (req, res) => {
    // In production, add authentication here
    res.json(bookings);
});

// ═══════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║   The Nest on Tennyson — Booking Server    ║
║   Running on http://localhost:${PORT}          ║
╚════════════════════════════════════════════╝
    `);

    // Startup checks
    if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set');
    if (!process.env.AIRBNB_ICAL_URL) console.warn('⚠️  AIRBNB_ICAL_URL not set — calendar sync disabled');
    if (!process.env.SEAM_API_KEY) console.warn('⚠️  SEAM_API_KEY not set — using manual lock codes');
    if (!process.env.SMTP_USER) console.warn('⚠️  SMTP not configured — emails disabled');
});
