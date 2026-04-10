// Masters Pool Push Notifications (GitHub Actions)
// Polls ESPN, detects eagles/double bogeys/round finishes, sends web push via web-push library

import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = join(__dirname, '.seen.json');
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const PAR = 72;

const {
  SUPABASE_URL, SUPABASE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
} = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing env vars');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// --- State: track seen events ---
function loadSeen() {
  if (existsSync(SEEN_FILE)) {
    try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}
function saveSeen(seen) {
  writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

// --- Supabase helpers ---
async function supabaseGet(table, select) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return res.ok ? res.json() : [];
}

async function supabaseDelete(table, endpoint) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
}

function normalizeName(n) {
  return n.replace(/\s*\(a\)\s*$/, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').trim();
}

function shortName(name) {
  const parts = name.trim().split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') + ' ' + parts[0][0] + '.' : name;
}

// --- Main ---
async function main() {
  // 1. Fetch ESPN
  const resp = await fetch(ESPN_URL);
  if (!resp.ok) { console.log('ESPN fetch failed:', resp.status); return; }
  const json = await resp.json();

  const events = json.events || [];
  let tournament = events.find(e => e.name?.toLowerCase().includes('masters') || e.name?.toLowerCase().includes('augusta'));
  if (!tournament && events.length > 0) tournament = events[0];
  if (!tournament) { console.log('No tournament found'); return; }

  const comp = tournament.competitions?.[0];
  if (!comp) return;
  const competitors = comp.competitors || [];

  // 2. Fetch Supabase data
  const [golfers, participants, subscriptions] = await Promise.all([
    supabaseGet('masters_golfers', 'id,name,participant_id'),
    supabaseGet('masters_participants', 'id,name'),
    supabaseGet('masters_push_subscriptions', 'participant_id,endpoint,p256dh,auth,favorites')
  ]);

  if (!golfers.length || !subscriptions.length) {
    console.log(`No data: ${golfers.length} golfers, ${subscriptions.length} subs`);
    return;
  }

  // golfer → participant mapping
  const golferMap = {};
  for (const g of golfers) {
    const norm = normalizeName(g.name);
    if (!golferMap[norm]) golferMap[norm] = [];
    const p = participants.find(p => p.id === g.participant_id);
    golferMap[norm].push({ participant_id: g.participant_id, participantName: p?.name || '' });
  }

  // 3. Load seen events
  const seen = loadSeen();

  // 4. Scan for events
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
        if (seen[eventId]) continue;
        seen[eventId] = Date.now();

        let emoji, label;
        if (pv <= -3) { emoji = '🌟'; label = 'Albatross'; }
        else if (h.value === 1) { emoji = '🔥'; label = 'Hole-in-One'; }
        else if (pv <= -2) { emoji = '🦅'; label = 'Eagle'; }
        else if (pv >= 3) { emoji = '💀'; label = 'Triple Bogey+'; }
        else { emoji = '😬'; label = 'Doppel-Bogey'; }

        newEvents.push({ name, eventId, emoji, label, hole: h.period, round: r + 1, pv });
      }

      // Round finished
      if (roundHoles.length >= 18) {
        const finishId = `${name}_r${r + 1}_finished`;
        if (!seen[finishId]) {
          seen[finishId] = Date.now();
          const roundScore = roundHoles.reduce((sum, h) => sum + (h.value || 0), 0);
          const toPar = roundScore - PAR;
          const toParStr = toPar === 0 ? 'Even Par' : (toPar > 0 ? `+${toPar}` : `${toPar}`);
          newEvents.push({
            name, eventId: finishId, emoji: '🏁',
            label: `beendete R${r + 1} mit ${roundScore} (${toParStr})`,
            hole: null, round: r + 1, pv: null, isRoundFinish: true
          });
        }
      }
    }
  }

  // Save seen state
  saveSeen(seen);

  if (newEvents.length === 0) {
    console.log('No new events');
    return;
  }

  console.log(`${newEvents.length} new events found`);

  // 5. Send push notifications
  let sent = 0, failed = 0;
  for (const ev of newEvents) {
    const norm = normalizeName(ev.name);

    // Find target subscriptions: team owners + favorites
    const teamOwners = golferMap[norm] || [];
    const targetIds = new Set(teamOwners.map(t => t.participant_id));

    for (const sub of subscriptions) {
      const favs = sub.favorites || [];
      if (favs.some(f => normalizeName(f) === norm)) {
        targetIds.add(sub.participant_id);
      }
    }

    const targetSubs = subscriptions.filter(s => targetIds.has(s.participant_id));
    const sn = shortName(ev.name);
    const title = `${ev.emoji} ${sn}`;
    const body = ev.isRoundFinish ? ev.label : `${ev.label} auf Loch ${ev.hole} (R${ev.round})`;

    for (const sub of targetSubs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title, body })
        );
        sent++;
        console.log(`  ✓ ${title} → ${sub.participant_id}`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${title} → ${sub.participant_id}: ${e.statusCode || e.message}`);
        if (e.statusCode === 410 || e.statusCode === 404) {
          await supabaseDelete('masters_push_subscriptions', sub.endpoint);
          console.log(`    Removed stale subscription`);
        }
      }
    }
  }

  console.log(`Done: ${sent} sent, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
