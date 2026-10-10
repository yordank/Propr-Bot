#!/usr/bin/env node
/**
 * propr-copy.js — копира позициите на Hyperliquid адрес в Propr акаунт (app.propr.xyz)
 *
 * Логика: на всеки POLL_MS бот-ът чете позициите на таргета в Hyperliquid,
 * умножава ги по RATIO и изравнява позициите в Propr с market ордери.
 * Така хваща отваряне, добавяне, намаляне, затваряне и обръщане (flip),
 * и сам се коригира ако нещо се размине.
 *
 * RATIO = MY_CAPITAL / TARGET_CAPITAL
 *   5 000   / 200 000 = 0.025
 *   100 000 / 200 000 = 0.5   (1:2)
 *   200 000 / 200 000 = 1     (1:1)
 *
 * Node 18+, без външни пакети.  Старт:  node propr-copy.js
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────── .env ─────────────────────────
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const bool = (k, d) => String(env(k, d)).toLowerCase() === 'true';

const CFG = {
  PROPR_API_KEY: env('PROPR_API_KEY'),
  PROPR_API: env('PROPR_API', 'https://api.propr.xyz/v1'),
  PROPR_ACCOUNT_ID: env('PROPR_ACCOUNT_ID', ''),        // празно = активният challenge
  TARGET: env('TARGET', '0xf97ad6704baec104d00b88e0c157e2b7b3a1ddd1').toLowerCase(),
  HL_API: env('HL_API', 'https://api.hyperliquid.xyz/info'),

  MY_CAPITAL: env('MY_CAPITAL', 'auto'),                 // 'auto' = startingBalance от challenge
  TARGET_CAPITAL: env('TARGET_CAPITAL', '200000'),       // число или 'auto' = текущ accountValue на таргета
  RATIO: env('RATIO', ''),                               // ако е зададен — пренебрегва горните две

  DEXES: env('DEXES', ',xyz').split(','),                // '' = основни perps, 'xyz' = акции/стоки
  POLL_MS: Number(env('POLL_MS', 3000)),
  MIN_ORDER_USD: Number(env('MIN_ORDER_USD', 11)),       // под това не праща ордер
  MIN_CHANGE_PCT: Number(env('MIN_CHANGE_PCT', 5)),      // разлика под X% от желаната позиция се пренебрегва
  COOLDOWN_MS: Number(env('COOLDOWN_MS', 8000)),         // пауза за актив след ордер
  MARGIN_SAFETY: Number(env('MARGIN_SAFETY', 0.85)),     // колко от капитала може да е зает марджин
  IGNORE_EXISTING_POSITIONS: bool('IGNORE_EXISTING_POSITIONS', 'false'),
  COIN_BLACKLIST: env('COIN_BLACKLIST', '').split(',').map(s => s.trim()).filter(Boolean),
  DRY_RUN: bool('DRY_RUN', 'true'),
};

if (!CFG.PROPR_API_KEY) { console.error('Липсва PROPR_API_KEY в .env'); process.exit(1); }

// ───────────────────────── helpers ─────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let t = Date.now(), time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  let rnd = '';
  const bytes = require('crypto').randomBytes(16);
  for (let i = 0; i < 16; i++) rnd += B32[bytes[i] % 32];
  return time + rnd;
}

function roundDown(x, decimals) {
  const f = 10 ** decimals;
  return Math.floor(Math.abs(x) * f + 1e-9) / f;
}

// ───────────────────────── Hyperliquid ─────────────────────────
async function hl(body) {
  const r = await fetch(CFG.HL_API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HL ${r.status}: ${await r.text()}`);
  return r.json();
}

const szDecimals = {};   // coin -> decimals
async function loadMeta() {
  for (const dex of CFG.DEXES) {
    const meta = await hl(dex ? { type: 'meta', dex } : { type: 'meta' });
    for (const a of meta.universe) szDecimals[a.name] = a.szDecimals;
  }
}

async function getMids() {
  const mids = {};
  for (const dex of CFG.DEXES) Object.assign(mids, await hl(dex ? { type: 'allMids', dex } : { type: 'allMids' }));
  return mids;
}

/** { coin: signedSize }, accountValue */
async function getTargetPositions() {
  const pos = {};
  let accountValue = 0;
  for (const dex of CFG.DEXES) {
    const st = await hl(dex ? { type: 'clearinghouseState', user: CFG.TARGET, dex }
                            : { type: 'clearinghouseState', user: CFG.TARGET });
    accountValue += Number(st.marginSummary.accountValue);
    for (const { position: p } of st.assetPositions) {
      const s = Number(p.szi);
      if (s !== 0) pos[p.coin] = s;
    }
  }
  return { pos, accountValue };
}

