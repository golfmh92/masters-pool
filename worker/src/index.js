// Masters Pool Push Notification Worker
// Cron: every 2 minutes — sends ONE summary per team per round when all 5 golfers finished

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForEvents(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/debug') return debugCheck(env);
    await checkForEvents(env);
    return new Response('OK - checked for events');
  }
};

async function debugCheck(env) {
  const resp = await fetch(env.ESPN_URL);
  const json = await resp.json();
  const events = json.events || [];
  let tournament = events.find(e => e.name && (e.name.toLowerCase().includes('masters') || e.name.toLowerCase().includes('augusta')));
  if (!tournament && events.length > 0) tournament = events[0];
  const comp = tournament?.competitions?.[0];
  const competitors = comp?.competitors || [];

  const espnMap = {};
  for (const c of competitors) {
    const name = c.athlete?.displayName || c.athlete?.shortName || '';
    if (!name) continue;
    espnMap[normalizeName(name)] = { name, rounds: (c.linescores || []).map((ls, i) => ({ round: i + 1, holes: (ls.linescores || []).length })) };
  }

  const golfers = await supabaseGet(env, 'masters_golfers', 'id,name,participant_id');
  const participants = await supabaseGet(env, 'masters_participants', 'id,name');
  const subscriptions = await supabaseGet(env, 'masters_push_subscriptions', 'participant_id,endpoint');

  const debug = { espnCount: competitors.length, golfers: golfers.length, subs: subscriptions.length, teams: [] };

  for (const p of participants) {
    const teamGolfers = golfers.filter(g => g.participant_id === p.id);
    const hasSub = subscriptions.some(s => s.participant_id === p.id);
    const team = { name: p.name, hasSub, golfers: [] };

    for (const g of teamGolfers) {
      const norm = normalizeName(g.name);
      const espn = espnMap[norm];
      team.golfers.push({ name: g.name, normalized: norm, espnMatch: espn ? espn.name : 'NOT FOUND', rounds: espn ? espn.rounds : [] });
    }

    // Check KV for sent summaries
    team.kvKeys = {};
    for (let r = 1; r <= 4; r++) {
      const k = `summary_${p.id}_r${r}`;
      team.kvKeys[`r${r}`] = await env.KV.get(k);
    }

    if (hasSub) debug.teams.push(team);
  }

  return new Response(JSON.stringify(debug, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

async function checkForEvents(env) {
  try {
    // 1. Fetch ESPN scoreboard
    const resp = await fetch(env.ESPN_URL);
    if (!resp.ok) return;
    const json = await resp.json();

    const events = json.events || [];
    let tournament = events.find(e =>
      e.name && (e.name.toLowerCase().includes('masters') || e.name.toLowerCase().includes('augusta'))
    );
    if (!tournament && events.length > 0) tournament = events[0];
    if (!tournament) return;

    const comp = tournament.competitions?.[0];
    if (!comp) return;
    const competitors = comp.competitors || [];

    // 2. Fetch data from Supabase
    const golfers = await supabaseGet(env, 'masters_golfers', 'id,name,participant_id');
    const participants = await supabaseGet(env, 'masters_participants', 'id,name');
    const subscriptions = await supabaseGet(env, 'masters_push_subscriptions', 'participant_id,endpoint,p256dh,auth');

    console.log(`Data: ${golfers.length} golfers, ${participants.length} participants, ${subscriptions.length} subs, ${competitors.length} ESPN competitors`);
    if (!golfers.length || !subscriptions.length) return;

    // 3. Build ESPN lookup: normalized name → competitor data
    const espnMap = {};
    for (const c of competitors) {
      const name = c.athlete?.displayName || c.athlete?.shortName || '';
      if (!name) continue;
      espnMap[normalizeName(name)] = c;
    }

    // 4. For each participant, check if all their golfers finished a round
    for (const p of participants) {
      const teamGolfers = golfers.filter(g => g.participant_id === p.id);
      if (teamGolfers.length === 0) continue;

      const subs = subscriptions.filter(s => s.participant_id === p.id);
      if (subs.length === 0) continue;

      for (let round = 1; round <= 4; round++) {
        const kvKey = `summary_${p.id}_r${round}`;

        // Already sent?
        const sent = await env.KV.get(kvKey);
        console.log(`${p.name} R${round}: kvKey=${kvKey}, sent=${sent}`);
        if (sent) continue;

        // Check if ALL golfers finished this round
        let allFinished = true;
        const golferScores = [];

        for (const g of teamGolfers) {
          const norm = normalizeName(g.name);
          const espn = espnMap[norm];
          if (!espn) { console.log(`  ${g.name} (${norm}): NOT FOUND in ESPN`); allFinished = false; break; }

          const linescores = espn.linescores || [];
          const roundData = linescores[round - 1];
          if (!roundData) { allFinished = false; break; }

          const holes = roundData.linescores || [];
          if (holes.length < 18) { allFinished = false; break; }

          const roundStrokes = holes.reduce((sum, h) => sum + (h.value || 0), 0);
          const toPar = roundStrokes - 72;
          const shortName = g.name.split(' ').pop();

          golferScores.push({ shortName, toPar, roundStrokes });
        }

        console.log(`${p.name} R${round}: allFinished=${allFinished}, golferScores=${golferScores.length}`);
        if (!allFinished) continue;

        // Calculate team total for this round (best 4 of 5 for R1-R2, best 3 of 5 for R3-R4)
        const countNeeded = round <= 2 ? 4 : 3;
        const sorted = [...golferScores].sort((a, b) => a.toPar - b.toPar);
        const counting = sorted.slice(0, countNeeded);
        const teamToPar = counting.reduce((sum, g) => sum + g.toPar, 0);
        const teamStr = teamToPar === 0 ? 'E' : (teamToPar > 0 ? `+${teamToPar}` : `${teamToPar}`);

        // Build notification
        const scoreLines = golferScores.map(g => {
          const s = g.toPar === 0 ? 'E' : (g.toPar > 0 ? `+${g.toPar}` : `${g.toPar}`);
          return `${g.shortName} ${s}`;
        }).join(' · ');

        const title = `🏁 Runde ${round} fertig — Team ${teamStr}`;
        const body = scoreLines;

        console.log(`SENDING to ${p.name}: ${title} | ${body}`);
        // Mark as sent
        await env.KV.put(kvKey, '1', { expirationTtl: 86400 * 7 });

        // Send to all subscriptions of this participant
        for (const sub of subs) {
          try {
            await sendWebPush(env, sub, { title, body });
          } catch (e) {
            console.error('Push failed for', sub.endpoint, e);
            if (e.status === 410 || e.status === 404) {
              await supabaseDelete(env, 'masters_push_subscriptions', sub.endpoint);
            }
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

  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublicKey = await crypto.subtle.exportKey('raw', localKeyPair.publicKey);

  const subscriberPublicKeyBytes = base64UrlDecode(p256dh);
  const subscriberPublicKey = await crypto.subtle.importKey('raw', subscriberPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: subscriberPublicKey }, localKeyPair.privateKey, 256);

  const authBytes = base64UrlDecode(auth);
  const ikm = await hkdf(authBytes, sharedSecret, concatBuffers(new TextEncoder().encode('WebPush: info\0'), subscriberPublicKeyBytes, new Uint8Array(localPublicKey)), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', prk, { name: 'AES-GCM' }, false, ['encrypt']);
  const paddedPayload = concatBuffers(new Uint8Array([0, 0]), payloadBytes);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, paddedPayload);

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const keyId = new Uint8Array(localPublicKey);
  const idLen = new Uint8Array([65]);
  const body = concatBuffers(salt, rs, idLen, keyId, new Uint8Array(encrypted));

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
