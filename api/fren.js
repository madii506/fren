'use strict';
/*
 * fren — launch a coin on Stonk.fun and route its creator fees to an X handle.
 *
 * One serverless function behind /api/*. Every coin gets its own launch wallet, derived from
 * FREN_MASTER_SEED, which is the pool's creator on Raydium LaunchLab. Stonk.fun adopts the pool
 * and forwards the creator share of the 1% curve fee to that wallet. /api/settle pays the balance
 * out: FREN_SPLIT_BPS to the fren (the X handle's linked wallet), the rest to FREN_TREASURY.
 *
 * The fren chain: up to three X handles. Fren 1 has 7 days from launch to sign in with X and link
 * a wallet; if they don't, fren 2 gets the next 7 days, then fren 3. If nobody shows, the fees go
 * back to the wallet that launched the coin.
 */
const crypto = require('crypto');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, TransactionInstruction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const nacl = require('tweetnacl');

const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const STONK = 'https://www.stonkfun.xyz/api/public/v1';
const MEMO_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const WSOL = 'So11111111111111111111111111111111111111112';
const T22 = spl.TOKEN_2022_PROGRAM_ID.toBase58();
const FUND_LAMPORTS = 50_000_000;      // 0.05 SOL: rent + fees for the launch, the rest is refunded
const GAS_RESERVE = 10_000_000;        // 0.01 SOL stays in the coin wallet to pay payout fees
const WINDOW_MS = 7 * 86400 * 1000;    // each fren's window to sign in
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const LL_DISC = Buffer.from('25be7ede2c9aab11', 'hex'); // LaunchLab initialize_with_token2022

/* ---------------- small helpers ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const httpErr = (s, m) => new HttpError(s, m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const site = () => (E('SITE_URL') || ('https://' + (E('VERCEL_PROJECT_PRODUCTION_URL') || E('VERCEL_URL') || 'localhost'))).replace(/\/$/, '');
const splitBps = () => Math.min(10000, Math.max(0, parseInt(E('FREN_SPLIT_BPS', '8000'), 10) || 0));
const isKey = v => { try { return typeof v === 'string' && new PublicKey(v).toBase58() === v; } catch (e) { return false; } };
const clean = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const newId = () => crypto.randomBytes(6).toString('hex');

/* ---------------- keys ---------------- */
function master() {
  const s = E('FREN_MASTER_SEED');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw httpErr(503, 'the launch wallet key is not configured on the server yet');
  return Buffer.from(s, 'hex');
}
const derive = (tag, id) => Keypair.fromSeed(crypto.createHmac('sha256', master()).update(`fren:${tag}:${id}`).digest());
const deployerFor = id => derive('deployer', id);
const mintFor = id => derive('mint', id);

/* ---------------- storage (Vercel Blob, write-once records) ---------------- */
let _blob;
function blob() {
  if (!E('BLOB_READ_WRITE_TOKEN')) throw httpErr(503, 'storage is not connected yet');
  return _blob || (_blob = require('@vercel/blob'));
}
async function putJSON(path, obj) {
  listCache.clear();
  await blob().put(path, JSON.stringify(obj), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
}
// list() is a metered API call, so listings are cached per instance; single records are read straight from the CDN
const listCache = new Map();
async function listBlobs(prefix, ttl = 20000) {
  const hit = listCache.get(prefix);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const out = []; let cursor;
  do { const r = await blob().list({ prefix, cursor, limit: 1000 }); out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  listCache.set(prefix, { t: Date.now(), v: out });
  return out;
}
const storeBase = () => { blob(); const id = E('BLOB_READ_WRITE_TOKEN').split('_')[3] || ''; return `https://${id.toLowerCase()}.public.blob.vercel-storage.com/`; };
async function fetchJSON(url) { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? r.json().catch(() => null) : null; }
async function getJSON(path, fresh = true) {
  return fetchJSON(storeBase() + path + (fresh ? '?v=' + Math.floor(Date.now() / 10000) : ''));
}

/* ---------------- chain ---------------- */
const rpcs = () => [E('SOLANA_RPC'), 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean);
async function withConn(fn) {
  let last;
  for (const u of rpcs()) { try { return await fn(new Connection(u, 'confirmed')); } catch (e) { if (e instanceof HttpError) throw e; last = e; } }
  throw httpErr(502, 'solana rpc unavailable: ' + ((last && last.message) || 'unknown'));
}
function memoIx(text, signer) {
  return new TransactionInstruction({ programId: MEMO_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });
}
async function sendTx(c, tx, signers, waitMs = 40000) {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  let sig;
  try { sig = await c.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); }
  catch (e) { const logs = (e.logs || []).slice(-6).join(' | '); throw httpErr(502, 'transaction rejected: ' + (e.message || e) + (logs ? ' · ' + logs : '')); }
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const st = (await c.getSignatureStatuses([sig])).value[0];
    if (st && st.err) throw httpErr(502, 'transaction failed on chain: ' + JSON.stringify(st.err) + ' · ' + sig);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    if ((await c.getBlockHeight('confirmed')) > lastValidBlockHeight) break;
    await sleep(1500);
  }
  throw httpErr(504, 'sent but not confirmed yet, check solscan: ' + sig);
}