// ───────────────────────── Propr ─────────────────────────
async function propr(method, p, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(CFG.PROPR_API + p, {
      method,
      headers: { 'X-API-Key': CFG.PROPR_API_KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`Propr ${method} ${p} → ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Propr ${method} ${p} → 429 (rate limit)`);
}

let ACCOUNT_ID = CFG.PROPR_ACCOUNT_ID;
let leverageLimits = { defaultMax: 2, overrides: {} };
const maxLev = coin => leverageLimits.overrides[coin] ?? leverageLimits.defaultMax;

async function setupPropr() {
  const attempts = (await propr('GET', '/challenge-attempts?status=active')).data || [];
  const att = ACCOUNT_ID ? attempts.find(a => a.accountId === ACCOUNT_ID) : attempts[0];
  if (!att && !ACCOUNT_ID) throw new Error('Няма активен challenge в Propr');
  if (att) ACCOUNT_ID = att.accountId;
  try { leverageLimits = await propr('GET', '/leverage-limits/effective'); } catch (e) { log('⚠ leverage limits:', e.message); }
  const startBal = att?.currentPhase?.startingBalance ?? att?.phases?.find(p => p.status === 'active')?.startingBalance;
  return startBal ? Number(startBal) : null;
}

/** { coin: { long, short } } — Propr е hedge mode: long и short са отделни позиции */
async function getMyPositions() {
  const res = await propr('GET', `/accounts/${ACCOUNT_ID}/positions?status=open&limit=200`);
  const out = {};
  for (const p of res.data || []) {
    const q = Number(p.quantity);
    if (!q) continue;
    out[p.asset] ??= { long: 0, short: 0 };
    out[p.asset][p.positionSide] += q;
  }
  return out;
}

const leverageSet = new Set();
async function ensureLeverage(coin) {
  if (leverageSet.has(coin) || CFG.DRY_RUN) return;
  try {
    const cfg = await propr('GET', `/accounts/${ACCOUNT_ID}/margin-config/${encodeURIComponent(coin)}`);
    const c = cfg.data || cfg;
    const lev = maxLev(coin);
    if (Number(c.leverage) !== lev || c.marginMode !== 'cross') {
      await propr('PUT', `/accounts/${ACCOUNT_ID}/margin-config/${encodeURIComponent(c.configId)}`,
        { exchange: 'hyperliquid', asset: coin, marginMode: 'cross', leverage: lev });
      log(`⚙ ${coin}: leverage ${lev}x cross`);
    }
    leverageSet.add(coin);
  } catch (e) { log(`⚠ ${coin} leverage:`, e.message); }
}

async function marketOrder(coin, side, positionSide, qty, reduceOnly, closePosition = false) {
  const qtyStr = qty.toFixed(szDecimals[coin] ?? 4);
  const tag = `${side.toUpperCase()} ${qtyStr} ${coin} (${positionSide}${reduceOnly ? ', reduce' : ''}${closePosition ? ', close' : ''})`;
  if (CFG.DRY_RUN) { log(`🧪 DRY ${tag}`); return; }
  await ensureLeverage(coin);
  const res = await propr('POST', `/accounts/${ACCOUNT_ID}/orders`, {
    orders: [{
      accountId: ACCOUNT_ID, intentId: ulid(), exchange: 'hyperliquid',
      type: 'market', side, positionSide, productType: 'perp', timeInForce: 'IOC',
      asset: coin, base: coin, quote: 'USDC', quantity: qtyStr,
      reduceOnly, closePosition,
    }],
  });
  const o = res?.data?.[0];
  log(`✅ ${tag} → ${o?.status ?? '?'}${o?.averageFillPrice ? ' @ ' + o.averageFillPrice : ''}`);
}

// ───────────────────────── sync ─────────────────────────
let RATIO = 0, MY_CAP = 0;
const ignored = new Set();         // IGNORE_EXISTING_POSITIONS
const cooldown = {};               // coin -> until ms
const paper = {};                  // DRY_RUN виртуални позиции { coin: { long, short } }

async function syncOnce() {
  const [{ pos: tgt, accountValue }, mids] = await Promise.all([getTargetPositions(), getMids()]);
  const mine = CFG.DRY_RUN ? paper : await getMyPositions();

  // при auto target capital — ratio следва капитала на таргета
  if (!CFG.RATIO && CFG.TARGET_CAPITAL === 'auto' && accountValue > 0) RATIO = MY_CAP / accountValue;

  // ignore логика: махаме монета от ignore, щом таргетът я затвори
  for (const c of [...ignored]) if (!tgt[c]) { ignored.delete(c); log(`↺ ${c} вече може да се копира`); }

  // желани позиции
  const desired = {};
  for (const [coin, s] of Object.entries(tgt)) {
    if (ignored.has(coin) || CFG.COIN_BLACKLIST.includes(coin)) continue;
    if (coin.includes(':') && !coin.startsWith('xyz:')) continue;  // Propr поддържа само xyz: HIP-3
    desired[coin] = s * RATIO;
  }

  // марджин проверка: ако Propr лимитите (5x BTC/ETH, 2x др.) не стигат — мащабира надолу
  let marginNeed = 0;
  for (const [coin, q] of Object.entries(desired)) marginNeed += Math.abs(q) * (Number(mids[coin]) || 0) / maxLev(coin);
  const budget = MY_CAP * CFG.MARGIN_SAFETY;
  const scale = marginNeed > budget ? budget / marginNeed : 1;
  if (scale < 1) {
    log(`⚠ нужен марджин $${marginNeed.toFixed(0)} > $${budget.toFixed(0)} — мащаб ${(scale * 100).toFixed(1)}%`);
    for (const c in desired) desired[c] *= scale;
  }

  const coins = new Set([...Object.keys(desired), ...Object.keys(mine)]);
  for (const coin of coins) {
    if (cooldown[coin] > Date.now()) continue;
    if (ignored.has(coin) || CFG.COIN_BLACKLIST.includes(coin)) continue;
    const px = Number(mids[coin]);
    if (!px) continue;

    const d = desired[coin] || 0;
    const { long: L = 0, short: S = 0 } = mine[coin] || {};
    const dec = szDecimals[coin] ?? 4;
    let acted = false;

    try {
      // 1) затвори грешната страна (flip или таргетът затвори)
      if (d <= 0 && L > 0 && (d < 0 || L * px >= 1)) {
        await marketOrder(coin, 'sell', 'long', L, true, true); bookPaper(coin, 'long', -L); acted = true;
      }
      if (d >= 0 && S > 0 && (d > 0 || S * px >= 1)) {
        await marketOrder(coin, 'buy', 'short', S, true, true); bookPaper(coin, 'short', -S); acted = true;
      }

      // 2) доведи правилната страна до желаното
      if (d !== 0) {
        const side = d > 0 ? 'long' : 'short';
        const cur = side === 'long' ? L : S;
        const want = Math.abs(d);
        const diff = want - cur;
        const diffQty = roundDown(diff, dec);
        const bigEnough = diffQty * px >= CFG.MIN_ORDER_USD;
        const pctChange = cur > 0 ? Math.abs(diff) / want * 100 : 100;
        if (bigEnough && pctChange >= CFG.MIN_CHANGE_PCT) {
          if (diff > 0) {
            await marketOrder(coin, side === 'long' ? 'buy' : 'sell', side, diffQty, false);
            bookPaper(coin, side, diffQty);
          } else {
            await marketOrder(coin, side === 'long' ? 'sell' : 'buy', side, diffQty, true);
            bookPaper(coin, side, -diffQty);
          }
          acted = true;
        } else if (diff > 0 && !bigEnough && cur === 0) {
          log(`· ${coin}: желано $${(want * px).toFixed(2)} < MIN_ORDER_USD — пропуск`);
          cooldown[coin] = Date.now() + 60_000;
        }
      }
    } catch (e) {
      log(`❌ ${coin}:`, e.message);
      acted = true;
    }
    if (acted) cooldown[coin] = Date.now() + CFG.COOLDOWN_MS;
  }
}

function bookPaper(coin, side, dq) {
  if (!CFG.DRY_RUN) return;
  paper[coin] ??= { long: 0, short: 0 };
  paper[coin][side] = Math.max(0, paper[coin][side] + dq);
  if (!paper[coin].long && !paper[coin].short) delete paper[coin];
}

// ───────────────────────── main ─────────────────────────
async function main() {
  log(`Propr copy bot  |  target ${CFG.TARGET}  |  ${CFG.DRY_RUN ? 'DRY RUN (без реални ордери)' : 'LIVE'}`);
  await loadMeta();
  const startBal = await setupPropr();
  log(`Propr account: ${ACCOUNT_ID}  (startingBalance: ${startBal ?? 'n/a'})`);

  MY_CAP = CFG.MY_CAPITAL === 'auto' ? startBal : Number(CFG.MY_CAPITAL);
  if (!MY_CAP) throw new Error('Не мога да определя MY_CAPITAL — задай го ръчно в .env');

  const { pos, accountValue } = await getTargetPositions();
  if (CFG.RATIO) RATIO = Number(CFG.RATIO);
  else if (CFG.TARGET_CAPITAL === 'auto') RATIO = MY_CAP / accountValue;
  else RATIO = MY_CAP / Number(CFG.TARGET_CAPITAL);

  log(`Капитал: мой $${MY_CAP}  |  таргет $${accountValue.toFixed(0)} (live)  |  RATIO ${RATIO.toFixed(5)} (1:${(1 / RATIO).toFixed(1)})`);
  log(`Таргет позиции: ${Object.entries(pos).map(([c, s]) => `${c} ${s}`).join(', ') || 'няма'}`);

  if (CFG.IGNORE_EXISTING_POSITIONS) {
    for (const c of Object.keys(pos)) ignored.add(c);
    log(`Игнорирам съществуващите: ${[...ignored].join(', ') || '—'}`);
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await syncOnce(); } catch (e) { log('⚠ loop:', e.message); }
    finally { running = false; }
  };
  await tick();
  setInterval(tick, CFG.POLL_MS);
}

process.on('SIGINT', () => { log('Стоп.'); process.exit(0); });
main().catch(e => { console.error(e); process.exit(1); });
