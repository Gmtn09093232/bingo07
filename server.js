/* ============================================================
 *  HEARTHSIDE — server.js
 * ============================================================ */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEBIRR_API_KEY,
  PORT = 3000,
  FREE_DAILY_LIKES = '8',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n');
  process.exit(1);
}

const FREE_LIKE_LIMIT = parseInt(FREE_DAILY_LIKES, 10) || 8;
const FREE_MAX_KM = 100;
const PREMIUM_MAX_KM = 500;
const MAX_EXTRA_PHOTOS = 3;          // avatar + 3 = 4 photos total

const PLANS = {
  monthly: { amount_etb: 450, days: 30, label: 'Member+ Monthly' },
  yearly:  { amount_etb: 4500, days: 365, label: 'Member+ Yearly' },
};

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use('/api/payments/telebirr/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '6mb' }));  // 6mb for base64 photos

app.get('/config.js', (_req, res) => {
  const url = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(
    `window.SUPABASE_URL = ${JSON.stringify(url)};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(anon)};\n` +
    `window.HEARTHSIDE_API = '';\n`
  );
});

app.use(express.static(path.join(__dirname, '')));

/* -------------------- SUPABASE -------------------- */
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function supabaseAsUser(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/* -------------------- HELPERS -------------------- */
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

function sortPair(a, b) { return a < b ? [a, b] : [b, a]; }

/** Attach photos array (sorted by position) to a profile object. */
async function attachPhotos(profile) {
  if (!profile) return profile;
  const { data } = await supabaseAdmin
    .from('photos')
    .select('id, photo_url, position')
    .eq('user_id', profile.id)
    .order('position', { ascending: true });

  // Build photo list: avatar first, then extras
  const photos = [];
  if (profile.avatar_url) photos.push({ id: 'avatar', photo_url: profile.avatar_url, position: -1 });
  for (const p of data || []) photos.push(p);

  return { ...profile, photos };
}

/** Attach photos to an array of profiles in one DB round trip. */
async function attachPhotosBatch(profiles) {
  if (!profiles?.length) return [];
  const ids = profiles.map((p) => p.id);

  const { data: photoRows } = await supabaseAdmin
    .from('photos')
    .select('id, user_id, photo_url, position')
    .in('user_id', ids)
    .order('position', { ascending: true });

  const byUser = {};
  for (const p of photoRows || []) {
    (byUser[p.user_id] ||= []).push(p);
  }

  return profiles.map((p) => {
    const photos = [];
    if (p.avatar_url) photos.push({ id: 'avatar', photo_url: p.avatar_url, position: -1 });
    for (const extra of byUser[p.id] || []) photos.push(extra);
    return { ...p, photos };
  });
}

/* -------------------- AUTH -------------------- */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('*').eq('id', data.user.id).maybeSingle();

    req.token = token;
    req.user = data.user;
    req.profile = profile || null;
    next();
  } catch (err) {
    console.error('[requireAuth]', err);
    res.status(500).json({ error: 'Authentication failed', detail: err.message });
  }
}

async function ensureProfile(req) {
  if (req.profile) return req.profile;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .insert({
      id: req.user.id,
      name: req.user.user_metadata?.name || 'New user',
      age: req.user.user_metadata?.age || null,
      gender: req.user.user_metadata?.gender || null,
      city: req.user.user_metadata?.city || null,
      is_premium: false,
      daily_likes_used: 0,
      last_like_reset: new Date().toISOString(),
    })
    .select('*').single();
  if (error) throw new Error(`Could not create profile: ${error.message}`);
  req.profile = data;
  return data;
}

async function refreshDailyLikes(profile) {
  if (!profile) return profile;
  if (isNewDay(profile.last_like_reset)) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .update({ daily_likes_used: 0, last_like_reset: new Date().toISOString() })
      .eq('id', profile.id).select('*').single();
    return data || { ...profile, daily_likes_used: 0 };
  }
  return profile;
}

