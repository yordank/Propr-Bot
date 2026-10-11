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
  // margin   = марджинът е в съотношение, лостът = лоста на таргета (ограничен от Propr)
  // notional = размерът на позицията е в съотношение, лостът = максимума на Propr
  SIZE_MODE: env('SIZE_MODE', 'margin'),

  DEXES: env('DEXES', ',xyz').split(','),                // '' = основни perps, 'xyz' = акции/стоки
  POLL_MS: Number(env('POLL_MS', 3000)),
  MIN_ORDER_USD: Number(env('MIN_ORDER_USD', 11)),       // под това не праща ордер
  MIN_CHANGE_PCT: Number(env('MIN_CHANGE_PCT', 5)),      // разлика под X% от желаната позиция се пренебрегва
  COOLDOWN_MS: Number(env('COOLDOWN_MS', 8000)),         // пауза за актив след ордер
  MARGIN_SAFETY: Number(env('MARGIN_SAFETY', 0.85)),     // колко от капитала може да е зает марджин
  IGNORE_EXISTING_POSITIONS: bool('IGNORE_EXISTING_POSITIONS', 'false'),
  COIN_BLACKLIST: env('COIN_BLACKLIST', '').split(',').map(s => s.trim()).filter(Boolean),
  DRY_RUN: bool('DRY_RUN', 'true'),

  // копиране на чакащите limit ордери (Open Orders) на таргета
  MIRROR_ORDERS: bool('MIRROR_ORDERS', 'true'),
  ORDERS_POLL_MS: Number(env('ORDERS_POLL_MS', 9000)),   // HL лимит: ордерите са "тежка" заявка
  MIRROR_CANCEL_ON_START: bool('MIRROR_CANCEL_ON_START', 'true'),  // изчисти старите ни ордери при старт
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
  const lev = {};
  for (const dex of CFG.DEXES) {
    const st = await hl(dex ? { type: 'clearinghouseState', user: CFG.TARGET, dex }
                            : { type: 'clearinghouseState', user: CFG.TARGET });
    accountValue += Number(st.marginSummary.accountValue);
    for (const { position: p } of st.assetPositions) {
      const s = Number(p.szi);
      if (s !== 0) { pos[p.coin] = s; lev[p.coin] = Number(p.leverage?.value) || 1; }
    }
  }
  targetLev = lev;
  return { pos, accountValue, lev };
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
  const all = [];
  const PAGE = 20;   // същото като официалното SDK
  for (let offset = 0; offset < 1000; offset += PAGE) {
    const res = await propr('GET', `/accounts/${ACCOUNT_ID}/positions?status=open&limit=${PAGE}&offset=${offset}`);
    const page = res.data || [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  const out = {};
  for (const p of all) {
    const q = Number(p.quantity);
    if (!q) continue;
    out[p.asset] ??= { long: 0, short: 0 };
    out[p.asset][p.positionSide] += q;
  }
  return out;
}

// Реалният лост на всяка монета в Propr. Без кодиране на пътя — като официалното SDK.
const actualLev = {};          // coin -> лост, потвърден от Propr
const levRetryAt = {};         // coin -> кога да опитаме пак при грешка
async function ensureLeverage(coin) {
  if (CFG.DRY_RUN) return;
  const want = wantLev(coin);
  if (actualLev[coin] === want) return;
  if (levRetryAt[coin] > Date.now()) return;
  let c;
  try {
    const cfg = await propr('GET', `/accounts/${ACCOUNT_ID}/margin-config/${coin}`);
    c = cfg.data || cfg;
    actualLev[coin] = Number(c.leverage) || 1;
  } catch (e) {
    levRetryAt[coin] = Date.now() + 60_000;
    log(`⚠ ${coin} margin-config:`, e.message);
    return;
  }
  if (actualLev[coin] === want && c.marginMode === 'cross') return;

  // опитай желания лост; ако Propr откаже — по-нисък (някои монети имат лимит под обявения)
  let lastErr;
  for (let lev = want; lev >= 1; lev--) {
    if (lev === actualLev[coin] && c.marginMode === 'cross') break;   // вече сме на най-доброто възможно
    try {
      await propr('PUT', `/accounts/${ACCOUNT_ID}/margin-config/${c.configId}`,
        { exchange: 'hyperliquid', asset: coin, marginMode: 'cross', leverage: lev });
      actualLev[coin] = lev;
      log(`⚙ ${coin}: leverage ${lev}x cross${lev < want ? ` (Propr не прие ${want}x)` : ''}`);
      return;
    } catch (e) { lastErr = e; }
  }
  levRetryAt[coin] = Date.now() + 10 * 60_000;   // опитай пак след 10 мин
  if (lastErr) log(`⚠ ${coin}: лостът остава ${actualLev[coin]}x —`, lastErr.message);
}
// желан лост: в margin режим = лоста на таргета, но не повече от лимита на Propr
let targetLev = {};
const orderLev = {};   // coin -> лост на таргета за монети, където има само ордер (без позиция)
const tLevOf = coin => targetLev[coin] ?? orderLev[coin];
function wantLev(coin) {
  if (CFG.SIZE_MODE === 'margin' && tLevOf(coin)) return Math.min(tLevOf(coin), maxLev(coin));
  return maxLev(coin);
}
// лост за сметката на марджина: реалният, ако го знаем
const levOf = coin => (CFG.DRY_RUN ? wantLev(coin) : (actualLev[coin] ?? 1));

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

// ───────────────────────── Open Orders (limit) ─────────────────────────
// За всеки чакащ limit ордер на таргета държим един наш ордер в Propr:
//   размер = оставащото количество на таргета × k (k = същото съотношение като позициите)
// Ако нашият се изпълни първи, позицията НЕ се затваря — чакаме и неговия ("ahead").
const mirrors = new Map();     // oid -> { oid, coin, side, positionSide, reduceOnly, px, tSz0, carried, orderId, qty, filled, open, goneAt }
const settleUntil = {};        // coin -> ms: след промяна в ордерите на таргета изчакваме снимките да се изравнят
const orderRetryAt = {};       // oid -> ms
let tOrdersCache = [], tOrdersAt = 0, lastTgtPos = {};

async function getTargetOrders() {
  const out = [];
  for (const dex of CFG.DEXES) {
    const list = await hl(dex ? { type: 'frontendOpenOrders', user: CFG.TARGET, dex }
                              : { type: 'frontendOpenOrders', user: CFG.TARGET });
    out.push(...list);
  }
  return out;
}

async function getMyOpenOrders() {
  const map = new Map();
  for (const status of ['open', 'partially_filled', 'pending']) {
    for (let offset = 0; offset < 500; offset += 20) {
      const res = await propr('GET', `/accounts/${ACCOUNT_ID}/orders?status=${status}&limit=20&offset=${offset}`);
      const page = res.data || [];
      for (const o of page) map.set(o.orderId, o);
      if (page.length < 20) break;
    }
  }
  return map;
}

async function getOrder(orderId) {
  const res = await propr('GET', `/accounts/${ACCOUNT_ID}/orders?orderId=${encodeURIComponent(orderId)}&limit=1`);
  return (res.data || [])[0] || null;
}

const OPEN_ST = ['pending', 'open', 'partially_filled'];

/** отказва наш ордер; връща крайното изпълнено количество */
async function cancelMirror(r, why) {
  if (!r.open) return;
  r.open = false;
  if (CFG.DRY_RUN) { log(`🧪 DRY CANCEL ${r.coin} limit ${r.side} ${r.qty} @ ${r.px} (${why})`); return; }
  try {
    const res = await propr('POST', `/accounts/${ACCOUNT_ID}/orders/${r.orderId}/cancel`);
    const o = res?.data?.[0] ?? res?.data ?? res;
    if (o?.cumulativeQuantity !== undefined) r.filled = Number(o.cumulativeQuantity) || 0;
    log(`✖ ${r.coin}: отказан limit ${r.side} ${r.qty} @ ${r.px} (${why})`);
  } catch (e) {
    // 400 = вече изпълнен/отказан
    const o = await getOrder(r.orderId).catch(() => null);
    if (o) r.filled = Number(o.cumulativeQuantity) || 0;
  }
}

async function placeMirror(r, qty) {
  const dec = szDecimals[r.coin] ?? 4;
  const qtyStr = qty.toFixed(dec);
  const tag = `${r.coin}: limit ${r.side.toUpperCase()} ${qtyStr} @ ${r.px} (${r.positionSide}${r.reduceOnly ? ', reduce' : ''})`;
  r.qty = Number(qtyStr); r.filled = 0; r.open = true;
  if (CFG.DRY_RUN) { r.orderId = 'dry-' + r.oid; log(`🧪 DRY 📌 ${tag}`); return; }
  await ensureLeverage(r.coin);
  const res = await propr('POST', `/accounts/${ACCOUNT_ID}/orders`, {
    orders: [{
      accountId: ACCOUNT_ID, intentId: ulid(), exchange: 'hyperliquid',
      type: 'limit', side: r.side, positionSide: r.positionSide, productType: 'perp', timeInForce: 'GTC',
      asset: r.coin, base: r.coin, quote: 'USDC', quantity: qtyStr, price: String(r.px),
      reduceOnly: r.reduceOnly, closePosition: false,
    }],
  });
  const o = res?.data?.[0];
  r.orderId = o?.orderId;
  if (!r.orderId) { r.open = false; throw new Error('няма orderId в отговора'); }
  log(`📌 ${tag} → ${o.status}`);
}

/** колко сме "напред" спрямо таргета по ордерите на тази монета (нето, + = long) */
function aheadNet(coin, tMap, kOf) {
  let net = 0;
  for (const r of mirrors.values()) {
    if (r.coin !== coin) continue;
    const t = tMap.get(r.oid);
    const tFilled = r.tSz0 - (t ? Number(t.sz) : 0);   // изчезнал ордер = приемаме, че е изпълнен
    const a = r.carried + r.filled - kOf(coin) * tFilled;
    if (a > 0) net += (r.side === 'buy' ? 1 : -1) * a;
  }
  return net;
}
function aheadOf(r, t, k) {
  return Math.max(0, r.carried + r.filled - k * (r.tSz0 - (t ? Number(t.sz) : 0)));
}

/** обнови статуса на нашите ордери (изпълнени ли са) */
async function refreshMirrorFills() {
  const live = [...mirrors.values()].filter(r => r.open && r.orderId);
  if (!live.length || CFG.DRY_RUN) return;
  const myOpen = await getMyOpenOrders();
  for (const r of live) {
    let o = myOpen.get(r.orderId);
    if (!o) o = await getOrder(r.orderId).catch(() => null);
    if (!o) continue;
    r.filled = Number(o.cumulativeQuantity) || 0;
    if (!OPEN_ST.includes(o.status)) {
      r.open = false;
      if (r.filled > 0) log(`🎯 ${r.coin}: limit ${r.side} @ ${r.px} изпълнен (${r.filled})`);
      else log(`· ${r.coin}: limit ${r.side} @ ${r.px} → ${o.status}`);
    }
  }
}

/** поддържа нашите ордери = ордерите на таргета × k */
async function syncOrders(tOrders, tMap, tgt, kOf) {
  const now = Date.now();

  // 1) ордери, които таргетът вече няма → отказваме нашия; записа пазим 5 сек.
  for (const r of [...mirrors.values()]) {
    if (tMap.has(r.oid)) continue;
    if (!r.goneAt) {
      r.goneAt = now;
      settleUntil[r.coin] = now + 5000;
      await cancelMirror(r, 'таргетът го няма');
    } else if (now - r.goneAt > 5000) mirrors.delete(r.oid);
  }

  // 2) нови / променени ордери
  for (const t of tOrders) {
    if (t.isTrigger || t.orderType !== 'Limit') continue;        // TP/SL не копираме — позицията се хваща от синхронизацията
    const coin = t.coin;
    if (ignored.has(coin) || CFG.COIN_BLACKLIST.includes(coin)) continue;
    if (coin.includes(':') && !coin.startsWith('xyz:')) continue;
    if (szDecimals[coin] === undefined) continue;
    if (orderRetryAt[t.oid] > now) continue;
    const k = kOf(coin);
    if (!k) continue;

    const side = t.side === 'B' ? 'buy' : 'sell';
    const dir = side === 'buy' ? 1 : -1;
    const tPos = tgt[coin] || 0;
    const reduce = !!t.reduceOnly || (tPos !== 0 && Math.sign(tPos) !== dir);
    if (reduce && tPos === 0) continue;
    const positionSide = reduce ? (dir > 0 ? 'short' : 'long') : (dir > 0 ? 'long' : 'short');
    const px = t.limitPx;
    const dec = szDecimals[coin];

    let r = mirrors.get(t.oid);
    const prevSz = r ? r.lastTSz : null;
    if (r && prevSz !== undefined && Number(t.sz) !== prevSz) settleUntil[coin] = now + 5000;   // частично изпълнен

    const ahead = r ? aheadOf(r, t, k) : 0;
    const wantRem = roundDown(Math.max(0, k * Number(t.sz) - ahead), dec);
    const curRem = r && r.open ? Math.max(0, r.qty - r.filled) : 0;
    const okSize = wantRem * Number(px) >= CFG.MIN_ORDER_USD;

    try {
      if (!r) {
        r = { oid: t.oid, coin, side, positionSide, reduceOnly: reduce, px, tSz0: Number(t.sz), carried: 0,
              orderId: null, qty: 0, filled: 0, open: false, goneAt: null, lastTSz: Number(t.sz) };
        mirrors.set(t.oid, r);
        if (!okSize) { log(`· ${coin}: limit ${side} @ ${px} → $${(wantRem * Number(px)).toFixed(2)} < MIN_ORDER_USD — пропуск`); continue; }
        await placeMirror(r, wantRem);
        continue;
      }
      r.lastTSz = Number(t.sz);

      const pxChanged = String(r.px) !== String(px);
      const diff = Math.abs(wantRem - curRem);
      const sizeChanged = diff * Number(px) >= CFG.MIN_ORDER_USD && diff / Math.max(wantRem, curRem, 1e-12) * 100 >= CFG.MIN_CHANGE_PCT;
      if (!pxChanged && !sizeChanged && r.positionSide === positionSide) continue;

      // смяна: откажи стария, запази колко сме напред, сложи нов
      await cancelMirror(r, pxChanged ? 'нова цена' : 'нов размер');
      r.carried = aheadOf(r, t, k);
      r.tSz0 = Number(t.sz); r.filled = 0; r.qty = 0;
      r.px = px; r.side = side; r.positionSide = positionSide; r.reduceOnly = reduce;
      const rem = roundDown(Math.max(0, k * Number(t.sz) - r.carried), dec);
      if (rem * Number(px) >= CFG.MIN_ORDER_USD) await placeMirror(r, rem);
    } catch (e) {
      log(`❌ ${coin} limit ${side} @ ${px}:`, e.message);
      orderRetryAt[t.oid] = now + (e.message.includes('insufficient_balance') ? 60_000 : 5 * 60_000);
    }
  }
}

async function cancelAllMyOrders() {
  const open = await getMyOpenOrders();
  for (const o of open.values()) {
    try { await propr('POST', `/accounts/${ACCOUNT_ID}/orders/${o.orderId}/cancel`); } catch {}
  }
  if (open.size) log(`✖ отказани ${open.size} стари ордера в Propr`);
}

// ───────────────────────── sync ─────────────────────────
let RATIO = 0, MY_CAP = 0;
const ignored = new Set();         // IGNORE_EXISTING_POSITIONS
const cooldown = {};               // coin -> until ms
const paper = {};                  // DRY_RUN виртуални позиции { coin: { long, short } }
let lastScalePct = 100;

async function syncOnce() {
  const [{ pos: tgt, accountValue }, mids] = await Promise.all([getTargetPositions(), getMids()]);
  const mine = CFG.DRY_RUN ? paper : await getMyPositions();

  // ордерите на таргета: на всеки ORDERS_POLL_MS, или веднага щом се промени позиция с наш ордер
  let tOrders = tOrdersCache;
  if (CFG.MIRROR_ORDERS) {
    const mirrorCoins = new Set([...mirrors.values()].map(r => r.coin));
    const posMoved = [...mirrorCoins].some(c => (tgt[c] || 0) !== (lastTgtPos[c] || 0));
    if (posMoved || Date.now() - tOrdersAt >= CFG.ORDERS_POLL_MS) {
      tOrders = tOrdersCache = await getTargetOrders();
      tOrdersAt = Date.now();
    }
    lastTgtPos = { ...tgt };
    await refreshMirrorFills();
    // лост на таргета за монети само с ордер (нужен в margin режим)
    if (CFG.SIZE_MODE === 'margin') {
      for (const c of new Set(tOrders.map(o => o.coin))) {
        if (targetLev[c] || orderLev[c]) continue;
        try { orderLev[c] = Number((await hl({ type: 'activeAssetData', user: CFG.TARGET, coin: c })).leverage?.value) || 1; }
        catch { orderLev[c] = 1; }
      }
    }
  }
  const tMap = new Map(tOrders.filter(o => !o.isTrigger && o.orderType === 'Limit').map(o => [o.oid, o]));

  // при auto target capital — ratio следва капитала на таргета
  if (!CFG.RATIO && CFG.TARGET_CAPITAL === 'auto' && accountValue > 0) RATIO = MY_CAP / accountValue;

  // ignore логика: махаме монета от ignore, щом таргетът я затвори
  for (const c of [...ignored]) if (!tgt[c]) { ignored.delete(c); log(`↺ ${c} вече може да се копира`); }

  // желани позиции
  const desired = {};
  for (const [coin, s] of Object.entries(tgt)) {
    if (ignored.has(coin) || CFG.COIN_BLACKLIST.includes(coin)) continue;
    if (coin.includes(':') && !coin.startsWith('xyz:')) continue;  // Propr поддържа само xyz: HIP-3
    // margin режим: марджин = марджин_таргет × RATIO, с лост min(таргет, Propr)
    //   → размер = s × RATIO × (нашия лост / неговия лост)
    desired[coin] = s * RATIO;
  }

  // първо настрой лоста (5x BTC/ETH, 2x др.), после смятай с реалния лост
  for (const coin of Object.keys(desired)) await ensureLeverage(coin);
  // margin режим: размерът се смята с реалния лост в Propr, за да е марджинът точно в съотношение
  if (CFG.SIZE_MODE === 'margin') {
    for (const coin of Object.keys(desired)) desired[coin] *= levOf(coin) / (targetLev[coin] || 1);
  }

  // марджин проверка: ако капиталът не стига — мащабира всички позиции надолу еднакво
  let marginNeed = 0;
  for (const [coin, q] of Object.entries(desired)) marginNeed += Math.abs(q) * (Number(mids[coin]) || 0) / levOf(coin);
  const budget = MY_CAP * CFG.MARGIN_SAFETY;
  const scale = marginNeed > budget ? budget / marginNeed : 1;
  if (scale < 1) {
    const pct = Math.round(scale * 100);
    if (pct !== lastScalePct) {
      log(`⚠ нужен марджин $${marginNeed.toFixed(0)} > $${budget.toFixed(0)} — позициите са намалени до ${pct}%`);
      lastScalePct = pct;
    }
    for (const c in desired) desired[c] *= scale;
  } else lastScalePct = 100;

  // k = колко от таргета копираме за тази монета (за ордерите)
  const kOf = coin => {
    if (tgt[coin] && desired[coin] !== undefined) return desired[coin] / tgt[coin];
    const adj = CFG.SIZE_MODE === 'margin' ? levOf(coin) / (tLevOf(coin) || 1) : 1;
    return RATIO * adj * scale;
  };

  // ако наш limit се е изпълнил преди неговия — не го затваряме
  const ahead = {};
  if (CFG.MIRROR_ORDERS) for (const r of mirrors.values()) ahead[r.coin] ??= aheadNet(r.coin, tMap, kOf);

  const coins = new Set([...Object.keys(desired), ...Object.keys(mine), ...Object.keys(ahead)]);
  for (const coin of coins) {
    if (cooldown[coin] > Date.now()) continue;
    if (settleUntil[coin] > Date.now()) continue;
    if (ignored.has(coin) || CFG.COIN_BLACKLIST.includes(coin)) continue;
    const px = Number(mids[coin]);
    if (!px) continue;

    const d = (desired[coin] || 0) + (ahead[coin] || 0);
    const { long: L = 0, short: S = 0 } = mine[coin] || {};
    const why = `таргет ${tgt[coin] ?? 0} → желано ${+d.toFixed(6)}${ahead[coin] ? ` (вкл. ${+ahead[coin].toFixed(6)} от limit)` : ''}, имам long ${L} / short ${S}`;
    const dec = szDecimals[coin] ?? 4;
    let acted = false;

    try {
      // 1) затвори грешната страна (flip или таргетът затвори)
      if (d <= 0 && L > 0 && (d < 0 || L * px >= 1)) {
        log(`↪ ${coin}: ${why}`);
        await marketOrder(coin, 'sell', 'long', L, true, true); bookPaper(coin, 'long', -L); acted = true;
      }
      if (d >= 0 && S > 0 && (d > 0 || S * px >= 1)) {
        log(`↪ ${coin}: ${why}`);
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
          log(`↪ ${coin}: ${why}`);
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
      if (e.message.includes('insufficient_balance')) {
        cooldown[coin] = Date.now() + 60_000;   // не спами — опитай пак след минута
        continue;
      }
    }
    if (acted) cooldown[coin] = Date.now() + CFG.COOLDOWN_MS;
  }

  if (CFG.MIRROR_ORDERS) await syncOrders(tOrders, tMap, tgt, kOf);
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
  log(`Таргет позиции: ${Object.entries(pos).map(([c, s]) => `${c} ${s} (${targetLev[c]}x → ${wantLev(c)}x)`).join(', ') || 'няма'}`);
  log(`Режим: ${CFG.SIZE_MODE === 'margin' ? 'марджин в съотношение, лост като таргета (до лимита на Propr)' : 'размер в съотношение, максимален лост'}`);

  if (CFG.MIRROR_ORDERS) {
    log(`Open Orders: копират се limit ордерите на таргета (на всеки ${CFG.ORDERS_POLL_MS / 1000}s)`);
    if (CFG.MIRROR_CANCEL_ON_START && !CFG.DRY_RUN) await cancelAllMyOrders();
  }

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
