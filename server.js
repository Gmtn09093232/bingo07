/* ============================================================
 *  HEARTHSIDE — server.js
 *  Node.js + Express API on top of Supabase
 * ============================================================
 *  Run:  npm install && npm run dev
 * ============================================================ */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

/* ------------------------------------------------------------
 * 0. CONFIG
 * ---------------------------------------------------------- */
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEBIRR_API_KEY,
  TELEBIRR_MERCHANT_ID,
  PORT = 3000,
  FREE_DAILY_LIKES = '8',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '\n[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
    'Copy .env.example to .env and fill in your Supabase credentials.\n'
  );
  process.exit(1);
}

const FREE_LIKE_LIMIT = parseInt(FREE_DAILY_LIKES, 10) || 8;

const PLANS = {
  monthly: { amount_etb: 450, days: 30, label: 'Member+ Monthly' },
  yearly:  { amount_etb: 4500, days: 365, label: 'Member+ Yearly' },
};

const app = express();

/* ------------------------------------------------------------
 * 1. MIDDLEWARE
 * ---------------------------------------------------------- */

// CORS — tighten `origin` in production
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));

// Tele Birr webhook needs the raw body for signature verification,
// so it must be mounted BEFORE express.json().
app.use(
  '/api/payments/telebirr/webhook',
  express.raw({ type: '*/*', limit: '1mb' })
);

app.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------------
 * Public config for the browser.
 * Exposes only SUPABASE_URL and the ANON key (both safe to
 * expose — RLS protects the data). NEVER send the service key.
 * ---------------------------------------------------------- */
app.get('/config.js', (_req, res) => {
  const url = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';

  if (!url || !anon) {
    console.error('[config.js] SUPABASE_URL or SUPABASE_ANON_KEY is missing');
  }

  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(
    `window.SUPABASE_URL = ${JSON.stringify(url)};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(anon)};\n` +
    `window.HEARTHSIDE_API = '';\n`
  );
});

// ---- Static frontend ----
// Serves public/index.html at "/" and any assets under public/
app.use(express.static(path.join(__dirname, '')));

/* ------------------------------------------------------------
 * 2. SUPABASE CLIENTS
 * ---------------------------------------------------------- */

// Admin client — bypasses RLS. NEVER expose this key to the browser.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Build a client that acts *as* the requesting user so that
// Postgres functions using auth.uid() (e.g. get_nearby_profiles) work.
function supabaseAsUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/* ------------------------------------------------------------
 * 3. HELPERS
 * ---------------------------------------------------------- */

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) {
    return null;
  }
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function formatDistance(km) {
  if (km === null || km === undefined) return null;
  if (km < 1) return 'less than 1 km away';
  return `${Math.round(km)} km away`;
}

function isNewDay(lastReset) {
  if (!lastReset) return true;
  const a = new Date(lastReset);
  const b = new Date();
  return (
    a.getUTCFullYear() !== b.getUTCFullYear() ||
    a.getUTCMonth() !== b.getUTCMonth() ||
    a.getUTCDate() !== b.getUTCDate()
  );
}

function sortPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

/* ------------------------------------------------------------
 * 4. AUTH MIDDLEWARE
 * ---------------------------------------------------------- */

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data: profile, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (pErr) throw pErr;

    req.token = token;
    req.user = data.user;
    req.profile = profile || null;
    next();
  } catch (err) {
    console.error('[requireAuth]', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

async function refreshDailyLikes(profile) {
  if (!profile) return profile;
  if (isNewDay(profile.last_like_reset)) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .update({ daily_likes_used: 0, last_like_reset: new Date().toISOString() })
      .eq('id', profile.id)
      .select('*')
      .single();
    return data || { ...profile, daily_likes_used: 0 };
  }
  return profile;
}

/* ============================================================
 * 5. ROUTES
 * ============================================================ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'hearthside-api', time: new Date().toISOString() });
});

/* ------------------------------------------------------------
 * GET /api/discover
 * ---------------------------------------------------------- */
app.get('/api/discover', requireAuth, async (req, res) => {
  try {
    const me = await refreshDailyLikes(req.profile);
    if (!me) return res.status(404).json({ error: 'Profile not found' });

    const lat = parseFloat(req.query.lat ?? me.latitude);
    const lng = parseFloat(req.query.lng ?? me.longitude);
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const maxKm = parseFloat(req.query.max_km) || 100;

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        error: 'Location required. Send ?lat=&lng= or set latitude/longitude on your profile.',
      });
    }

    const userClient = supabaseAsUser(req.token);
    const { data, error } = await userClient.rpc('get_nearby_profiles', {
      p_lat: lat,
      p_lng: lng,
      p_limit: limit,
      p_max_km: maxKm,
    });

    if (error) throw error;

    const profiles = (data || []).map((p) => ({
      ...p,
      distance_km: p.distance_km !== null ? Number(p.distance_km.toFixed(2)) : null,
      distance_label: formatDistance(p.distance_km),
    }));

    res.json({
      profiles,
      likes: {
        used: me.daily_likes_used,
        limit: me.is_premium ? null : FREE_LIKE_LIMIT,
        remaining: me.is_premium
          ? null
          : Math.max(0, FREE_LIKE_LIMIT - me.daily_likes_used),
        is_premium: me.is_premium,
      },
    });
  } catch (err) {
    console.error('[GET /api/discover]', err);
    res.status(500).json({ error: 'Failed to load discovery feed' });
  }
});