/* ============================================================
 *  ROUTES
 * ============================================================ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'hearthside-api', time: new Date().toISOString() });
});

/* -------------------- PROFILE -------------------- */
app.get('/api/profiles/me', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const withPhotos = await attachPhotos(me);
    res.json({ profile: withPhotos, max_extra_photos: MAX_EXTRA_PHOTOS });
  } catch (err) {
    console.error('[GET /api/profiles/me]', err);
    res.status(500).json({ error: 'Failed to load profile', detail: err.message });
  }
});

app.put('/api/profiles/me', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { name, age, gender, city, bio, tags, avatar_url, latitude, longitude } = req.body || {};
    const patch = {};

    if (typeof name === 'string') {
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
      patch.name = trimmed;
    }
    if (age !== undefined && age !== null && age !== '') {
      const n = parseInt(age, 10);
      if (Number.isNaN(n) || n < 18 || n > 120) {
        return res.status(400).json({ error: 'Age must be between 18 and 120' });
      }
      patch.age = n;
    }
    if (typeof gender === 'string') {
      const g = gender.trim().toLowerCase();
      if (!['woman', 'man', 'non-binary', 'other'].includes(g)) {
        return res.status(400).json({ error: 'Invalid gender' });
      }
      patch.gender = g;
    }
    if (typeof city === 'string') patch.city = city.trim().slice(0, 80);
    if (typeof bio === 'string') patch.bio = bio.trim().slice(0, 500);
    if (Array.isArray(tags)) {
      patch.tags = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8).map((t) => t.slice(0, 24));
    }
    if (typeof avatar_url === 'string') {
      const url = avatar_url.trim();
      if (url && !/^https?:\/\//i.test(url) && !url.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Avatar must be a valid URL' });
      }
      patch.avatar_url = url || null;
    }
    if (typeof latitude === 'number' && latitude >= -90 && latitude <= 90) patch.latitude = latitude;
    if (typeof longitude === 'number' && longitude >= -180 && longitude <= 180) patch.longitude = longitude;

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields provided' });

    const { data: updated, error } = await supabaseAdmin
      .from('profiles').update(patch).eq('id', me.id).select('*').single();
    if (error) throw error;

    const withPhotos = await attachPhotos(updated);
    res.json({ profile: withPhotos, max_extra_photos: MAX_EXTRA_PHOTOS });
  } catch (err) {
    console.error('[PUT /api/profiles/me]', err);
    res.status(500).json({ error: 'Failed to update profile', detail: err.message });
  }
});

/* -------------------- PHOTOS -------------------- */
app.get('/api/photos/me', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { data: photos } = await supabaseAdmin
      .from('photos').select('*').eq('user_id', me.id).order('position', { ascending: true });
    res.json({
      photos: photos || [],
      max_extra_photos: MAX_EXTRA_PHOTOS,
    });
  } catch (err) {
    console.error('[GET /api/photos/me]', err);
    res.status(500).json({ error: 'Failed to load photos', detail: err.message });
  }
});

app.post('/api/photos', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { photo_url } = req.body || {};

    if (!photo_url || typeof photo_url !== 'string') {
      return res.status(400).json({ error: 'photo_url is required' });
    }
    if (photo_url.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Photo too large', detail: 'Max ~3 MB after encoding.' });
    }
    if (!/^https?:\/\//i.test(photo_url) && !photo_url.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid photo URL' });
    }

    // Enforce the cap
    const { count } = await supabaseAdmin
      .from('photos').select('*', { count: 'exact', head: true }).eq('user_id', me.id);
    if ((count || 0) >= MAX_EXTRA_PHOTOS) {
      return res.status(429).json({
        error: `You can have up to ${MAX_EXTRA_PHOTOS} additional photos.`,
        code: 'PHOTO_LIMIT_REACHED',
      });
    }

    const { data: inserted, error } = await supabaseAdmin
      .from('photos')
      .insert({ user_id: me.id, photo_url, position: count || 0 })
      .select('*').single();
    if (error) throw error;

    console.log(`[photos] Added photo for ${me.id} (${count + 1}/${MAX_EXTRA_PHOTOS})`);
    res.status(201).json({ photo: inserted, max_extra_photos: MAX_EXTRA_PHOTOS });
  } catch (err) {
    console.error('[POST /api/photos]', err);
    res.status(500).json({ error: 'Failed to add photo', detail: err.message });
  }
});

