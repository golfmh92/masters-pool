// Masters Pool Push Notification Worker
// Cron: every 2 minutes — polls ESPN, detects eagles/double bogeys, sends push notifications

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForEvents(env));
  },
  // Manual trigger for testing
  async fetch(request, env) {
    await checkForEvents(env);
    return new Response('OK - checked for events');
  }
};

async function checkForEvents(env) {
  try {
    // 1. Fetch ESPN scoreboard
    const resp = await fetch(env.ESPN_URL);
    if (!resp.ok) return;
    const json = await resp.json();

    const events = json.events || [];
    // Find The Masters specifically
    let tournament = events.find(e =>
      e.name && (e.name.toLowerCase().includes('masters') || e.name.toLowerCase().includes('augusta'))
    );
    if (!tournament && events.length > 0) tournament = events[0];
    if (!tournament) return;

    const comp = tournament.competitions?.[0];
    if (!comp) return;
    const competitors = comp.competitors || [];

    // 2. Fetch golfer→participant mapping from Supabase
    const golfers = await supabaseGet(env, 'masters_golfers', 'id,name,participant_id');
    const participants = await supabaseGet(env, 'masters_participants', 'id,name');
    const subscriptions = await supabaseGet(env, 'masters_push_subscriptions', 'participant_id,endpoint,p256dh,auth,favorites');

    if (!golfers.length || !subscriptions.length) return;

    // Preload all seen event IDs in ONE KV.list call (instead of hundreds of KV.get)
    const seenKeys = new Set();
    let cursor = undefined;
    do {
      const listResp = await env.KV.list(cursor ? { cursor } : {});
      for (const k of listResp.keys) seenKeys.add(k.name);
      cursor = listResp.list_complete ? undefined : listResp.cursor;
    } while (cursor);

    // Build golfer→participant mapping (normalize names for matching)
    const golferMap = {}; // espnName → [{participant_id, participantName}]
    for (const g of golfers) {
      const norm = normalizeName(g.name);
      if (!golferMap[norm]) golferMap[norm] = [];
      const p = participants.find(p => p.id === g.participant_id);
      golferMap[norm].push({ participant_id: g.participant_id, participantName: p?.name || '' });
    }

    // 3. Scan for events
    const newEvents = [];
    for (const c of competitors) {
      const athlete = c.athlete || {};
      const name = athlete.displayName || athlete.shortName || '';
      if (!name) continue;

      const linescores = c.linescores || [];
      for (let r = 0; r < linescores.length && r < 4; r++) {
        const roundHoles = linescores[r].linescores || [];
        for (const h of roundHoles) {
          const parVal = h.scoreType?.displayValue;
          if (!parVal) continue;
          const pv = parVal === 'E' ? 0 : parseInt(parVal);
          if (isNaN(pv)) continue;

          // Only eagles+ or double bogeys+
          if (pv > -2 && pv < 2) continue;

          const eventId = `${name}_r${r + 1}_h${h.period}`;
          if (seenKeys.has(eventId)) continue;

          // Mark as seen (in-memory + KV)
          seenKeys.add(eventId);
          await env.KV.put(eventId, '1', { expirationTtl: 86400 * 7 }); // expire after 7 days

          let emoji, label;
          if (pv <= -3) { emoji = '🌟'; label = 'Albatross'; }
          else if (h.value === 1) { emoji = '🔥'; label = 'Hole-in-One'; }
          else if (pv <= -2) { emoji = '🦅'; label = 'Eagle'; }
          else if (pv >= 3) { emoji = '🟥'; label = 'Triple Bogey+'; }
          else { emoji = '🟡'; label = 'Doppel-Bogey'; }

          newEvents.push({ name, eventId, emoji, label, hole: h.period, round: r + 1, pv });
        }

        // Round finished detection: 18 holes played = round complete
        if (roundHoles.length >= 18) {
          const finishId = `${name}_r${r + 1}_finished`;
          if (!seenKeys.has(finishId)) {
            seenKeys.add(finishId);
            await env.KV.put(finishId, '1', { expirationTtl: 86400 * 7 });
            const roundScore = roundHoles.reduce((sum, h) => sum + (h.value || 0), 0);
            const toPar = roundScore - 72; // Augusta PAR = 72
            const toParStr = toPar === 0 ? 'Even Par' : (toPar > 0 ? `+${toPar}` : `${toPar}`);
            newEvents.push({
              name, eventId: finishId, emoji: '🏁',
              label: `beendete R${r + 1} mit ${roundScore} Schlägen (${toParStr})`,
              hole: null, round: r + 1, pv: null, isRoundFinish: true
            });
          }
        }
      }
    }

    if (newEvents.length === 0) return;

    // 4. Send push notifications
    for (const ev of newEvents) {
      const norm = normalizeName(ev.name);

      // Find subscriptions: team owners of this golfer + anyone who favorited this player
      const teamOwners = golferMap[norm] || [];
      const targetParticipantIds = new Set(teamOwners.map(t => t.participant_id));

      // Also check favorites
      for (const sub of subscriptions) {
        const favs = sub.favorites || [];
        if (favs.some(f => normalizeName(f) === norm)) {
          targetParticipantIds.add(sub.participant_id);
        }
      }

      const targetSubs = subscriptions.filter(s => targetParticipantIds.has(s.participant_id));

      const shortName = ev.name.split(' ').length > 1
        ? ev.name.split(' ').slice(1).join(' ') + ' ' + ev.name.split(' ')[0][0] + '.'
        : ev.name;

      const title = `${ev.emoji} ${shortName}`;
      const body = ev.isRoundFinish
        ? ev.label
        : `${ev.label} auf Loch ${ev.hole} (R${ev.round})`;

      for (const sub of targetSubs) {
        try {
          await sendWebPush(env, sub, { title, body });
        } catch (e) {
          console.error('Push failed for', sub.endpoint, e);
          // If endpoint is gone (410), delete subscription
          if (e.status === 410 || e.status === 404) {
            await supabaseDelete(env, 'masters_push_subscriptions', sub.endpoint);
          }
        }
      }
    }
  } catch (e) {
    console.error('checkForEvents error:', e);
  }
}

