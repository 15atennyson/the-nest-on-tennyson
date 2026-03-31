/**
 * The Nest on Tennyson — Booking Server
 *
 * Handles:
 * 1. Stripe Checkout for payments
 * 2. Airbnb iCal sync to prevent double bookings
 * 3. Yale smart lock code generation (via Seam API)
 * 4. Guest email notifications (confirmation, pre-arrival, welcome, post-stay)
 * 5. Webhook processing for confirmed payments
 * 6. Scheduled email automation (cron)
 * 7. Digital guidebook serving
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────
const PRICING_TIERS = [
    { minNights: 28, rate: 190, label: 'Monthly rate' },
    { minNights: 14, rate: 210, label: 'Fortnightly rate' },
    { minNights: 7,  rate: 230, label: 'Weekly rate' },
    { minNights: 2,  rate: 250, label: 'Standard rate' },
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
        bookings: bookings.length,
        scheduledEmails: scheduledEmails.length,
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

// ─── In-Memory Stores ──────────────────────────────────
// In production, use a database (e.g., PostgreSQL, SQLite)
const bookings = [];
const scheduledEmails = [];

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

        if (nights < 2) {
            return res.status(400).json({ error: 'Minimum stay is 2 nights' });
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
// API: Fetch booking details (for confirmation page)
// ═══════════════════════════════════════════════════════════

app.get('/api/booking/:sessionId', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
        if (!session || session.payment_status !== 'paid') {
            return res.status(404).json({ error: 'Booking not found' });
        }

        const { checkin, checkout, guests, nights } = session.metadata;
        const pricing = getAllInRate(parseInt(nights), parseInt(guests));

        res.json({
            name: session.customer_details.name,
            email: session.customer_details.email,
            checkin,
            checkout,
            guests: parseInt(guests),
            nights: parseInt(nights),
            total: (session.amount_total / 100).toFixed(2),
            ratePerNight: pricing.allInRate,
            tierLabel: pricing.tier.label,
            guideUrl: `${SITE_URL}/guide.html`,
        });
    } catch (err) {
        console.error('Error fetching booking:', err);
        res.status(500).json({ error: 'Could not retrieve booking details' });
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
        emailsSent: [],
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

    // Send confirmation email (immediate)
    try {
        await sendGuestConfirmation(booking);
        booking.emailsSent.push({ type: 'confirmation', sentAt: new Date().toISOString() });
        await sendHostNotification(booking);
    } catch (err) {
        console.error('Failed to send emails:', err.message);
    }

    // Schedule future emails
    scheduleGuestEmails(booking);
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
    });

    console.log(`🔐 Lock code created: ${accessCode.code} (active ${checkin} 3PM - ${checkout} 10AM)`);
    return accessCode.code;
}

// ═══════════════════════════════════════════════════════════
// 5. EMAIL TEMPLATES — Beautiful, branded guest communications
// ═══════════════════════════════════════════════════════════

function emailLayout(content, preheader = '') {
    return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin: 0; padding: 0; background: #FAFAF8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>` : ''}
        <div style="max-width: 600px; margin: 0 auto; background: white;">
            <!-- Header -->
            <div style="padding: 32px 32px 24px; text-align: center; border-bottom: 1px solid #E5E5E0;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 400; font-family: Georgia, 'Times New Roman', serif; color: #1A1A1A;">The Nest on Tennyson</h1>
                <p style="margin: 4px 0 0; font-size: 13px; color: #6B6B6B;">Petone, Wellington</p>
            </div>
            <!-- Body -->
            <div style="padding: 32px;">
                ${content}
            </div>
            <!-- Footer -->
            <div style="padding: 24px 32px; text-align: center; border-top: 1px solid #E5E5E0; background: #FAFAF8;">
                <p style="margin: 0; font-size: 13px; color: #6B6B6B;">The Nest on Tennyson · Tennyson Street, Petone, Wellington</p>
                <p style="margin: 6px 0 0; font-size: 12px; color: #999;">
                    <a href="${SITE_URL}" style="color: #2C5F4B; text-decoration: none;">Website</a>
                    &nbsp;·&nbsp;
                    <a href="${SITE_URL}/guide.html" style="color: #2C5F4B; text-decoration: none;">Guest Guide</a>
                </p>
            </div>
        </div>
    </body>
    </html>`;
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-NZ', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
}

function firstName(fullName) {
    return fullName ? fullName.split(' ')[0] : 'there';
}

// ─── Email 1: Booking Confirmation (sent immediately) ──────
async function sendGuestConfirmation(booking) {
    const { customerName, customerEmail, checkin, checkout, nights, guests, amountPaid, accessCode } = booking;

    const accessCodeBlock = accessCode
        ? `<div style="background: #E8F0EC; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
                <p style="margin: 0 0 8px; color: #6B6B6B; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Your Door Access Code</p>
                <p style="margin: 0; font-size: 36px; font-weight: 700; color: #2C5F4B; letter-spacing: 8px;">${accessCode}</p>
                <p style="margin: 8px 0 0; color: #6B6B6B; font-size: 13px;">Active from 3:00 PM on check-in to 10:00 AM on checkout</p>
           </div>`
        : `<div style="background: #FFF8E1; border-radius: 12px; padding: 20px; margin: 24px 0; text-align: center;">
                <p style="margin: 0; color: #6B6B6B; font-size: 14px;">Your access code will be sent in a follow-up email before check-in.</p>
           </div>`;

    const content = `
        <h2 style="margin: 0 0 16px; font-size: 22px; color: #1A1A1A;">Booking confirmed!</h2>
        <p style="color: #444; line-height: 1.6;">Hi ${firstName(customerName)},</p>
        <p style="color: #444; line-height: 1.6;">Great news — your stay at The Nest on Tennyson is locked in. Here are your booking details:</p>

        <div style="background: #FAFAF8; border: 1px solid #E5E5E0; border-radius: 12px; padding: 24px; margin: 24px 0;">
            <table style="width: 100%; border-collapse: collapse;">
                <tr>
                    <td style="padding: 10px 0; color: #6B6B6B; font-size: 14px;">Check-in</td>
                    <td style="padding: 10px 0; text-align: right; font-weight: 600; font-size: 14px;">${formatDate(checkin)} from 3:00 PM</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #6B6B6B; font-size: 14px;">Checkout</td>
                    <td style="padding: 10px 0; text-align: right; font-weight: 600; font-size: 14px;">${formatDate(checkout)} by 10:00 AM</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #6B6B6B; font-size: 14px;">Duration</td>
                    <td style="padding: 10px 0; text-align: right; font-weight: 600; font-size: 14px;">${nights} night${nights > 1 ? 's' : ''}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #6B6B6B; font-size: 14px;">Guests</td>
                    <td style="padding: 10px 0; text-align: right; font-weight: 600; font-size: 14px;">${guests}</td>
                </tr>
                <tr style="border-top: 2px solid #E5E5E0;">
                    <td style="padding: 14px 0 0; font-weight: 700; font-size: 15px;">Total paid</td>
                    <td style="padding: 14px 0 0; text-align: right; font-weight: 700; font-size: 18px; color: #2C5F4B;">$${amountPaid} NZD</td>
                </tr>
            </table>
        </div>

        ${accessCodeBlock}

        <div style="text-align: center; margin: 32px 0 24px;">
            <a href="${SITE_URL}/guide.html" style="display: inline-block; background: #2C5F4B; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">View Your Guest Guide</a>
            <p style="margin: 10px 0 0; font-size: 13px; color: #6B6B6B;">WiFi, check-in instructions, local tips & more</p>
        </div>

        <h3 style="margin: 32px 0 8px; font-size: 15px; color: #1A1A1A;">What happens next?</h3>
        <table style="width: 100%;">
            <tr><td style="padding: 8px 12px 8px 0; color: #2C5F4B; font-weight: 700; vertical-align: top; width: 24px;">1</td><td style="padding: 8px 0; color: #444; font-size: 14px;">Save your access code (above) — you'll need it to unlock the front door</td></tr>
            <tr><td style="padding: 8px 12px 8px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">2</td><td style="padding: 8px 0; color: #444; font-size: 14px;">We'll send you a reminder with check-in details 3 days before your stay</td></tr>
            <tr><td style="padding: 8px 12px 8px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">3</td><td style="padding: 8px 0; color: #444; font-size: 14px;">Arrive from 3:00 PM, enter your code, and make yourself at home</td></tr>
        </table>

        <p style="margin-top: 28px; color: #444; line-height: 1.6;">Questions before your stay? Just reply to this email — I'm happy to help with restaurant recommendations, transport tips, or anything else.</p>
        <p style="color: #444;">Looking forward to hosting you!</p>
        <p style="margin-top: 4px;"><strong>James</strong><br><span style="color: #6B6B6B; font-size: 13px;">Your host at The Nest on Tennyson</span></p>
    `;

    await transporter.sendMail({
        from: `"The Nest on Tennyson" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: `Booking confirmed — The Nest on Tennyson (${formatDate(checkin)})`,
        html: emailLayout(content, `Your stay at The Nest on Tennyson is confirmed! ${formatDate(checkin)} — ${formatDate(checkout)}`),
    });

    console.log(`📧 Confirmation email sent to ${customerEmail}`);
}

// ─── Email 2: Pre-arrival (3 days before check-in) ────────
async function sendPreArrivalEmail(booking) {
    const { customerName, customerEmail, checkin, checkout, accessCode } = booking;

    const content = `
        <h2 style="margin: 0 0 16px; font-size: 22px; color: #1A1A1A;">Your stay is almost here!</h2>
        <p style="color: #444; line-height: 1.6;">Hi ${firstName(customerName)},</p>
        <p style="color: #444; line-height: 1.6;">Just a quick note to say we're looking forward to welcoming you to The Nest in a few days. Here's everything you need for a smooth arrival.</p>

        <div style="background: #E8F0EC; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="margin: 0 0 8px; color: #6B6B6B; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Your Door Access Code</p>
            <p style="margin: 0; font-size: 36px; font-weight: 700; color: #2C5F4B; letter-spacing: 8px;">${accessCode || '—'}</p>
        </div>

        <div style="background: #FAFAF8; border: 1px solid #E5E5E0; border-radius: 12px; padding: 24px; margin: 24px 0;">
            <h3 style="margin: 0 0 16px; font-size: 15px;">Quick Check-in Recap</h3>
            <table style="width: 100%; font-size: 14px;">
                <tr><td style="padding: 6px 0; color: #6B6B6B;">Check-in</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${formatDate(checkin)} from 3:00 PM</td></tr>
                <tr><td style="padding: 6px 0; color: #6B6B6B;">Checkout</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${formatDate(checkout)} by 10:00 AM</td></tr>
                <tr><td style="padding: 6px 0; color: #6B6B6B;">Address</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">Tennyson Street, Petone</td></tr>
                <tr><td style="padding: 6px 0; color: #6B6B6B;">Parking</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">Free — driveway + street</td></tr>
            </table>
        </div>

        <h3 style="margin: 24px 0 8px; font-size: 15px;">Getting There</h3>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">The property is on Tennyson Street in Petone, Lower Hutt. Park in the driveway (left-hand side) or on the street. Walk up to the front door and enter your access code on the Yale keypad.</p>

        <div style="text-align: center; margin: 28px 0 16px;">
            <a href="${SITE_URL}/guide.html" style="display: inline-block; background: #2C5F4B; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Open Guest Guide</a>
            <p style="margin: 10px 0 0; font-size: 13px; color: #6B6B6B;">WiFi password, appliance tips, local recommendations</p>
        </div>

        <h3 style="margin: 24px 0 8px; font-size: 15px;">Local Tips for Your Arrival</h3>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">If you're arriving in the evening and want to grab dinner, <strong>Boneface Brewing</strong> and <strong>Salty Pidgin</strong> are both within walking distance. For a quick bite, <strong>Pickle & Pie</strong> on Jackson Street is excellent. More recommendations are in your guest guide.</p>

        <p style="margin-top: 28px; color: #444; line-height: 1.6;">See you soon! Reply to this email if you need anything at all.</p>
        <p><strong>James</strong></p>
    `;

    await transporter.sendMail({
        from: `"The Nest on Tennyson" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: `Your stay is almost here — check-in details for ${formatDate(checkin)}`,
        html: emailLayout(content, `Arriving soon! Here's everything you need for check-in at The Nest on Tennyson.`),
    });

    console.log(`📧 Pre-arrival email sent to ${customerEmail}`);
}

// ─── Email 3: Welcome (morning of check-in) ───────────────
async function sendWelcomeEmail(booking) {
    const { customerName, customerEmail, accessCode } = booking;

    const content = `
        <h2 style="margin: 0 0 16px; font-size: 22px; color: #1A1A1A;">Welcome to Petone!</h2>
        <p style="color: #444; line-height: 1.6;">Hi ${firstName(customerName)},</p>
        <p style="color: #444; line-height: 1.6;">Today's the day! The Nest is all ready for you.</p>

        <div style="background: #E8F0EC; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="margin: 0 0 4px; color: #6B6B6B; font-size: 13px;">Check-in from</p>
            <p style="margin: 0; font-size: 28px; font-weight: 700; color: #2C5F4B;">3:00 PM</p>
            ${accessCode ? `<p style="margin: 12px 0 0; font-size: 13px; color: #6B6B6B;">Door code: <strong style="color: #2C5F4B; letter-spacing: 4px; font-size: 18px;">${accessCode}</strong></p>` : ''}
        </div>

        <h3 style="margin: 24px 0 8px; font-size: 15px;">A Few Reminders</h3>
        <table style="width: 100%; font-size: 14px;">
            <tr><td style="padding: 6px 8px 6px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">→</td><td style="padding: 6px 0; color: #444;">Park in the driveway or on Tennyson Street (free parking)</td></tr>
            <tr><td style="padding: 6px 8px 6px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">→</td><td style="padding: 6px 0; color: #444;">Enter your code on the Yale keypad at the front door</td></tr>
            <tr><td style="padding: 6px 8px 6px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">→</td><td style="padding: 6px 0; color: #444;">WiFi: <strong>The Nest</strong> / Password: <strong>nestontennyson</strong></td></tr>
            <tr><td style="padding: 6px 8px 6px 0; color: #2C5F4B; font-weight: 700; vertical-align: top;">→</td><td style="padding: 6px 0; color: #444;">Tea, coffee, milk, and a few treats are waiting for you</td></tr>
        </table>

        <p style="margin-top: 24px; color: #444; line-height: 1.6;">If you run into any issues at all, don't hesitate to reply to this email or text James. Enjoy your stay!</p>
        <p><strong>James</strong></p>
    `;

    await transporter.sendMail({
        from: `"The Nest on Tennyson" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: `Welcome! The Nest is ready for you today`,
        html: emailLayout(content, `The Nest on Tennyson is ready for your arrival today. Here's your check-in info.`),
    });

    console.log(`📧 Welcome email sent to ${customerEmail}`);
}

// ─── Email 4: Post-stay (day after checkout) ──────────────
async function sendPostStayEmail(booking) {
    const { customerName, customerEmail, nights } = booking;

    const content = `
        <h2 style="margin: 0 0 16px; font-size: 22px; color: #1A1A1A;">Thanks for staying with us!</h2>
        <p style="color: #444; line-height: 1.6;">Hi ${firstName(customerName)},</p>
        <p style="color: #444; line-height: 1.6;">I hope you had a wonderful ${nights}-night stay at The Nest. It was a pleasure hosting you.</p>

        <div style="background: #FAFAF8; border: 1px solid #E5E5E0; border-radius: 12px; padding: 28px; margin: 24px 0; text-align: center;">
            <p style="margin: 0 0 8px; font-size: 15px; color: #1A1A1A; font-weight: 600;">How was your stay?</p>
            <p style="margin: 0 0 20px; font-size: 14px; color: #6B6B6B;">Your feedback means a lot — it helps future guests and helps us improve.</p>
            <a href="https://g.page/r/review" style="display: inline-block; background: #2C5F4B; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Leave a Review</a>
        </div>

        <div style="background: #F5F0EB; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="margin: 0 0 6px; font-size: 15px; font-weight: 600; color: #1A1A1A;">Come back and save</p>
            <p style="margin: 0 0 12px; font-size: 14px; color: #6B6B6B;">Book direct next time for the best rates — no Airbnb fees, no middleman.</p>
            <a href="${SITE_URL}" style="display: inline-block; background: #1A1A1A; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Book Direct →</a>
        </div>

        <p style="color: #444; line-height: 1.6;">Thanks again, ${firstName(customerName)}. I hope to welcome you back to Petone soon.</p>
        <p><strong>James</strong><br><span style="color: #6B6B6B; font-size: 13px;">Your host at The Nest on Tennyson</span></p>
    `;

    await transporter.sendMail({
        from: `"The Nest on Tennyson" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        replyTo: process.env.SMTP_USER,
        to: customerEmail,
        subject: `Thanks for staying at The Nest, ${firstName(customerName)}!`,
        html: emailLayout(content, `We hope you had a wonderful stay. We'd love to hear how it went!`),
    });

    console.log(`📧 Post-stay email sent to ${customerEmail}`);
}

// ─── Host Notification ─────────────────────────────────────
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
        <p style="margin-top: 16px; color: #666; font-size: 13px;">Scheduled emails: confirmation (sent), pre-arrival (3 days before), welcome (check-in morning), post-stay (day after checkout)</p>
        <p style="margin-top: 8px; color: #666; font-size: 13px;">Remember to block these dates on Airbnb to avoid double bookings.</p>
    </div>`;

    await transporter.sendMail({
        from: `"The Nest Bookings" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        to: process.env.SMTP_USER, // Send to yourself
        subject: `🏠 New booking: ${customerName} — ${checkin} to ${checkout}`,
        html,
    });

    console.log(`📧 Host notification sent`);
}

// ═══════════════════════════════════════════════════════════
// 6. SCHEDULED EMAILS — Cron-based email automation
// ═══════════════════════════════════════════════════════════

function scheduleGuestEmails(booking) {
    const { checkin, checkout, id } = booking;
    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);

    // Pre-arrival: 3 days before check-in at 10 AM NZST
    const preArrival = new Date(checkinDate);
    preArrival.setDate(preArrival.getDate() - 3);
    preArrival.setHours(10, 0, 0, 0);

    // Welcome: morning of check-in at 9 AM NZST
    const welcome = new Date(checkinDate);
    welcome.setHours(9, 0, 0, 0);

    // Post-stay: day after checkout at 11 AM NZST
    const postStay = new Date(checkoutDate);
    postStay.setDate(postStay.getDate() + 1);
    postStay.setHours(11, 0, 0, 0);

    const now = new Date();

    // Only schedule if in the future
    if (preArrival > now) {
        scheduledEmails.push({
            bookingId: id,
            type: 'pre-arrival',
            sendAt: preArrival.toISOString(),
            sent: false,
        });
        console.log(`📅 Pre-arrival email scheduled for ${preArrival.toISOString()}`);
    }

    if (welcome > now) {
        scheduledEmails.push({
            bookingId: id,
            type: 'welcome',
            sendAt: welcome.toISOString(),
            sent: false,
        });
        console.log(`📅 Welcome email scheduled for ${welcome.toISOString()}`);
    }

    if (postStay > now) {
        scheduledEmails.push({
            bookingId: id,
            type: 'post-stay',
            sendAt: postStay.toISOString(),
            sent: false,
        });
        console.log(`📅 Post-stay email scheduled for ${postStay.toISOString()}`);
    }
}

// Check every 5 minutes for emails that need to be sent
cron.schedule('*/5 * * * *', async () => {
    const now = new Date();
    const pending = scheduledEmails.filter(e => !e.sent && new Date(e.sendAt) <= now);

    for (const email of pending) {
        const booking = bookings.find(b => b.id === email.bookingId);
        if (!booking || booking.status !== 'confirmed') {
            email.sent = true; // Skip cancelled bookings
            continue;
        }

        try {
            switch (email.type) {
                case 'pre-arrival':
                    await sendPreArrivalEmail(booking);
                    break;
                case 'welcome':
                    await sendWelcomeEmail(booking);
                    break;
                case 'post-stay':
                    await sendPostStayEmail(booking);
                    break;
            }
            email.sent = true;
            booking.emailsSent.push({ type: email.type, sentAt: new Date().toISOString() });
            console.log(`✅ Scheduled ${email.type} email sent for booking ${email.bookingId}`);
        } catch (err) {
            console.error(`❌ Failed to send ${email.type} email for booking ${email.bookingId}:`, err.message);
        }
    }
});

// ═══════════════════════════════════════════════════════════
// 7. iCAL EXPORT — So Airbnb can import your direct bookings
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
// 8. ADMIN — View bookings & scheduled emails
// ═══════════════════════════════════════════════════════════

app.get('/api/bookings', (req, res) => {
    // In production, add authentication here
    res.json(bookings);
});

app.get('/api/scheduled-emails', (req, res) => {
    // In production, add authentication here
    res.json(scheduledEmails);
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
    console.log('📅 Email scheduler active (checking every 5 minutes)');
});