app.delete('/api/photos/:id', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { id } = req.params;

    const { data: photo } = await supabaseAdmin
      .from('photos').select('*').eq('id', id).eq('user_id', me.id).maybeSingle();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    await supabaseAdmin.from('photos').delete().eq('id', id);

    // Re-pack positions so they stay 0,1,2
    const { data: remaining } = await supabaseAdmin
      .from('photos').select('id').eq('user_id', me.id).order('position', { ascending: true });

    for (let i = 0; i < (remaining || []).length; i++) {
      await supabaseAdmin.from('photos').update({ position: i }).eq('id', remaining[i].id);
    }

    console.log(`[photos] Removed photo ${id} for ${me.id}`);
    res.json({ ok: true, max_extra_photos: MAX_EXTRA_PHOTOS });
  } catch (err) {
    console.error('[DELETE /api/photos]', err);
    res.status(500).json({ error: 'Failed to delete photo', detail: err.message });
  }
});

/* -------------------- DISCOVER -------------------- */
app.get('/api/discover', requireAuth, async (req, res) => {
  try {
    const me = await refreshDailyLikes(await ensureProfile(req));

    const lat = parseFloat(req.query.lat ?? me.latitude);
    const lng = parseFloat(req.query.lng ?? me.longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        error: 'Location required',
        detail: 'Enable browser location, or set latitude/longitude on your profile via Edit profile.',
        code: 'LOCATION_REQUIRED',
      });
    }

    const requestedMaxKm = Math.min(
      Math.max(parseFloat(req.query.max_km) || FREE_MAX_KM, 1),
      PREMIUM_MAX_KM
    );
    const maxKm = me.is_premium ? requestedMaxKm : Math.min(requestedMaxKm, FREE_MAX_KM);

    let minAge = null, maxAge = null, genderPref = null, tagList = [];
    const filtersIgnored = [];

    if (me.is_premium) {
      const rawMin = parseInt(req.query.min_age, 10);
      const rawMax = parseInt(req.query.max_age, 10);
      if (!Number.isNaN(rawMin) && rawMin >= 18 && rawMin <= 120) minAge = rawMin;
      if (!Number.isNaN(rawMax) && rawMax >= 18 && rawMax <= 120) maxAge = rawMax;
      if (minAge !== null && maxAge !== null && minAge > maxAge) [minAge, maxAge] = [maxAge, minAge];

      if (typeof req.query.gender === 'string' && req.query.gender !== 'any') {
        const g = req.query.gender.trim().toLowerCase();
        if (['woman', 'man', 'non-binary', 'other'].includes(g)) genderPref = g;
      }

      if (typeof req.query.tags === 'string' && req.query.tags.trim()) {
        tagList = req.query.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8);
      }
    } else {
      if (req.query.min_age || req.query.max_age) filtersIgnored.push('age');
      if (req.query.gender && req.query.gender !== 'any') filtersIgnored.push('gender');
      if (req.query.tags) filtersIgnored.push('tags');
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const rpcLimit = Math.min(limit * 4, 300);

    const userClient = supabaseAsUser(req.token);
    const { data, error } = await userClient.rpc('get_nearby_profiles', {
      p_lat: lat,
      p_lng: lng,
      p_limit: rpcLimit,
      p_max_km: maxKm,
    });
    if (error) throw error;

    let profiles = (data || []).filter((p) => {
      if (minAge !== null && (p.age == null || p.age < minAge)) return false;
      if (maxAge !== null && (p.age == null || p.age > maxAge)) return false;
      if (genderPref && p.gender !== genderPref) return false;
      if (tagList.length) {
        const theirTags = (p.tags || []).map((t) => String(t).toLowerCase());
        if (!theirTags.some((t) => tagList.includes(t))) return false;
      }
      return true;
    });

    profiles = profiles.slice(0, limit);

    // Attach photos to every profile in one batch
    profiles = await attachPhotosBatch(profiles);

    profiles = profiles.map((p) => ({
      ...p,
      distance_km: p.distance_km !== null ? Number(p.distance_km.toFixed(2)) : null,
      distance_label: formatDistance(p.distance_km),
    }));

    res.json({
      profiles,
      filters: {
        applied: { max_km: maxKm, min_age: minAge, max_age: maxAge, gender: genderPref || 'any', tags: tagList },
        limits: { max_km: me.is_premium ? PREMIUM_MAX_KM : FREE_MAX_KM, free_max_km: FREE_MAX_KM, premium_max_km: PREMIUM_MAX_KM },
        ignored: filtersIgnored,
      },
      likes: {
        used: me.daily_likes_used,
        limit: me.is_premium ? null : FREE_LIKE_LIMIT,
        remaining: me.is_premium ? null : Math.max(0, FREE_LIKE_LIMIT - me.daily_likes_used),
        is_premium: me.is_premium,
      },
    });
  } catch (err) {
    console.error('[GET /api/discover]', err);
    res.status(500).json({ error: 'Failed to load discovery feed', detail: err.message });
  }
});