/* ---------------- Stonk.fun ---------------- */
const cache = new Map();
async function stonk(path, ttl = 0) {
  const hit = cache.get(path);
  if (ttl && hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(STONK + path, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status === 404 ? 404 : 502, 'stonk.fun: ' + ((j.error && j.error.message) || r.status));
  if (ttl) cache.set(path, { t: Date.now(), v: j.data });
  return j.data;
}
function normPair(p) {
  const logo = p.logoUrl || p.logo || '';
  return {
    mint: p.mint, symbol: p.symbol || '', name: p.name || p.symbol || '', category: p.category || 'custom', categoryLabel: p.categoryLabel || p.category || 'Custom',
    decimals: p.decimals, tokenProgram: p.tokenProgram || '', logo: logo && logo[0] === '/' ? 'https://www.stonkfun.xyz' + logo : logo,
  };
}
async function launchablePairs() {
  const d = await stonk('/pairs?launchable=true&launchLabReady=true', 60000);
  return (Array.isArray(d) ? d : (d && d.pairs) || []).map(normPair).filter(p => isKey(p.mint));
}

/* ---------------- Raydium LaunchLab: initialize_with_token2022 ---------------- */
function launchIx(o) {
  const pid = o.programId;
  const pda = seeds => PublicKey.findProgramAddressSync(seeds, pid)[0];
  const auth = pda([Buffer.from('vault_auth_seed')]);
  const pool = pda([Buffer.from('pool'), o.mint.toBuffer(), o.quoteMint.toBuffer()]);
  const vaultA = pda([Buffer.from('pool_vault'), pool.toBuffer(), o.mint.toBuffer()]);
  const vaultB = pda([Buffer.from('pool_vault'), pool.toBuffer(), o.quoteMint.toBuffer()]);
  const eventAuth = pda([Buffer.from('__event_authority')]);
  const str = s => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const data = Buffer.concat([
    LL_DISC, Buffer.from([o.decimals]), str(o.name), str(o.symbol), str(o.uri),
    Buffer.from([0]), u64(o.supply), u64(o.totalSellA), u64(o.totalFundRaisingB), Buffer.from([1]),   // constant curve → cpmm
    u64(0), u64(0), u64(0), Buffer.from([o.cpmmCreatorFeeOn]), Buffer.from([0]), Buffer.alloc(2), u64(0), // no vesting, no transfer fee
  ]);
  const k = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
  const keys = [
    k(o.payer, true, true), k(o.creator), k(o.configId), k(o.platformId), k(auth), k(pool, false, true),
    k(o.mint, true, true), k(o.quoteMint), k(vaultA, false, true), k(vaultB, false, true),
    k(spl.TOKEN_2022_PROGRAM_ID), k(o.quoteTokenProgram), k(SystemProgram.programId), k(eventAuth), k(pid),
  ];
  if (o.curveRule) keys.push(k(o.curveRule)); // platform curve rule, last and read-only
  return { ix: new TransactionInstruction({ programId: pid, keys, data }), pool };
}

/* ---------------- routing: the fren chain ---------------- */
async function linkOf(handle) { return getJSON(`links/${handle.toLowerCase()}.json`); }
async function resolveRoute(rec, live, now = Date.now()) {
  const t0 = live.launchedAt;
  for (let i = 0; i < rec.handles.length; i++) {
    const h = rec.handles[i], start = t0 + i * WINDOW_MS, end = t0 + (i + 1) * WINDOW_MS;
    const link = await linkOf(h);
    if (link && link.linkedAt <= end && isKey(link.wallet)) return { kind: 'fren', index: i, handle: h, wallet: link.wallet, since: Math.max(start, Math.min(link.linkedAt, end)) };
    if (now < end) return { kind: 'waiting', index: i, handle: h, from: start, until: end };
  }
  return { kind: 'sender', index: rec.handles.length, wallet: rec.launcher, since: t0 + rec.handles.length * WINDOW_MS };
}

/* ---------------- records ---------------- */
async function coinRecord(id) {
  const rec = await getJSON(`launch/${id}.json`);
  if (!rec) return null;
  const live = await getJSON(`live/${id}.json`);
  return { rec, live };
}
function publicCoin(rec, live) {
  return {
    id: rec.id, name: rec.name, symbol: rec.symbol, description: rec.description, image: rec.image, meta: rec.meta,
    quote: { mint: rec.quoteMint, symbol: rec.quoteSymbol, name: rec.quoteName, decimals: rec.quoteDecimals, category: rec.category, program: rec.quoteProgram, logo: rec.quoteLogo || '' },
    handles: rec.handles, launcher: rec.launcher, deployer: rec.deployer, mint: rec.mint, createdAt: rec.createdAt,
    status: live ? 'live' : 'awaiting_launch', launchedAt: live ? live.launchedAt : null, launchSig: live ? live.launchSig : null, pool: live ? live.pool : null,
  };
}
async function payoutsFor(prefix, limit = 50) {
  const bl = (await listBlobs(prefix)).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, limit);
  return (await Promise.all(bl.map(b => fetchJSON(b.url)))).filter(Boolean);
}

