require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── Supabase admin client (service_role key — NEVER expose this to frontend) ───
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Gmail transporter ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,   // Gmail App Password (not your login password)
    },
});

// ─── In-memory stores ─────────────────────────────────────────────────────────
// otpStore    : pending OTPs waiting to be verified
// verifiedStore: emails that passed OTP (used by /reset-password before password is set)
const otpStore      = new Map(); // email → { otp, expiry, purpose }
const verifiedStore = new Map(); // email → expiry  (only for reset flow)

const OTP_EXPIRY_MS      = 10 * 60 * 1000;  // 10 minutes
const VERIFIED_EXPIRY_MS = 15 * 60 * 1000;  // 15 minutes to submit new password

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function buildEmailHTML(otp, purpose) {
    const heading = purpose === 'reset' ? 'Password Reset Code' : 'Email Verification Code';
    const note    = purpose === 'reset'
        ? 'Use this code to reset your Exertia password.'
        : 'Use this code to verify your email and complete registration.';
    return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;
                background:#0a0a1a;color:#fff;padding:32px;border-radius:16px;
                border:1px solid #00f5a0;">
      <h2 style="color:#00f5a0;text-align:center;letter-spacing:4px;margin-bottom:4px;">
        EXERTIA
      </h2>
      <p style="text-align:center;color:#aaa;font-size:13px;margin-top:0;">
        The Fitness Game
      </p>
      <p style="font-size:16px;text-align:center;margin:24px 0 8px;">${heading}</p>
      <p style="font-size:13px;text-align:center;color:#ccc;">${note}</p>
      <div style="background:#1a1a2e;border-radius:12px;padding:28px;
                  text-align:center;margin:24px 0;border:1px solid #00f5a020;">
        <h1 style="letter-spacing:20px;color:#00f5a0;font-size:44px;margin:0;
                   font-family:monospace;">
          ${otp}
        </h1>
      </div>
      <p style="color:#888;font-size:12px;text-align:center;">
        This code expires in <strong style="color:#fff;">10 minutes</strong>.
        Do not share it with anyone.
      </p>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /send-otp
// Body: { email: string, purpose: "register" | "reset" }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/send-otp', async (req, res) => {
    const { email, purpose } = req.body;

    if (!email || !['register', 'reset'].includes(purpose)) {
        return res.status(400).json({
            success: false,
            message: 'email and purpose ("register" or "reset") are required.'
        });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const otp    = generateOTP();
    const expiry = Date.now() + OTP_EXPIRY_MS;

    otpStore.set(normalizedEmail, { otp, expiry, purpose });

    const subject = purpose === 'reset'
        ? 'Exertia — Reset Your Password'
        : 'Exertia — Verify Your Email';

    try {
        await transporter.sendMail({
            from   : `"Exertia" <${process.env.GMAIL_USER}>`,
            to     : email,
            subject: subject,
            html   : buildEmailHTML(otp, purpose),
        });

        console.log(`[SEND-OTP] ✉️  Sent to ${normalizedEmail} (purpose: ${purpose})`);
        return res.json({ success: true });
    } catch (err) {
        console.error('[SEND-OTP] ❌ Email failed:', err.message);
        otpStore.delete(normalizedEmail);
        return res.status(500).json({ success: false, message: 'Failed to send email. Check Gmail credentials.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify-otp
// Body: { email: string, otp: string }
//
// For "register" purpose → OTP is consumed (deleted). Frontend then calls Supabase signUp.
// For "reset" purpose   → OTP is consumed, email moves to verifiedStore.
//                          Frontend then calls /reset-password (no OTP needed).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-otp', (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ valid: false, message: 'email and otp are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const record = otpStore.get(normalizedEmail);

    if (!record) {
        return res.json({ valid: false, message: 'No pending OTP for this email. Please request a new code.' });
    }

    if (Date.now() > record.expiry) {
        otpStore.delete(normalizedEmail);
        return res.json({ valid: false, message: 'OTP has expired. Please request a new code.' });
    }

    if (record.otp !== otp.trim()) {
        return res.json({ valid: false, message: 'Incorrect code. Please try again.' });
    }

    // ── OTP is valid ──
    otpStore.delete(normalizedEmail);

    if (record.purpose === 'reset') {
        // Grant a short-lived "verified" window so /reset-password can proceed
        verifiedStore.set(normalizedEmail, Date.now() + VERIFIED_EXPIRY_MS);
        console.log(`[VERIFY-OTP] ✅ Verified for ${normalizedEmail} (reset — added to verifiedStore)`);
    } else {
        console.log(`[VERIFY-OTP] ✅ Verified for ${normalizedEmail} (register)`);
    }

    return res.json({ valid: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /reset-password
// Body: { email: string, newPassword: string }
//
// Requires /verify-otp to have been called first (email must be in verifiedStore).
// Uses Supabase Admin API to update the password — service_role key stays server-side.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/reset-password', async (req, res) => {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
        return res.status(400).json({ success: false, message: 'email and newPassword are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Check verifiedStore ──
    const expiry = verifiedStore.get(normalizedEmail);
    if (!expiry) {
        return res.json({ success: false, message: 'OTP not verified. Please complete OTP verification first.' });
    }
    if (Date.now() > expiry) {
        verifiedStore.delete(normalizedEmail);
        return res.json({ success: false, message: 'Verification session expired. Please start over.' });
    }

    if (newPassword.length < 6) {
        return res.json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    try {
        // Look up user ID from public.users table (id == auth.users id)
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id')
            .eq('email', normalizedEmail)
            .single();

        if (userError || !userData) {
            console.error('[RESET] User lookup failed:', userError?.message);
            return res.json({ success: false, message: 'No account found with this email.' });
        }

        // Update password via Supabase Auth Admin API
        const { error: updateError } = await supabase.auth.admin.updateUserById(
            userData.id,
            { password: newPassword }
        );

        if (updateError) throw updateError;

        verifiedStore.delete(normalizedEmail);
        console.log(`[RESET] ✅ Password updated for ${normalizedEmail}`);
        return res.json({ success: true });

    } catch (err) {
        console.error('[RESET] ❌ Password update failed:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to update password. Please try again.' });
    }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', server: 'Exertia Mail Server' }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✉️  Exertia Mail Server running on port ${PORT}`);
    console.log(`   Gmail user : ${process.env.GMAIL_USER ?? '⚠️  NOT SET'}`);
    console.log(`   Supabase   : ${process.env.SUPABASE_URL ? '✅ configured' : '⚠️  NOT SET'}\n`);
});