/* -------------------- LIKES -------------------- */
app.post('/api/likes', requireAuth, async (req, res) => {
  try {
    const me = await refreshDailyLikes(await ensureProfile(req));
    const { likee_id, is_like = true } = req.body || {};

    if (!likee_id) return res.status(400).json({ error: 'likee_id is required' });
    if (likee_id === me.id) return res.status(400).json({ error: 'You cannot like yourself' });

    if (is_like === true && !me.is_premium && me.daily_likes_used >= FREE_LIKE_LIMIT) {
      return res.status(429).json({
        error: 'Daily like limit reached',
        code: 'LIKE_LIMIT_REACHED',
        likes: { used: me.daily_likes_used, limit: FREE_LIKE_LIMIT, remaining: 0, is_premium: false },
      });
    }

    const { data: likeRow, error: likeErr } = await supabaseAdmin
      .from('likes').upsert({ liker_id: me.id, likee_id, is_like }, { onConflict: 'liker_id,likee_id' })
      .select('*').single();
    if (likeErr) throw likeErr;

    let updatedProfile = me;
    if (is_like === true) {
      const { data } = await supabaseAdmin
        .from('profiles').update({ daily_likes_used: me.daily_likes_used + 1 })
        .eq('id', me.id).select('*').single();
      if (data) updatedProfile = data;
    }

    const likesMeta = {
      used: updatedProfile.daily_likes_used,
      limit: updatedProfile.is_premium ? null : FREE_LIKE_LIMIT,
      remaining: updatedProfile.is_premium ? null : Math.max(0, FREE_LIKE_LIMIT - updatedProfile.daily_likes_used),
      is_premium: updatedProfile.is_premium,
    };

    if (is_like !== true) return res.json({ matched: false, like: likeRow, likes: likesMeta });

    const { data: reciprocal } = await supabaseAdmin
      .from('likes').select('id')
      .eq('liker_id', likee_id).eq('likee_id', me.id).eq('is_like', true).maybeSingle();

    if (!reciprocal) return res.json({ matched: false, like: likeRow, likes: likesMeta });

    const [u1, u2] = sortPair(me.id, likee_id);
    const { data: existing } = await supabaseAdmin
      .from('matches').select('*').eq('user1_id', u1).eq('user2_id', u2).maybeSingle();

    let match = existing;
    if (!match) {
      const { data: created, error: mErr } = await supabaseAdmin
        .from('matches').insert({ user1_id: u1, user2_id: u2 }).select('*').single();
      if (mErr) throw mErr;
      match = created;
    }

    const { data: other } = await supabaseAdmin
      .from('profiles').select('id, name, age, city, avatar_url, tags, bio')
      .eq('id', likee_id).single();

    const partnerWithPhotos = await attachPhotos(other);

    res.status(201).json({ matched: true, match, partner: partnerWithPhotos, like: likeRow, likes: likesMeta });
  } catch (err) {
    console.error('[POST /api/likes]', err);
    res.status(500).json({ error: 'Failed to record like', detail: err.message });
  }
});