/* ---------------- handlers ---------------- */
async function config() {
  const ok = f => { try { f(); return true; } catch (e) { return false; } };
  return {
    site: site(), storage: !!E('BLOB_READ_WRITE_TOKEN'), wallet: ok(master), x: !!(E('X_CLIENT_ID') && E('X_CLIENT_SECRET')),
    treasury: isKey(E('FREN_TREASURY')) ? E('FREN_TREASURY') : null, splitBps: splitBps(), fundLamports: FUND_LAMPORTS,
    gasReserveLamports: GAS_RESERVE, windowDays: 7, maxFrens: 3, venue: 'stonk.fun', callback: site() + '/api/auth/x/callback',
  };
}

async function prepare(body) {
  const name = clean(body.name, 32), symbol = clean(body.symbol, 10).replace(/^\$/, '').toUpperCase(), description = clean(body.description, 280);
  const handles = (Array.isArray(body.handles) ? body.handles : []).map(h => clean(h, 16).replace(/^@/, '')).filter(Boolean);
  if (!name) throw httpErr(400, 'give the coin a name');
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw httpErr(400, 'ticker: letters and numbers, up to 10');
  if (!handles.length || handles.length > 3) throw httpErr(400, 'name one to three frens');
  if (handles.some(h => !HANDLE.test(h))) throw httpErr(400, 'X handles are letters, numbers and _, up to 15');
  if (new Set(handles.map(h => h.toLowerCase())).size !== handles.length) throw httpErr(400, 'each fren once');
  if (!isKey(body.launcher)) throw httpErr(400, 'connect the wallet that launches');
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
  if (!m) throw httpErr(400, 'add a PNG, JPEG, WebP or GIF image');
  const img = Buffer.from(m[3], 'base64');
  if (img.length > 1_000_000) throw httpErr(400, 'image must be under 1 MB');
  const pair = (await launchablePairs()).find(p => p.mint === body.quoteMint);
  if (!pair) throw httpErr(409, 'that pair is not launchable on stonk.fun right now');
  master(); blob();

  const id = newId(), dep = deployerFor(id).publicKey.toBase58(), mint = mintFor(id).publicKey.toBase58();
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const put = await blob().put(`img/${id}.${ext}`, img, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: m[1] });
  const metaObj = {
    name, symbol, description: description || `Fees routed to @${handles[0]} via fren.`, image: put.url, showName: true,
    createdOn: site(), website: `${site()}/#/coin/${id}`, twitter: `https://x.com/${handles[0]}`,
  };
  const metaPut = await blob().put(`meta/${id}.json`, JSON.stringify(metaObj), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  const rec = {
    id, name, symbol, description, image: put.url, meta: metaPut.url, quoteMint: pair.mint, quoteSymbol: pair.symbol, quoteName: pair.name,
    quoteDecimals: pair.decimals, quoteProgram: pair.tokenProgram === T22 ? T22 : spl.TOKEN_PROGRAM_ID.toBase58(), category: pair.categoryLabel, quoteLogo: pair.logo,
    handles, launcher: body.launcher, deployer: dep, mint, createdAt: Date.now(),
  };
  await putJSON(`launch/${id}.json`, rec);
  return { id, deployer: dep, mint, fundLamports: FUND_LAMPORTS, coin: publicCoin(rec, null) };
}