// ===== Web Push (RFC 8291) =====
async function sendWebPush(env, sub, payload) {
  const endpoint = sub.endpoint;
  const p256dh = sub.p256dh;
  const auth = sub.auth;

  const vapidPrivate = env.VAPID_PRIVATE_KEY;
  const vapidPublic = env.VAPID_PUBLIC_KEY;
  const vapidSubject = env.VAPID_SUBJECT;

  const payloadText = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadText);

  // Generate local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublicKey = await crypto.subtle.exportKey('raw', localKeyPair.publicKey);

  // Import subscriber's public key
  const subscriberPublicKeyBytes = base64UrlDecode(p256dh);
  const subscriberPublicKey = await crypto.subtle.importKey('raw', subscriberPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: subscriberPublicKey }, localKeyPair.privateKey, 256);

  // Auth secret
  const authBytes = base64UrlDecode(auth);

  // HKDF for IKM
  const ikm = await hkdf(authBytes, sharedSecret, concatBuffers(new TextEncoder().encode('WebPush: info\0'), subscriberPublicKeyBytes, new Uint8Array(localPublicKey)), 32);

  // Salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF for CEK and nonce
  const prk = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // Encrypt with AES-128-GCM
  const aesKey = await crypto.subtle.importKey('raw', prk, { name: 'AES-GCM' }, false, ['encrypt']);
  const paddedPayload = concatBuffers(new Uint8Array([0, 0]), payloadBytes);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, paddedPayload);

  // Build body: salt(16) + rs(4) + idlen(1) + keyid(65) + encrypted
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const keyId = new Uint8Array(localPublicKey);
  const idLen = new Uint8Array([65]);
  const body = concatBuffers(salt, rs, idLen, keyId, new Uint8Array(encrypted));

  // VAPID JWT
  const jwt = await createVapidJwt(endpoint, vapidSubject, vapidPrivate, vapidPublic);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt.token}, k=${jwt.publicKey}`
    },
    body
  });

  if (!response.ok) {
    const err = new Error(`Push failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }
}

async function createVapidJwt(endpoint, subject, privateKeyBase64, publicKeyBase64) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 86400,
    sub: subject
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privateKeyBase64,
    x: base64UrlEncode(base64UrlDecode(publicKeyBase64).slice(1, 33)),
    y: base64UrlEncode(base64UrlDecode(publicKeyBase64).slice(33, 65))
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));

  const sig = derToRaw(new Uint8Array(signature));
  const token = `${unsigned}.${base64UrlEncode(sig)}`;

  return { token, publicKey: publicKeyBase64 };
}

// ===== Helpers =====
function normalizeName(n) {
  return n.replace(/\s*\(a\)\s*$/, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').trim();
}

async function supabaseGet(env, table, select) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=${select}`, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
  });
  return resp.ok ? resp.json() : [];
}

async function supabaseDelete(env, table, endpoint) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
  });
}

function base64UrlDecode(str) {
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

function base64UrlEncode(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBuffers(...buffers) {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    result.set(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer ? b : b), offset);
    offset += b.byteLength;
  }
  return result;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', key, ikm instanceof ArrayBuffer ? ikm : new Uint8Array(ikm));
  const infoKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = await crypto.subtle.sign('HMAC', infoKey, concatBuffers(info, new Uint8Array([1])));
  return new Uint8Array(result).slice(0, length);
}

function derToRaw(der) {
  if (der.length === 64) return der;
  const r = der.slice(der[3] === 33 ? 5 : 4, der[3] === 33 ? 37 : 36);
  const sOffset = der[3] === 33 ? 37 : 36;
  const sLen = der[sOffset + 1];
  const s = der.slice(sOffset + 2 + (sLen === 33 ? 1 : 0), sOffset + 2 + sLen);
  const raw = new Uint8Array(64);
  raw.set(r.length === 33 ? r.slice(1) : r, 32 - (r.length === 33 ? 32 : r.length));
  raw.set(s.length === 33 ? s.slice(1) : s, 64 - (s.length === 33 ? 32 : s.length));
  return raw;
}