/* -------------------- MATCHES -------------------- */
app.get('/api/matches', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { data: rows, error } = await supabaseAdmin
      .from('matches').select('*')
      .or(`user1_id.eq.${me.id},user2_id.eq.${me.id}`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!rows?.length) return res.json({ matches: [] });

    const partnerIds = rows.map((m) => (m.user1_id === me.id ? m.user2_id : m.user1_id));
    const { data: partners } = await supabaseAdmin
      .from('profiles').select('id, name, age, city, avatar_url, bio, tags, is_premium')
      .in('id', partnerIds);
    const partnerMap = Object.fromEntries((partners || []).map((p) => [p.id, p]));

    // Batch-attach photos to partners
    const partnersWithPhotos = await attachPhotosBatch(Object.values(partnerMap));
    const partnerPhotoMap = Object.fromEntries(partnersWithPhotos.map((p) => [p.id, p]));

    const matchIds = rows.map((m) => m.id);
    const { data: msgs } = await supabaseAdmin
      .from('messages')
      .select('id, match_id, sender_id, content, media_url, is_read, created_at')
      .in('match_id', matchIds).order('created_at', { ascending: false });

    const lastByMatch = {}, unreadByMatch = {};
    for (const m of msgs || []) {
      if (!lastByMatch[m.match_id]) lastByMatch[m.match_id] = m;
      if (m.sender_id !== me.id && !m.is_read) {
        unreadByMatch[m.match_id] = (unreadByMatch[m.match_id] || 0) + 1;
      }
    }

    const matches = rows.map((m) => {
      const partnerId = m.user1_id === me.id ? m.user2_id : m.user1_id;
      const partner = partnerPhotoMap[partnerId];
      if (!partner) return null;
      return {
        id: m.id, created_at: m.created_at, partner,
        last_message: lastByMatch[m.id] || null,
        unread_count: unreadByMatch[m.id] || 0,
      };
    }).filter(Boolean);

    res.json({ matches });
  } catch (err) {
    console.error('[GET /api/matches]', err);
    res.status(500).json({ error: 'Failed to load matches', detail: err.message });
  }
});

app.delete('/api/matches/:matchId', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { matchId } = req.params;
    const { data: match } = await supabaseAdmin
      .from('matches').select('*').eq('id', matchId).maybeSingle();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.user1_id !== me.id && match.user2_id !== me.id) {
      return res.status(403).json({ error: 'Not a participant of this match' });
    }
    await supabaseAdmin.from('matches').delete().eq('id', matchId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/matches]', err);
    res.status(500).json({ error: 'Failed to unmatch', detail: err.message });
  }
});

/* -------------------- MESSAGES -------------------- */
app.get('/api/messages/:matchId', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { matchId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const { data: match } = await supabaseAdmin
      .from('matches').select('*').eq('id', matchId).maybeSingle();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.user1_id !== me.id && match.user2_id !== me.id) {
      return res.status(403).json({ error: 'Not a participant of this match' });
    }

    const { data: messages } = await supabaseAdmin
      .from('messages').select('*').eq('match_id', matchId)
      .order('created_at', { ascending: true }).limit(limit);

    await supabaseAdmin.from('messages')
      .update({ is_read: true })
      .eq('match_id', matchId).neq('sender_id', me.id).eq('is_read', false);

    const partnerId = match.user1_id === me.id ? match.user2_id : match.user1_id;
    const { data: partner } = await supabaseAdmin
      .from('profiles').select('id, name, age, city, avatar_url, bio, tags')
      .eq('id', partnerId).single();

    const partnerWithPhotos = await attachPhotos(partner);

    res.json({ match, partner: partnerWithPhotos, messages: messages || [] });
  } catch (err) {
    console.error('[GET /api/messages]', err);
    res.status(500).json({ error: 'Failed to load messages', detail: err.message });
  }
});