async function execute(id) {
  const got = await coinRecord(id);
  if (!got) throw httpErr(404, 'no such launch');
  if (got.live) return { already: true, coin: publicCoin(got.rec, got.live) };
  const rec = got.rec, dep = deployerFor(id), mintKp = mintFor(id);
  return withConn(async c => {
    let launchSig = null;
    const pricing = await stonk('/launchlab/pricing?quoteMint=' + rec.quoteMint);
    const quoteMint = new PublicKey(rec.quoteMint), programId = new PublicKey(pricing.curve.programId);
    const built = launchIx({
      programId, payer: dep.publicKey, creator: dep.publicKey, configId: new PublicKey(pricing.curve.configId),
      platformId: new PublicKey(pricing.platform.standard), mint: mintKp.publicKey, quoteMint,
      quoteTokenProgram: new PublicKey(rec.quoteProgram), decimals: Number(pricing.curve.baseDecimals ?? 6),
      name: rec.name, symbol: rec.symbol, uri: rec.meta, supply: pricing.curve.supply, totalSellA: pricing.curve.totalSellA,
      totalFundRaisingB: pricing.raise.raw, cpmmCreatorFeeOn: Number(pricing.curve.cpmmCreatorFeeOn || 0),
      curveRule: pricing.curveRule && pricing.curveRule.standard ? new PublicKey(pricing.curveRule.standard) : null,
    });
    const already = await c.getAccountInfo(mintKp.publicKey);
    if (!already) {
      const bal = await c.getBalance(dep.publicKey);
      if (bal < FUND_LAMPORTS - 10000) throw httpErr(409, `the coin wallet holds ${(bal / 1e9).toFixed(4)} SOL. send ${FUND_LAMPORTS / 1e9} SOL to ${dep.publicKey.toBase58()} first`);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
        built.ix,
      );
      launchSig = await sendTx(c, tx, [dep, mintKp]);
    }
    // the coin is live: record it first, so a timeout below can't lose it
    const live = { id, mint: mintKp.publicKey.toBase58(), pool: built.pool.toBase58(), launchSig, refundSig: null, launchedAt: Date.now() };
    await putJSON(`live/${id}.json`, live);
    // refund what the launch didn't use, keep a little for payout fees
    try {
      const left = await c.getBalance(dep.publicKey);
      const back = left - GAS_RESERVE - 10000;
      if (back > 0) live.refundSig = await sendTx(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: new PublicKey(rec.launcher), lamports: back }), memoIx(`fren|v1|refund|${id}`, dep.publicKey)), [dep], 12000);
    } catch (e) { live.refundSig = null; }
    if (live.refundSig) await putJSON(`live/${id}.json`, live).catch(() => {});
    return { coin: publicCoin(rec, live), launchSig, refundSig: live.refundSig };
  });
}