/* ------------------------------------------------------------
 * POST /api/likes
 * ---------------------------------------------------------- */
app.post('/api/likes', requireAuth, async (req, res) => {
  try {
    const { likee_id, is_like = true } = req.body || {};
    const me = await refreshDailyLikes(req.profile);

    if (!me) return res.status(404).json({ error: 'Profile not found' });
    if (!likee_id) return res.status(400).json({ error: 'likee_id is required' });
    if (likee_id === me.id) {
      return res.status(400).json({ error: 'You cannot like yourself' });
    }

    if (is_like === true && !me.is_premium) {
      if (me.daily_likes_used >= FREE_LIKE_LIMIT) {
        return res.status(429).json({
          error: 'Daily like limit reached',
          code: 'LIKE_LIMIT_REACHED',
          likes: {
            used: me.daily_likes_used,
            limit: FREE_LIKE_LIMIT,
            remaining: 0,
            is_premium: false,
          },
        });
      }
    }

    const { data: likeRow, error: likeErr } = await supabaseAdmin
      .from('likes')
      .upsert(
        { liker_id: me.id, likee_id, is_like },
        { onConflict: 'liker_id,likee_id' }
      )
      .select('*')
      .single();

    if (likeErr) throw likeErr;

    let updatedProfile = me;
    if (is_like === true) {
      const { data } = await supabaseAdmin
        .from('profiles')
        .update({ daily_likes_used: me.daily_likes_used + 1 })
        .eq('id', me.id)
        .select('*')
        .single();
      if (data) updatedProfile = data;
    }

    const likesMeta = {
      used: updatedProfile.daily_likes_used,
      limit: updatedProfile.is_premium ? null : FREE_LIKE_LIMIT,
      remaining: updatedProfile.is_premium
        ? null
        : Math.max(0, FREE_LIKE_LIMIT - updatedProfile.daily_likes_used),
      is_premium: updatedProfile.is_premium,
    };

    if (is_like !== true) {
      return res.json({ matched: false, like: likeRow, likes: likesMeta });
    }

    const { data: reciprocal, error: recErr } = await supabaseAdmin
      .from('likes')
      .select('id')
      .eq('liker_id', likee_id)
      .eq('likee_id', me.id)
      .eq('is_like', true)
      .maybeSingle();

    if (recErr) throw recErr;

    if (!reciprocal) {
      return res.json({ matched: false, like: likeRow, likes: likesMeta });
    }

    const [u1, u2] = sortPair(me.id, likee_id);

    const { data: existing } = await supabaseAdmin
      .from('matches')
      .select('*')
      .eq('user1_id', u1)
      .eq('user2_id', u2)
      .maybeSingle();

    let match = existing;

    if (!match) {
      const { data: created, error: mErr } = await supabaseAdmin
        .from('matches')
        .insert({ user1_id: u1, user2_id: u2 })
        .select('*')
        .single();
      if (mErr) throw mErr;
      match = created;
    }

    const { data: other } = await supabaseAdmin
      .from('profiles')
      .select('id, name, age, city, avatar_url, tags, bio')
      .eq('id', likee_id)
      .single();

    res.status(201).json({
      matched: true,
      match,
      partner: other,
      like: likeRow,
      likes: likesMeta,
    });
  } catch (err) {
    console.error('[POST /api/likes]', err);
    res.status(500).json({ error: 'Failed to record like' });
  }
});