app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { match_id, content = null, media_url = null } = req.body || {};
    if (!match_id) return res.status(400).json({ error: 'match_id is required' });
    if (!content && !media_url) return res.status(400).json({ error: 'Provide content or media_url' });

    if (media_url && typeof media_url === 'string' && media_url.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large', detail: 'Max ~3 MB after encoding.' });
    }

    const { data: match } = await supabaseAdmin
      .from('matches').select('id, user1_id, user2_id').eq('id', match_id).maybeSingle();
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.user1_id !== me.id && match.user2_id !== me.id) {
      return res.status(403).json({ error: 'Not a participant of this match' });
    }

    const { data: message, error } = await supabaseAdmin
      .from('messages')
      .insert({
        match_id, sender_id: me.id,
        content: content ? String(content).slice(0, 4000) : null,
        media_url,
      })
      .select('*').single();
    if (error) throw error;
    res.status(201).json({ message });
  } catch (err) {
    console.error('[POST /api/messages]', err);
    res.status(500).json({ error: 'Failed to send message', detail: err.message });
  }
});

/* -------------------- PREMIUM LIKES -------------------- */
app.get('/api/premium/likes', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { data: rows } = await supabaseAdmin
      .from('likes').select('id, liker_id, created_at')
      .eq('likee_id', me.id).eq('is_like', true)
      .order('created_at', { ascending: false });

    const likerIds = (rows || []).map((r) => r.liker_id);
    const total = likerIds.length;
    if (!likerIds.length) return res.json({ is_premium: me.is_premium, total: 0, likes: [] });

    const { data: myMatches } = await supabaseAdmin
      .from('matches').select('user1_id, user2_id')
      .or(`user1_id.eq.${me.id},user2_id.eq.${me.id}`);

    const matchedIds = new Set(
      (myMatches || []).map((m) => (m.user1_id === me.id ? m.user2_id : m.user1_id))
    );

    const { data: profiles } = await supabaseAdmin
      .from('profiles').select('id, name, age, city, avatar_url, bio, tags')
      .in('id', likerIds);

    const profilesWithPhotos = await attachPhotosBatch(profiles || []);
    const profileMap = Object.fromEntries(profilesWithPhotos.map((p) => [p.id, p]));

    if (me.is_premium) {
      const likes = rows.map((r) => {
        const p = profileMap[r.liker_id];
        if (!p) return null;
        return {
          like_id: r.id, liked_at: r.created_at,
          already_matched: matchedIds.has(r.liker_id), profile: p,
        };
      }).filter(Boolean);
      return res.json({ is_premium: true, total, likes });
    }

    const preview = rows.slice(0, 12).map((r) => {
      const p = profileMap[r.liker_id] || {};
      return {
        like_id: r.id, liked_at: r.created_at, locked: true,
        teaser: {
          first_name_initial: (p.name || '?').trim().charAt(0).toUpperCase(),
          age: p.age ?? null, city: p.city || null, avatar_url: p.avatar_url || null,
        },
      };
    });

    res.json({
      is_premium: false, total, likes: preview,
      upgrade: { code: 'PREMIUM_REQUIRED', message: 'Upgrade to Member+.', plans: PLANS },
    });
  } catch (err) {
    console.error('[GET /api/premium/likes]', err);
    res.status(500).json({ error: 'Failed to load likes', detail: err.message });
  }
});