// the launcher's wallet signs this: 0.05 SOL from the launcher to the coin's launch wallet, with a memo
async function fundTx(id) {
  const got = await coinRecord(id);
  if (!got) throw httpErr(404, 'no such launch');
  if (got.live) throw httpErr(409, 'this coin is already live');
  const rec = got.rec, from = new PublicKey(rec.launcher), to = new PublicKey(rec.deployer);
  return withConn(async c => {
    const have = await c.getBalance(to);
    const need = Math.max(0, FUND_LAMPORTS - have);
    if (need === 0) return { funded: true, lamports: have };
    const { blockhash } = await c.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: need }),
      memoIx(`fren|v1|fund|${id}`, from),
    );
    return { funded: false, lamports: need, tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') };
  });
}
// for wallets that can sign but not send: relay a fully signed transaction
async function relay(body) {
  let tx;
  try { tx = Transaction.from(Buffer.from(String(body.tx || ''), 'base64')); } catch (e) { throw httpErr(400, 'bad transaction'); }
  if (!tx.verifySignatures()) throw httpErr(400, 'transaction is not fully signed');
  if (!tx.instructions.some(i => i.programId.equals(MEMO_ID) && /^fren\|v1\|/.test(i.data.toString('utf8')))) throw httpErr(400, 'only fren transactions are relayed');
  return withConn(async c => {
    let sig;
    try { sig = await c.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); } catch (e) { throw httpErr(502, 'transaction rejected: ' + (e.message || e)); }
    return { sig };
  });
}

async function refund(id) {
  const got = await coinRecord(id);
  if (!got) throw httpErr(404, 'no such launch');
  if (got.live) throw httpErr(409, 'this coin is live. its wallet now holds fees, which settle to the fren');
  const dep = deployerFor(id), mintKp = mintFor(id);
  return withConn(async c => {
    if (await c.getAccountInfo(mintKp.publicKey)) throw httpErr(409, 'the coin was launched. run launch again to finish it');
    const bal = await c.getBalance(dep.publicKey);
    const back = bal - 5000;
    if (back <= 0) throw httpErr(409, 'nothing to refund');
    const sig = await sendTx(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: new PublicKey(got.rec.launcher), lamports: back })), [dep]);
    return { sig, lamports: back };
  });
}

async function balances(c, rec) {
  const dep = new PublicKey(rec.deployer), quoteMint = new PublicKey(rec.quoteMint);
  const prog = new PublicKey(rec.quoteProgram);
  const ata = spl.getAssociatedTokenAddressSync(quoteMint, dep, true, prog);
  const sol = await c.getBalance(dep);
  let raw = '0', decimals = rec.quoteDecimals || 0;
  try { const b = await c.getTokenAccountBalance(ata); raw = b.value.amount; decimals = b.value.decimals; } catch (e) {}
  const native = rec.quoteMint === WSOL ? Math.max(0, sol - GAS_RESERVE - 3_000_000) : 0;
  return { sol, ata: ata.toBase58(), raw, decimals, native };
}