/* ------------------------------------------------------------
 * GET /api/matches
 * ---------------------------------------------------------- */
app.get('/api/matches', requireAuth, async (req, res) => {
  try {
    const me = req.profile;
    if (!me) return res.status(404).json({ error: 'Profile not found' });

    const { data: rows, error } = await supabaseAdmin
      .from('matches')
      .select('*')
      .or(`user1_id.eq.${me.id},user2_id.eq.${me.id}`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!rows?.length) return res.json({ matches: [] });

    const partnerIds = rows.map((m) =>
      m.user1_id === me.id ? m.user2_id : m.user1_id
    );

    const { data: partners, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('id, name, age, city, avatar_url, bio, tags, is_premium')
      .in('id', partnerIds);
    if (pErr) throw pErr;

    const partnerMap = Object.fromEntries((partners || []).map((p) => [p.id, p]));

    const matchIds = rows.map((m) => m.id);
    const { data: msgs } = await supabaseAdmin
      .from('messages')
      .select('id, match_id, sender_id, content, media_url, is_read, created_at')
      .in('match_id', matchIds)
      .order('created_at', { ascending: false });

    const lastByMatch = {};
    const unreadByMatch = {};
    for (const m of msgs || []) {
      if (!lastByMatch[m.match_id]) lastByMatch[m.match_id] = m;
      if (m.sender_id !== me.id && !m.is_read) {
        unreadByMatch[m.match_id] = (unreadByMatch[m.match_id] || 0) + 1;
      }
    }

    const matches = rows
      .map((m) => {
        const partnerId = m.user1_id === me.id ? m.user2_id : m.user1_id;
        const partner = partnerMap[partnerId];
        if (!partner) return null;
        return {
          id: m.id,
          created_at: m.created_at,
          partner,
          last_message: lastByMatch[m.id] || null,
          unread_count: unreadByMatch[m.id] || 0,
        };
      })
      .filter(Boolean);

    res.json({ matches });
  } catch (err) {
    console.error('[GET /api/matches]', err);
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

/* ------------------------------------------------------------
 * GET /api/messages/:matchId
 * ---------------------------------------------------------- */
app.get('/api/messages/:matchId', requireAuth, async (req, res) => {
  try {
    const me = req.profile;
    const { matchId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const { data: match, error: mErr } = await supabaseAdmin
      .from('matches')
      .select('*')
      .eq('id', matchId)
      .maybeSingle();

    if (mErr) throw mErr;
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.user1_id !== me.id && match.user2_id !== me.id) {
      return res.status(403).json({ error: 'Not a participant of this match' });
    }

    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;

    await supabaseAdmin
      .from('messages')
      .update({ is_read: true })
      .eq('match_id', matchId)
      .neq('sender_id', me.id)
      .eq('is_read', false);

    const partnerId = match.user1_id === me.id ? match.user2_id : match.user1_id;
    const { data: partner } = await supabaseAdmin
      .from('profiles')
      .select('id, name, age, city, avatar_url, bio, tags')
      .eq('id', partnerId)
      .single();

    res.json({ match, partner, messages: messages || [] });
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

/* ------------------------------------------------------------
 * POST /api/messages
 * ---------------------------------------------------------- */
app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const me = req.profile;
    const { match_id, content = null, media_url = null } = req.body || {};

    if (!match_id) return res.status(400).json({ error: 'match_id is required' });
    if (!content && !media_url) {
      return res.status(400).json({ error: 'Provide content or media_url' });
    }

    const { data: match, error: mErr } = await supabaseAdmin
      .from('matches')
      .select('id, user1_id, user2_id')
      .eq('id', match_id)
      .maybeSingle();

    if (mErr) throw mErr;
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.user1_id !== me.id && match.user2_id !== me.id) {
      return res.status(403).json({ error: 'Not a participant of this match' });
    }

    const { data: message, error } = await supabaseAdmin
      .from('messages')
      .insert({
        match_id,
        sender_id: me.id,
        content: content ? String(content).slice(0, 4000) : null,
        media_url,
      })
      .select('*')
      .single();

    if (error) throw error;

    res.status(201).json({ message });
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/* ------------------------------------------------------------
 * GET /api/premium/likes
 * ---------------------------------------------------------- */
app.get('/api/premium/likes', requireAuth, async (req, res) => {
  try {
    const me = req.profile;
    if (!me) return res.status(404).json({ error: 'Profile not found' });

    const { data: rows, error } = await supabaseAdmin
      .from('likes')
      .select('id, liker_id, created_at')
      .eq('likee_id', me.id)
      .eq('is_like', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const likerIds = (rows || []).map((r) => r.liker_id);
    const total = likerIds.length;

    if (!likerIds.length) {
      return res.json({ is_premium: me.is_premium, total: 0, likes: [] });
    }

    const { data: myMatches } = await supabaseAdmin
      .from('matches')
      .select('user1_id, user2_id')
      .or(`user1_id.eq.${me.id},user2_id.eq.${me.id}`);

    const matchedIds = new Set(
      (myMatches || []).map((m) => (m.user1_id === me.id ? m.user2_id : m.user1_id))
    );

    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('id, name, age, city, avatar_url, bio, tags')
      .in('id', likerIds);
    if (pErr) throw pErr;

    const profileMap = Object.fromEntries((profiles || []).map((p) => [p.id, p]));

    if (me.is_premium) {
      const likes = rows
        .map((r) => {
          const p = profileMap[r.liker_id];
          if (!p) return null;
          return {
            like_id: r.id,
            liked_at: r.created_at,
            already_matched: matchedIds.has(r.liker_id),
            profile: p,
          };
        })
        .filter(Boolean);

      return res.json({ is_premium: true, total, likes });
    }

    const preview = rows.slice(0, 12).map((r) => {
      const p = profileMap[r.liker_id] || {};
      return {
        like_id: r.id,
        liked_at: r.created_at,
        locked: true,
        teaser: {
          first_name_initial: (p.name || '?').trim().charAt(0).toUpperCase(),
          age: p.age ?? null,
          city: p.city || null,
          avatar_url: p.avatar_url || null,
        },
      };
    });

    res.status(200).json({
      is_premium: false,
      total,
      likes: preview,
      upgrade: {
        code: 'PREMIUM_REQUIRED',
        message: 'Upgrade to Member+ to see everyone who liked you.',
        plans: PLANS,
      },
    });
  } catch (err) {
    console.error('[GET /api/premium/likes]', err);
    res.status(500).json({ error: 'Failed to load likes' });
  }
});

/* ------------------------------------------------------------
 * POST /api/payments/telebirr/initiate
 * ---------------------------------------------------------- */
app.post('/api/payments/telebirr/initiate', requireAuth, async (req, res) => {
  try {
    const me = req.profile;
    const { plan_type } = req.body || {};

    if (!PLANS[plan_type]) {
      return res.status(400).json({
        error: "plan_type must be 'monthly' or 'yearly'",
        plans: PLANS,
      });
    }

    const plan = PLANS[plan_type];
    const txnId = `HS-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const { data: subscription, error } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: me.id,
        plan_type,
        amount_etb: plan.amount_etb,
        status: 'pending',
        telebirr_txn_id: txnId,
      })
      .select('*')
      .single();

    if (error) throw error;

    if (!TELEBIRR_API_KEY) {
      console.warn('[telebirr] TELEBIRR_API_KEY not set — returning mock checkout.');
      return res.status(201).json({
        mode: 'mock',
        txn_id: txnId,
        subscription,
        plan: { plan_type, ...plan },
        checkout_url: `/paywall.html?mock_checkout=${txnId}`,
        message:
          'Tele Birr credentials are not configured. This is a simulated checkout.',
      });
    }

    const payload = {
      appId: TELEBIRR_MERCHANT_ID,
      outTradeNo: txnId,
      totalAmount: plan.amount_etb.toFixed(2),
      subject: plan.label,
      notifyUrl: `${process.env.PUBLIC_BASE_URL || ''}/api/payments/telebirr/webhook`,
      returnUrl: `${process.env.PUBLIC_BASE_URL || ''}/paywall.html?txn=${txnId}`,
      timeoutExpress: '30m',
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now().toString(),
    };

    const telebirrRes = await fetch(
      process.env.TELEBIRR_BASE_URL ||
        'https://api.ethiotelecom.et/tele-birr/payment/v1/order',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TELEBIRR_API_KEY}`,
        },
        body: JSON.stringify(payload),
      }
    );

    const telebirrData = await telebirrRes.json().catch(() => ({}));

    if (!telebirrRes.ok) {
      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'failed' })
        .eq('id', subscription.id);
      return res.status(502).json({
        error: 'Tele Birr order creation failed',
        detail: telebirrData,
      });
    }

    res.status(201).json({
      mode: 'live',
      txn_id: txnId,
      subscription,
      plan: { plan_type, ...plan },
      checkout_url: telebirrData?.data?.toPayUrl || telebirrData?.toPayUrl || null,
    });
  } catch (err) {
    console.error('[POST /api/payments/telebirr/initiate]', err);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

/* ------------------------------------------------------------
 * POST /api/payments/telebirr/webhook
 * ---------------------------------------------------------- */
app.post('/api/payments/telebirr/webhook', async (req, res) => {
  try {
    let body = {};
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    const signature = req.headers['x-telebirr-signature'] || body.sign;
    if (TELEBIRR_API_KEY && signature) {
      const expected = crypto
        .createHmac('sha256', TELEBIRR_API_KEY)
        .update(raw || JSON.stringify(body))
        .digest('hex');
      if (expected !== signature) {
        console.warn('[webhook] Signature mismatch — rejecting.');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const txnId =
      body.outTradeNo || body.txn_id || body.merchantOrderId || body.tradeNo;
    const rawStatus = String(body.status || body.tradeStatus || '').toLowerCase();

    if (!txnId) {
      return res.status(400).json({ error: 'Missing transaction reference' });
    }

    const succeeded = ['success', 'successful', 'paid', 'completed', '0000', '2'].includes(
      rawStatus
    );

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('telebirr_txn_id', txnId)
      .maybeSingle();

    if (subErr) throw subErr;
    if (!sub) {
      console.warn('[webhook] Unknown txn:', txnId);
      return res.status(404).json({ error: 'Unknown transaction' });
    }

    if (!succeeded) {
      await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'failed' })
        .eq('id', sub.id);
      return res.json({ received: true, status: 'failed' });
    }

    if (sub.status === 'active') {
      return res.json({ received: true, status: 'already_active' });
    }

    const plan = PLANS[sub.plan_type] || PLANS.monthly;
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + plan.days * 86400 * 1000);

    await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'active',
        started_at: startedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq('id', sub.id);

    await supabaseAdmin
      .from('profiles')
      .update({ is_premium: true, daily_likes_used: 0, last_like_reset: startedAt.toISOString() })
      .eq('id', sub.user_id);

    console.log(`[webhook] Member+ activated for ${sub.user_id} until ${expiresAt.toISOString()}`);

    res.json({ code: '0', message: 'success', received: true });
  } catch (err) {
    console.error('[POST /api/payments/telebirr/webhook]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/* ------------------------------------------------------------
 * DEV-ONLY: simulate a successful payment
 * ---------------------------------------------------------- */
app.post('/api/payments/mock-confirm', requireAuth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { txn_id } = req.body || {};
    if (!txn_id) return res.status(400).json({ error: 'txn_id is required' });

    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('telebirr_txn_id', txn_id)
      .eq('user_id', req.profile.id)
      .maybeSingle();

    if (!sub) return res.status(404).json({ error: 'Unknown transaction' });

    const plan = PLANS[sub.plan_type] || PLANS.monthly;
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + plan.days * 86400 * 1000);

    await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'active',
        started_at: startedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq('id', sub.id);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .update({ is_premium: true, daily_likes_used: 0, last_like_reset: startedAt.toISOString() })
      .eq('id', req.profile.id)
      .select('*')
      .single();

    res.json({ is_premium: true, profile, subscription: { ...sub, status: 'active' } });
  } catch (err) {
    console.error('[POST /api/payments/mock-confirm]', err);
    res.status(500).json({ error: 'Mock confirmation failed' });
  }
});

/* ------------------------------------------------------------
 * 404 + ERROR HANDLERS
 * ---------------------------------------------------------- */
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ------------------------------------------------------------
 * START
 * ---------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`\n  Hearthside API running on http://localhost:${PORT}`);
  console.log(`  Health check:  http://localhost:${PORT}/api/health`);
  console.log(`  Config:        http://localhost:${PORT}/config.js`);
  console.log(`  Free like cap: ${FREE_LIKE_LIMIT}/day`);
  console.log(
    `  Tele Birr:     ${TELEBIRR_API_KEY ? 'LIVE' : 'MOCK (no API key set)'}\n`
  );
});

module.exports = app;