/* -------------------- PAYMENTS -------------------- */
app.post('/api/payments/telebirr/initiate', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { plan_type } = req.body || {};
    if (!PLANS[plan_type]) {
      return res.status(400).json({ error: "plan_type must be 'monthly' or 'yearly'", plans: PLANS });
    }
    const plan = PLANS[plan_type];
    const txnId = `HS-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    let subscription = null;
    try {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .insert({
          user_id: me.id, plan_type,
          amount_etb: plan.amount_etb,
          status: 'pending', telebirr_txn_id: txnId,
        }).select('*').single();
      if (error) console.warn('[initiate] subscriptions insert failed:', error.message);
      else subscription = data;
    } catch (subErr) { console.warn('[initiate] subscriptions insert threw:', subErr.message); }

    res.status(201).json({
      mode: 'ussd', txn_id: txnId, subscription,
      plan: { plan_type, ...plan }, message: 'Pending USSD payment.',
    });
  } catch (err) {
    console.error('[POST /api/payments/telebirr/initiate]', err);
    res.status(500).json({ error: 'Failed to initiate payment', detail: err.message });
  }
});

app.post('/api/payments/mock-confirm', requireAuth, async (req, res) => {
  if (TELEBIRR_API_KEY) {
    return res.status(403).json({ error: 'Manual confirmation is disabled because Tele Birr is configured.' });
  }
  try {
    const me = await ensureProfile(req);
    const { txn_id } = req.body || {};
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + 30 * 86400 * 1000);

    if (txn_id) {
      try {
        await supabaseAdmin.from('subscriptions')
          .update({
            status: 'active',
            started_at: startedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          })
          .eq('telebirr_txn_id', txn_id).eq('user_id', me.id);
      } catch (subErr) {
        console.warn('[mock-confirm] subscriptions update failed (non-fatal):', subErr.message);
      }
    }

    const { data: profile, error: pErr } = await supabaseAdmin
      .from('profiles')
      .update({
        is_premium: true, daily_likes_used: 0,
        last_like_reset: startedAt.toISOString(),
      })
      .eq('id', me.id).select('*').single();
    if (pErr) throw pErr;

    res.json({ is_premium: true, profile });
  } catch (err) {
    console.error('[POST /api/payments/mock-confirm]', err);
    res.status(500).json({ error: 'Confirmation failed', detail: err.message });
  }
});

app.post('/api/payments/telebirr/webhook', (_req, res) => {
  res.json({ received: true });
});

/* -------------------- DEBUG -------------------- */
app.get('/api/debug/discover', requireAuth, async (req, res) => {
  try {
    const me = await ensureProfile(req);
    const { count: totalProfiles } = await supabaseAdmin
      .from('profiles').select('*', { count: 'exact', head: true });
    const { count: withCoords } = await supabaseAdmin
      .from('profiles').select('*', { count: 'exact', head: true })
      .not('latitude', 'is', null).not('longitude', 'is', null);
    const { count: others } = await supabaseAdmin
      .from('profiles').select('*', { count: 'exact', head: true })
      .neq('id', me.id);
    const { count: swiped } = await supabaseAdmin
      .from('likes').select('*', { count: 'exact', head: true })
      .eq('liker_id', me.id);
    const { count: myPhotos } = await supabaseAdmin
      .from('photos').select('*', { count: 'exact', head: true })
      .eq('user_id', me.id);

    res.json({
      me: {
        id: me.id,
        has_coords: me.latitude !== null && me.longitude !== null,
        is_premium: me.is_premium,
        photo_count: myPhotos || 0,
      },
      total_profiles: totalProfiles,
      with_coords: withCoords,
      other_profiles: others,
      already_swiped: swiped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- 404 + ERROR -------------------- */
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

/* -------------------- START -------------------- */
app.listen(PORT, () => {
  console.log(`\n  Hearthside API running on http://localhost:${PORT}`);
  console.log(`  Health check:  http://localhost:${PORT}/api/health`);
  console.log(`  Free like cap: ${FREE_LIKE_LIMIT}/day`);
  console.log(`  Distance cap:  ${FREE_MAX_KM}km free · ${PREMIUM_MAX_KM}km premium`);
  console.log(`  Photos/user:   1 avatar + ${MAX_EXTRA_PHOTOS} extras`);
  console.log(`  Tele Birr:     ${TELEBIRR_API_KEY ? 'LIVE' : 'USSD (manual confirmation)'}\n`);
});

module.exports = app;