async function settle(id) {
  const got = await coinRecord(id);
  if (!got || !got.live) throw httpErr(404, 'no live coin with that id');
  const { rec, live } = got;
  const route = await resolveRoute(rec, live);
  if (route.kind === 'waiting') return { paid: false, route, reason: `waiting for @${route.handle} to sign in with X` };
  const treasury = E('FREN_TREASURY');
  if (!isKey(treasury)) return { paid: false, route, reason: 'the treasury wallet is not set yet, so nothing is paid out' };
  const dep = deployerFor(id), to = new PublicKey(route.wallet), tre = new PublicKey(treasury);
  const quoteMint = new PublicKey(rec.quoteMint), prog = new PublicKey(rec.quoteProgram);
  return withConn(async c => {
    const bal = await balances(c, rec);
    const amt = BigInt(bal.raw), nat = BigInt(bal.native);
    if (amt === 0n && nat === 0n) return { paid: false, route, reason: 'no fees waiting in the coin wallet' };
    const bps = BigInt(splitBps());
    let need = 200_000;
    if (amt > 0n) for (const o of [to, tre]) if (!(await c.getAccountInfo(spl.getAssociatedTokenAddressSync(quoteMint, o, true, prog)))) need += 2_600_000;
    if (bal.sol < need) return { paid: false, route, reason: `the coin wallet needs ${(need / 1e9).toFixed(4)} SOL for network fees and token accounts. anyone can top it up: ${rec.deployer}` };
    const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 })];
    const out = { fren: '0', treasury: '0', nativeFren: '0', nativeTreasury: '0' };
    if (amt > 0n) {
      const f = amt * bps / 10000n, t = amt - f;
      const src = new PublicKey(bal.ata);
      const toAta = spl.getAssociatedTokenAddressSync(quoteMint, to, true, prog), treAta = spl.getAssociatedTokenAddressSync(quoteMint, tre, true, prog);
      if (f > 0n) { ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(dep.publicKey, toAta, to, quoteMint, prog)); ixs.push(spl.createTransferCheckedInstruction(src, quoteMint, toAta, dep.publicKey, f, bal.decimals, [], prog)); }
      if (t > 0n) { ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(dep.publicKey, treAta, tre, quoteMint, prog)); ixs.push(spl.createTransferCheckedInstruction(src, quoteMint, treAta, dep.publicKey, t, bal.decimals, [], prog)); }
      out.fren = f.toString(); out.treasury = t.toString();
    }
    if (nat > 0n) {
      const f = nat * bps / 10000n, t = nat - f;
      if (f > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: to, lamports: f }));
      if (t > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: tre, lamports: t }));
      out.nativeFren = f.toString(); out.nativeTreasury = t.toString();
    }
    ixs.push(memoIx(`fren|v1|pay|${id}|${route.kind === 'fren' ? '@' + route.handle : 'sender'}`, dep.publicKey));
    const sig = await sendTx(c, new Transaction().add(...ixs), [dep]);
    const payout = {
      id, mint: live.mint, name: rec.name, symbol: rec.symbol, sig, at: Date.now(), kind: route.kind, handle: route.kind === 'fren' ? route.handle : null,
      to: to.toBase58(), treasury: tre.toBase58(), token: rec.quoteSymbol, tokenMint: rec.quoteMint, decimals: bal.decimals, splitBps: Number(bps), ...out,
    };
    await putJSON(`pay/${id}/${sig}.json`, payout);
    return { paid: true, route, payout };
  });
}

async function coinDetail(id) {
  const got = await coinRecord(id);
  if (!got) throw httpErr(404, 'no such coin');
  const { rec, live } = got;
  const out = { coin: publicCoin(rec, live), route: null, wallet: null, market: null, payouts: [] };
  const jobs = [];
  if (live) {
    jobs.push(resolveRoute(rec, live).then(r => { out.route = r; }));
    jobs.push(stonk('/tokens/' + live.mint, 30000).then(m => { out.market = m; }).catch(() => { out.market = null; }));
    jobs.push(payoutsFor(`pay/${id}/`).then(p => { out.payouts = p; }));
  }
  jobs.push(withConn(c => balances(c, rec)).then(b => { out.wallet = b; }).catch(() => { out.wallet = null; }));
  await Promise.all(jobs);
  return out;
}

async function coins() {
  const lives = await listBlobs('live/');
  const rows = await Promise.all(lives.map(async b => {
    const live = await fetchJSON(b.url); if (!live) return null;
    const rec = await getJSON(`launch/${live.id}.json`); if (!rec) return null;
    return publicCoin(rec, live);
  }));
  return rows.filter(Boolean).sort((a, b) => b.launchedAt - a.launchedAt);
}

/* ---------------- sessions + Sign in with X (OAuth 2.0 PKCE) ---------------- */
const sessionKey = () => E('FREN_SESSION_SECRET') || crypto.createHmac('sha256', master()).update('fren:session').digest('hex');
function signTok(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', sessionKey()).update(p).digest('base64url'); }
function readTok(v) {
  if (!v || typeof v !== 'string' || v.indexOf('.') < 0) return null;
  const [p, s] = v.split('.');
  const want = crypto.createHmac('sha256', sessionKey()).update(p).digest('base64url');
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(x => { const i = x.indexOf('='); if (i > 0) o[x.slice(0, i).trim()] = decodeURIComponent(x.slice(i + 1).trim()); }); return o; }
const setCookie = (name, val, maxAge) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function xReady() { if (!E('X_CLIENT_ID') || !E('X_CLIENT_SECRET')) throw httpErr(503, 'sign in with X is not connected yet'); }
function authStart(res) {
  xReady();
  const state = crypto.randomBytes(16).toString('hex'), verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: E('X_CLIENT_ID'), redirect_uri: site() + '/api/auth/x/callback', scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256' });
  res.setHeader('Set-Cookie', setCookie('fren_oauth', signTok({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }), 600));
  res.statusCode = 302; res.setHeader('Location', 'https://x.com/i/oauth2/authorize?' + q.toString()); res.end();
}
async function authCallback(req, res) {
  xReady();
  const q = req.query || {}, ck = readTok(cookies(req).fren_oauth);
  const back = (msg) => { res.statusCode = 302; res.setHeader('Location', site() + '/#/claim' + (msg ? '?error=' + encodeURIComponent(msg) : '')); res.end(); };
  if (q.error) return back('X said: ' + q.error);
  if (!ck || !q.state || ck.state !== q.state || !q.code) return back('sign in expired, try again');
  const tok = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(E('X_CLIENT_ID') + ':' + E('X_CLIENT_SECRET')).toString('base64') },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(q.code), redirect_uri: site() + '/api/auth/x/callback', code_verifier: ck.verifier, client_id: E('X_CLIENT_ID') }).toString(),
  }).then(r => r.json()).catch(() => ({}));
  if (!tok.access_token) return back('X did not return a token' + (tok.error_description ? ': ' + tok.error_description : ''));
  const me = await fetch('https://api.x.com/2/users/me', { headers: { authorization: 'Bearer ' + tok.access_token } }).then(r => r.json()).catch(() => ({}));
  if (!me.data || !me.data.username) return back('X did not return your account' + (me.title ? ': ' + me.title : ''));
  res.setHeader('Set-Cookie', [setCookie('fren_oauth', '', 0), setCookie('fren_sess', signTok({ xId: me.data.id, username: me.data.username, name: me.data.name || '', exp: Date.now() + 2 * 3600 * 1000 }), 7200)]);
  return back('');
}
const session = req => readTok(cookies(req).fren_sess);
const linkMessage = (username, wallet, ts) => `fren: link @${username} to ${wallet}\nissued ${ts}`;

async function me(req) {
  const s = session(req);
  const cfg = { x: !!(E('X_CLIENT_ID') && E('X_CLIENT_SECRET')) };
  if (!s) return { user: null, ...cfg };
  const link = await linkOf(s.username).catch(() => null);
  const all = await coins().catch(() => []);
  const mine = all.filter(c => c.handles.some(h => h.toLowerCase() === s.username.toLowerCase()));
  const payouts = link ? (await payoutsFor('pay/', 200)).filter(p => p.handle && p.handle.toLowerCase() === s.username.toLowerCase()) : [];
  return { user: { username: s.username, name: s.name, xId: s.xId }, link, coins: mine, payouts, ...cfg };
}
async function linkWallet(req, body) {
  const s = session(req);
  if (!s) throw httpErr(401, 'sign in with X first');
  const wallet = String(body.wallet || ''), ts = Number(body.ts), sig = String(body.signature || '');
  if (!isKey(wallet)) throw httpErr(400, 'connect a Solana wallet');
  if (!(Math.abs(Date.now() - ts) < 10 * 60 * 1000)) throw httpErr(400, 'that signature is stale, sign again');
  const msg = linkMessage(s.username, wallet, ts);
  let ok = false;
  try { ok = nacl.sign.detached.verify(Buffer.from(msg, 'utf8'), Buffer.from(sig, 'base64'), new PublicKey(wallet).toBytes()); } catch (e) { ok = false; }
  if (!ok) throw httpErr(400, 'the wallet signature does not match');
  const prev = await linkOf(s.username).catch(() => null);
  const link = { handle: s.username, xId: s.xId, wallet, linkedAt: prev && prev.xId === s.xId ? prev.linkedAt : Date.now(), updatedAt: Date.now(), message: msg, signature: sig };
  await putJSON(`links/${s.username.toLowerCase()}.json`, link);
  return { link };
}

/* ---------------- router ---------------- */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > 3e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
}
function json(res, status, obj, edge = 0) {
  res.statusCode = status; res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', status === 200 && edge ? `public, s-maxage=${edge}, stale-while-revalidate=${edge * 3}` : 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  req.query = Object.assign(Object.fromEntries(url.searchParams), req.query || {});
  const path = String(req.query.__p || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  const M = req.method;
  try {
    if (path === 'config' && M === 'GET') return json(res, 200, await config());
    if (path === 'pairs' && M === 'GET') return json(res, 200, { pairs: await launchablePairs() }, 60);
    if (path === 'coins' && M === 'GET') return json(res, 200, { coins: await coins() }, 15);
    if (path === 'coin' && M === 'GET') return json(res, 200, await coinDetail(String(req.query.id || '')), 5);
    if (path === 'ledger' && M === 'GET') return json(res, 200, { payouts: await payoutsFor('pay/', 100) }, 15);
    if (path === 'launch/prepare' && M === 'POST') return json(res, 200, await prepare(await readBody(req)));
    if (path === 'launch/execute' && M === 'POST') return json(res, 200, await execute(String((await readBody(req)).id || '')));
    if (path === 'launch/fund-tx' && M === 'POST') return json(res, 200, await fundTx(String((await readBody(req)).id || '')));
    if (path === 'relay' && M === 'POST') return json(res, 200, await relay(await readBody(req)));
    if (path === 'launch/refund' && M === 'POST') return json(res, 200, await refund(String((await readBody(req)).id || '')));
    if (path === 'settle' && M === 'POST') return json(res, 200, await settle(String((await readBody(req)).id || '')));
    if (path === 'cron' && M === 'GET') {
      if (E('CRON_SECRET') && req.headers.authorization !== 'Bearer ' + E('CRON_SECRET')) return json(res, 401, { error: 'unauthorized' });
      const out = [];
      for (const c of await coins()) { try { out.push({ id: c.id, ...(await settle(c.id)) }); } catch (e) { out.push({ id: c.id, error: e.message }); } }
      return json(res, 200, { settled: out });
    }
    if (path === 'auth/x/start' && M === 'GET') return authStart(res);
    if (path === 'auth/x/callback' && M === 'GET') return await authCallback(req, res);
    if (path === 'me' && M === 'GET') return json(res, 200, await me(req));
    if (path === 'link' && M === 'POST') return json(res, 200, await linkWallet(req, await readBody(req)));
    if (path === 'logout' && M === 'POST') { res.setHeader('Set-Cookie', setCookie('fren_sess', '', 0)); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json(res, status, { error: e.message || String(e) });
  }
};
module.exports._test = { storeBase, launchIx, resolveRoute, deployerFor, mintFor, linkMessage, signTok, readTok, splitBps, normPair, LL_DISC };
module.exports.config = { maxDuration: 60 };
