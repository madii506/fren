'use strict';
/* fren — frontend. Everything shown here comes from /api (Stonk.fun, Solana and fren's own records). */
const CFG = { CA: '', X_URL: '' }; // $FREN contract + X account, set at launch
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a, n = 4) => a ? a.slice(0, n) + '…' + a.slice(-n) : '';
const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const solscan = (x, kind = 'tx') => `https://solscan.io/${kind}/${x}`;
const stonkUrl = m => `https://www.stonkfun.xyz/token/${m}`;
const xUrl = h => `https://x.com/${encodeURIComponent(h)}`;
const DAY = 86400000;

function ago(t) { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }
function left(t) { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
const day = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function amt(raw, dec, max = 4) {
  try {
    const b = BigInt(raw || '0'), d = BigInt(10) ** BigInt(dec || 0), whole = b / d, frac = (b % d).toString().padStart(dec || 0, '0');
    let f = frac.slice(0, whole > 0n ? max : Math.max(max, frac.search(/[1-9]/) + 3)).replace(/0+$/, '');
    return whole.toLocaleString() + (f ? '.' + f : '');
  } catch (e) { return '—'; }
}
const sol = l => amt(String(l || 0), 9, 4);

/* ---------- api ---------- */
async function api(path, body) {
  if (!body && S.bust && Date.now() - S.bust < 90000) path += (path.includes('?') ? '&' : '?') + 'b=' + S.bust; // skip the edge cache right after an action
  const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: 'bad response (' + r.status + ')' }));
  if (!r.ok) { const e = new Error(j.error || 'request failed'); e.status = r.status; throw e; }
  return j;
}
const S = { cfg: null, pairs: null, coins: null, ledger: null, me: null, bust: 0 };
async function load(k, fn, force) { if (!force && S[k]) return S[k]; try { S[k] = await fn(); } catch (e) { S[k] = null; throw e; } return S[k]; }
const getCfg = f => load('cfg', () => api('config'), f);
const getPairs = f => load('pairs', () => api('pairs').then(j => j.pairs), f);
const getCoins = f => load('coins', () => api('coins').then(j => j.coins), f);
const getLedger = f => load('ledger', () => api('ledger').then(j => j.payouts), f);

/* ---------- ui bits ---------- */
let toastT;
function toast(html, bad) { let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); } t.className = 'toast' + (bad ? ' bad' : ''); t.innerHTML = html; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6500); }
function openModal(html) { $('#mcard').innerHTML = '<button class="mx" data-act="close" aria-label="close">×</button>' + html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#mcard').innerHTML = ''; }
const markSvg = (c = '') => `<svg class="mark ${c}"><use href="#mark"/></svg>`;
const av = (c, lg) => `<span class="av${lg ? ' lg' : ''}">${c && c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : esc(((c && c.symbol) || '?').slice(0, 2))}</span>`;
const qchip = q => `<span class="pill">${q.logo ? `<img class="qlogo" src="${esc(q.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}${esc(q.symbol)}${q.category ? ` · <span class="dim">${esc(q.category)}</span>` : ''}</span>`;
const usd = n => n == null ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toFixed(2);
const pct = n => n == null ? '' : `<span class="${n >= 0 ? 'up' : 'dn'}">${n >= 0 ? '+' : ''}${n.toFixed(1)}%</span>`;
const getTop = (sort = 'mcap') => load('top_' + sort, () => api('top' + (sort === 'mcap' ? '' : '?sort=' + sort)).then(j => j.tokens));
const tkCard = t => `<a class="tk" href="${stonkUrl(t.mint)}" target="_blank" rel="noopener"><img src="${esc(t.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><div class="grow"><b>$${esc(t.symbol)}</b><small>${esc(t.name)}${t.quote ? ' · ' + esc(t.quote.symbol) : ''}</small></div><div class="r"><b>${usd(t.mcap)}</b>${pct(t.change)}</div></a>`;
const empty = (b, s) => `<div class="empty"><b>${b}</b>${s}</div>`;

/* the fren chain, computed the same way the server does it (the server is what pays) */
function chainView(c, route) {
  const t0 = c.launchedAt, W = 7 * DAY, rows = [];
  c.handles.forEach((h, i) => {
    const from = t0 + i * W, until = t0 + (i + 1) * W;
    let st = 'next', note = `window ${day(from)} → ${day(until)}`;
    if (route) {
      if (route.kind === 'fren' && route.index === i) { st = 'on'; note = 'signed in · fees route here'; }
      else if (route.index > i) { st = 'skip'; note = 'did not sign in within 7 days'; }
      else if (route.kind === 'waiting' && route.index === i) { st = 'on'; note = `has ${left(until)} left to sign in with X`; }
    }
    rows.push(`<div class="link ${st === 'on' ? 'on' : st === 'skip' ? 'skip' : ''}"><span class="n">${i + 1}</span><div><a class="h" href="${xUrl(h)}" target="_blank" rel="noopener">@${esc(h)}</a><small>${esc(note)}</small></div>${st === 'on' ? (route.kind === 'fren' ? '<span class="pill live"><span class="dot"></span>paid</span>' : '<span class="pill wait"><span class="dot"></span>waiting</span>') : ''}</div>`);
  });
  const back = route && route.kind === 'sender';
  rows.push(`<div class="link ${back ? 'on' : ''}"><span class="n">↩</span><div><span class="h">back to the launcher</span><small>${back ? 'no fren signed in, fees go back to ' + esc(short(c.launcher)) : 'only if no fren signs in'}</small></div>${back ? '<span class="pill live"><span class="dot"></span>paid</span>' : ''}</div>`);
  return `<div class="chain">${rows.join('')}</div>`;
}
function routeLine(c, route) {
  if (c.status !== 'live') return '<span class="pill">not launched yet</span>';
  if (!route) return '<span class="pill">…</span>';
  if (route.kind === 'fren') return `<span class="pill live"><span class="dot"></span>@${esc(route.handle)}</span>`;
  if (route.kind === 'waiting') return `<span class="pill wait"><span class="dot"></span>waiting on @${esc(route.handle)}</span>`;
  return '<span class="pill">back to launcher</span>';
}
function localRoute(c) { // list view hint only (links are not in the list); the coin page shows the real route
  if (c.status !== 'live') return null;
  const i = Math.floor((Date.now() - c.launchedAt) / (7 * DAY));
  return i < c.handles.length ? { kind: 'waiting', index: i, handle: c.handles[i] } : { kind: 'sender', index: c.handles.length };
}
function coinCard(c) {
  return `<a class="card coin" href="#/coin/${esc(c.id)}"><div class="top">${av(c)}<div style="min-width:0"><b>${esc(c.name)}</b><div class="muted">$${esc(c.symbol)}</div></div></div>
  <dl class="kv"><dt>Paired with</dt><dd>${esc(c.quote.symbol)} <span class="dim">${esc(c.quote.category || '')}</span></dd>
  <dt>Frens</dt><dd>${c.handles.map(h => '@' + esc(h)).join(' → ')}</dd>
  <dt>Launched</dt><dd>${c.launchedAt ? ago(c.launchedAt) : '—'}</dd>
  <dt>CA</dt><dd class="mono">${esc(short(c.mint))}</dd></dl></a>`;
}
function payRow(p) {
  const to = p.kind === 'fren' ? `@${esc(p.handle)}` : 'launcher';
  const n = p.fren !== '0' ? `${amt(p.fren, p.decimals)} ${esc(p.token)}` : `${sol(p.nativeFren)} SOL`;
  return `<div class="row"><span class="av">${markSvg()}</span><div class="grow"><b>${n} → ${to}</b><small>$${esc(p.symbol)} · ${ago(p.at)}</small></div><a class="btn sm" href="${solscan(p.sig)}" target="_blank" rel="noopener">tx ↗</a></div>`;
}

/* ---------- wallet ---------- */
const wallet = { pk: null, prov: null, name: null };
function providers() {
  const a = [], ph = window.phantom && window.phantom.solana;
  if (ph && ph.isPhantom) a.push({ name: 'Phantom', p: ph });
  if (window.solflare && window.solflare.isSolflare) a.push({ name: 'Solflare', p: window.solflare });
  if (window.backpack && window.backpack.isBackpack) a.push({ name: 'Backpack', p: window.backpack });
  if (!a.length && window.solana && window.solana.connect) a.push({ name: 'Wallet', p: window.solana });
  return a;
}
async function connectWith(x, silent) {
  try {
    const r = await x.p.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pk = (r && r.publicKey) || x.p.publicKey; if (!pk) throw new Error('no key');
    wallet.pk = pk.toString(); wallet.prov = x.p; wallet.name = x.name; LS.set('fren:w', x.name);
    if (x.p.on && !x.p.__fren) { x.p.__fren = true; x.p.on('accountChanged', k => { if (k) { wallet.pk = k.toString(); paintWallet(); route(); } else disconnect(true); }); }
    paintWallet();
    if (!silent) { closeModal(); toast('Connected · ' + short(wallet.pk)); if (wallet.after) { const f = wallet.after; wallet.after = null; f(); } else route(); }
    return true;
  } catch (e) { if (!silent) toast('Connection cancelled', true); return false; }
}
function disconnect(quiet) { try { wallet.prov && wallet.prov.disconnect && wallet.prov.disconnect(); } catch (e) {} wallet.pk = wallet.prov = wallet.name = null; LS.set('fren:w', null); paintWallet(); closeModal(); if (!quiet) toast('Disconnected'); route(); }
function paintWallet() { $('#wbtn').textContent = wallet.pk ? short(wallet.pk) : 'Connect'; }
function walletModal() {
  if (wallet.pk) return `<h3>Your wallet</h3><p class="muted">${esc(wallet.name)} · <code>${esc(short(wallet.pk, 6))}</code></p><button class="btn wal" data-act="copy" data-v="${esc(wallet.pk)}">Copy address</button><button class="btn wal" data-act="disconnect">Disconnect</button>`;
  const a = providers(), mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  return `<h3>Connect a wallet</h3><p class="muted">Solana only. Connecting signs nothing; every action asks your wallet on its own.</p>
  ${a.length ? a.map((x, i) => `<button class="btn wal" data-act="pick" data-i="${i}">${esc(x.name)}</button>`).join('') :
    `<p><b>No Solana wallet in this browser.</b></p>${mobile ? `<a class="btn sky wal" href="https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}">Open fren in Phantom</a>` : ''}
    <a class="btn wal" href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom ↗</a><a class="btn wal" href="https://solflare.com/download" target="_blank" rel="noopener">Get Solflare ↗</a>`}`;
}
function needWallet(then) { if (wallet.pk) return true; wallet.after = then || null; openModal(walletModal()); return false; }
async function signSend(b64) {
  const W = window.solanaWeb3; if (!W) throw new Error('wallet library still loading, try again in a second');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const tx = W.Transaction.from(bytes);
  if (wallet.prov.signAndSendTransaction) { const r = await wallet.prov.signAndSendTransaction(tx); return typeof r === 'string' ? r : r && r.signature; }
  const signed = await wallet.prov.signTransaction(tx);
  const raw = signed.serialize(); let s = ''; raw.forEach(b => { s += String.fromCharCode(b); });
  return (await api('relay', { tx: btoa(s) })).sig;
}
async function signText(text) {
  const r = await wallet.prov.signMessage(new TextEncoder().encode(text), 'utf8');
  const sig = r && r.signature ? r.signature : r; let s = ''; new Uint8Array(sig).forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}
const cancelled = e => /reject|cancel|denied|declined|closed/i.test((e && e.message) || '');

/* ---------- pages ---------- */
const V = {};
V.home = async el => {
  el.innerHTML = `
  <section class="hero">
    <div>
      <div class="kick">Built on Stonk</div>
      <h1>Launch on Stonk.<span>Pay a fren.</span></h1>
      <p>Launch a coin paired with any stock or token on Stonk.fun and name up to three X handles. The creator fees route to the first fren who signs in with X.</p>
      <div class="ctas"><a class="btn sky lg" href="#/launch">Launch a coin ↗</a><a class="btn lg" href="#/explore">Explore coins</a></div>
    </div>
    <div class="route">${routeArt()}<a class="chip" href="#/docs"><small>ROUTED BY FREN</small>Fees to an X handle ↗</a></div>
  </section>
  <div class="stats" id="stats">${['Coins launched', 'Payouts on-chain', 'Frens paid', 'Stonk pairs'].map(s => `<div class="card stat"><b>—</b><span>${s}</span></div>`).join('')}</div>
  <div class="card" style="margin-bottom:12px"><div class="kick">Browse Stonk</div><h3>What's trading on Stonk.fun right now</h3><div class="tabs" style="margin-top:12px" id="h-sort">${[['mcap', 'Top market cap'], ['volume', '24h volume'], ['newest', 'Newest']].map(([k, l], i) => `<button class="tab ${i ? '' : 'on'}" data-act="topsort" data-s="${k}">${l}</button>`).join('')}</div><div class="tgrid" id="h-top"><div class="empty">loading Stonk…</div></div></div>
  <div class="bento">
    <div class="card c7"><div class="kick">Latest coins</div><div class="feed" id="h-coins"><div class="empty">loading…</div></div></div>
    <div class="card c5"><div class="kick">Fee routing</div><h3>One coin. Up to three frens.</h3>
      <ol class="steps"><li><b>01</b><span><strong>Launch on Stonk.</strong> Pick a pair (xStocks, SOL, STONK and more). fren launches it on Raydium LaunchLab through Stonk.fun.</span></li>
      <li><b>02</b><span><strong>Name your frens.</strong> One to three X handles, in order. They're written into the coin: its X link points at fren 1.</span></li>
      <li><b>03</b><span><strong>Fees land in the coin wallet.</strong> Stonk forwards the creator share of every trade there automatically.</span></li>
      <li><b>04</b><span><strong>The fren signs in with X.</strong> They link a wallet and get paid 80%. Every payout is one Solana transaction.</span></li></ol></div>
    <div class="card c5"><div class="kick">The twist</div><h3>The fren chain</h3><p class="muted" style="margin:4px 0 0">Each fren gets 7 days to show up. Fren 1 first, then fren 2, then fren 3. Nobody shows? The fees go back to whoever launched. Nothing gets stuck on someone who will never claim.</p>
      <div class="chain">${['day 0–7', 'day 7–14', 'day 14–21'].map((d, i) => `<div class="link ${i ? '' : 'on'}"><span class="n">${i + 1}</span><div><span class="h">Fren ${i + 1}</span><small>${d}</small></div></div>`).join('')}<div class="link"><span class="n">↩</span><div><span class="h">back to the launcher</span><small>after day 21</small></div></div></div></div>
    <div class="card c7"><div class="kick">Recent payouts</div><div class="feed" id="h-pay"><div class="empty">loading…</div></div></div>
    <div class="card c12"><div class="kick">Paired with anything on Stonk</div><h3>Every launchable Stonk pair, live from Stonk.fun</h3><div class="cats" id="h-cats"><span class="muted">loading…</span></div></div>
  </div>`;
  const [coins, pay, pairs] = await Promise.all([getCoins(true).catch(() => null), getLedger(true).catch(() => null), getPairs().catch(() => null)]);
  const frens = pay ? new Set(pay.filter(p => p.kind === 'fren').map(p => p.handle.toLowerCase())).size : 0;
  const st = [coins && coins.length, pay && pay.length, frens, pairs && pairs.length];
  $('#stats').innerHTML = ['Coins launched', 'Payouts on-chain', 'Frens paid', 'Stonk pairs'].map((s, i) => `<div class="card stat"><b>${st[i] ? st[i].toLocaleString() : '—'}</b><span>${s}</span></div>`).join('');
  $('#h-coins').innerHTML = coins == null ? empty('Could not load coins.', 'Refresh in a moment.') : coins.length ? coins.slice(0, 5).map(c => `<a class="row" href="#/coin/${esc(c.id)}" style="text-decoration:none">${av(c)}<div class="grow"><b>${esc(c.name)} <span class="muted">$${esc(c.symbol)}</span></b><small>${esc(c.quote.symbol)} pair · frens ${c.handles.map(h => '@' + esc(h)).join(' → ')}</small></div><small>${ago(c.launchedAt)}</small></a>`).join('') : empty('No coins launched yet.', 'The first one lands here the moment it goes live. <a href="#/launch">Launch one →</a>');
  $('#h-pay').innerHTML = pay == null ? empty('Could not load payouts.', 'Refresh in a moment.') : pay.length ? pay.slice(0, 5).map(payRow).join('') : empty('No payouts yet.', 'Every payout is one Solana transaction with a <code>fren|v1|pay</code> memo. Each one lands here with its Solscan link.');
  paintTop('mcap');
  if (pairs) { const cats = {}; pairs.forEach(p => { cats[p.categoryLabel] = (cats[p.categoryLabel] || 0) + 1; }); $('#h-cats').innerHTML = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<a class="pill sky" href="#/launch" style="text-decoration:none">${esc(k)} <span class="dim">${n}</span></a>`).join(''); }
  else $('#h-cats').innerHTML = '<span class="muted">Stonk.fun did not answer, try again in a moment.</span>';
};
async function paintTop(sort) {
  const box = $('#h-top'); if (!box) return;
  document.querySelectorAll('#h-sort .tab').forEach(b => b.classList.toggle('on', b.dataset.s === sort));
  try { const t = await getTop(sort); if ($('#h-top') === box) box.innerHTML = t.length ? t.slice(0, 12).map(tkCard).join('') : empty('Stonk.fun returned no tokens.', 'Try again in a moment.'); }
  catch (e) { box.innerHTML = empty('Could not reach Stonk.fun.', esc(e.message)); }
}
function routeArt() {
  const H = ['Fren 1', 'Fren 2', 'Fren 3'], F = 'font-family="DM Sans,system-ui,sans-serif"';
  return `<svg viewBox="0 0 460 330" aria-hidden="true"><defs><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter></defs>
  <g fill="none" stroke-linecap="round">
  <path d="M96 165 C190 165 200 60 292 60" stroke="#8fdcf6" stroke-width="7" filter="url(#gl)" class="pulse"/>
  <path d="M96 165 C190 165 200 60 292 60" stroke="#090c11" stroke-width="2.4" class="flow"/>
  <path d="M96 165 C200 165 210 145 292 145" stroke="rgba(9,12,17,.22)" stroke-width="2" stroke-dasharray="3 7"/>
  <path d="M96 165 C190 165 200 230 292 230" stroke="rgba(9,12,17,.16)" stroke-width="2" stroke-dasharray="3 7"/>
  <path d="M96 165 C170 165 170 305 292 305" stroke="rgba(9,12,17,.1)" stroke-width="2" stroke-dasharray="3 7"/></g>
  <circle cx="62" cy="165" r="40" fill="#c0eefe" stroke="#ffffff" stroke-width="4"/><use href="#mark" x="37" y="140" width="50" height="50" color="#090c11"/>
  ${H.map((h, i) => { const y = [60, 145, 230][i]; return `<g><rect x="292" y="${y - 22}" width="164" height="44" rx="14" fill="#fff" fill-opacity="${i ? '.6' : '1'}" stroke="${i ? 'rgba(9,12,17,.1)' : '#090c11'}" stroke-width="${i ? 1 : 1.5}"/><text x="308" y="${y + 5}" fill="${i ? '#4a6672' : '#090c11'}" font-size="15" font-weight="600" ${F}>${h}</text><text x="444" y="${y + 5}" text-anchor="end" fill="${i ? '#6d8893' : '#0d8a5c'}" font-size="11" font-weight="600" ${F}>${i ? 'day ' + i * 7 + '+' : 'paid'}</text></g>`; }).join('')}
  <g><rect x="292" y="283" width="164" height="44" rx="14" fill="#fff" fill-opacity=".45" stroke="rgba(9,12,17,.08)"/><text x="308" y="310" fill="#6d8893" font-size="14" ${F}>↩ launcher</text></g></svg>`;
}

V.explore = async el => {
  el.innerHTML = `<div class="head"><div class="kick">Explore</div><h1>Coins routing to frens</h1><p>Every coin launched through fren, newest first. Open one to see where its fees go right now.</p></div>
  <div class="bar"><input class="in" id="q" placeholder="Search name, ticker, fren or pair" style="max-width:420px"></div><div class="grid" id="grid"><div class="load">loading…</div></div>`;
  let coins; try { coins = await getCoins(true); } catch (e) { $('#grid').innerHTML = empty('Could not load coins.', esc(e.message)); return; }
  const paint = () => {
    const q = $('#q').value.trim().toLowerCase().replace(/^[@$]/, '');
    const list = coins.filter(c => !q || [c.name, c.symbol, c.quote.symbol, c.mint, ...c.handles].some(v => String(v).toLowerCase().includes(q)));
    $('#grid').innerHTML = list.length ? list.map(coinCard).join('') : `<div class="card" style="grid-column:1/-1">${coins.length ? empty('Nothing matches.', 'Try a ticker or an X handle.') : empty('No coins launched yet.', 'Be the first. <a href="#/launch">Launch a coin →</a>')}</div>`;
  };
  $('#q').addEventListener('input', paint); paint();
};

/* ---------- launch ---------- */
const F = { name: '', symbol: '', description: '', handles: [''], image: null, quote: null, cat: 'All', q: '', ok: false };
V.launch = async el => {
  const cfg = await getCfg().catch(() => null);
  const ready = cfg && cfg.storage && cfg.wallet;
  el.innerHTML = `<div id="lp"><div class="head"><div class="kick">Launch</div><h1>Launch a coin. Pay a fren.</h1><p>Your coin launches on Stonk.fun (Raydium LaunchLab). Its creator fees route to the frens you name here.</p></div>
  ${ready ? '' : '<div class="note">Launching opens as soon as fren\'s launch wallet and storage are switched on. You can set up your coin below in the meantime.</div>'}
  <div class="launch"><div class="card">
    <div class="field"><span class="lbl">Image</span><label class="drop" for="img">${'<span class="av lg" id="imgpv">+</span>'}<div><b>Upload an image</b><div class="hint">PNG, JPEG, WebP or GIF. Square works best. It's resized to 512px.</div></div></label><input type="file" id="img" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div>
    <div class="two"><div class="field"><label for="nm">Name</label><input class="in" id="nm" maxlength="32" placeholder="Fren Coin"><span class="hint"><span id="nmc">0</span>/32</span></div>
    <div class="field"><label for="tk">Ticker</label><input class="in" id="tk" maxlength="10" placeholder="FREN"><span class="hint">Letters and numbers, up to 10</span></div></div>
    <div class="field"><label for="ds">Description <span class="hint">(optional)</span></label><textarea class="in" id="ds" maxlength="280" placeholder="What's the coin about?"></textarea></div>
    <div class="field"><span class="lbl">Frens · who the fees route to</span><div class="frens" id="frens"></div><span class="hint">Fren 1 gets the first 7 days to sign in with X, then fren 2, then fren 3. If none of them sign in, the fees come back to you.</span></div>
    <div class="field"><span class="lbl">Paired with</span><div class="tabs" id="cats"></div><input class="in" id="pq" placeholder="Search pairs: SPYX, TSLAX, SOL, STONK…" style="margin-bottom:8px"><div class="pairs" id="pairs"><div class="empty">loading Stonk pairs…</div></div></div>
    <label class="check"><input type="checkbox" id="ok"><span>I understand fren launches this coin from a coin wallet that fren controls. Stonk forwards the creator fees there, and fren pays them out: <b>${cfg ? cfg.splitBps / 100 : 80}%</b> to the fren who signs in with X, the rest to the fren treasury. I send 0.05 SOL to cover the launch and get back whatever it doesn't use.</span></label>
    <button class="btn sky lg full" id="go" disabled>Launch coin</button>
  </div>
  <div class="sticky"><div class="card preview" id="pv"></div></div></div></div>`;
  const root = $('#lp');
  const pend = LS.get('fren:pending');
  if (pend) $('.head').insertAdjacentHTML('afterend', `<div class="note sky">You have a launch that isn't live yet. <a href="#/coin/${esc(pend)}">Finish it here →</a></div>`);
  const frens = () => { $('#frens').innerHTML = F.handles.map((h, i) => `<div class="frow"><span class="n">${i + 1}</span><div class="at"><input class="in" data-h="${i}" maxlength="16" placeholder="${i ? 'backup fren (optional)' : 'their X handle'}" value="${esc(h)}"></div>${i ? `<button class="btn sm" data-act="rmfren" data-i="${i}">remove</button>` : F.handles.length < 3 ? '<button class="btn sm" data-act="addfren">+ fren</button>' : '<span></span>'}</div>`).join('') + (F.handles.length > 1 && F.handles.length < 3 ? '<div><button class="btn sm" data-act="addfren">+ another fren</button></div>' : ''); };
  frens();
  ['nm', 'tk', 'ds'].forEach(id => { const k = { nm: 'name', tk: 'symbol', ds: 'description' }[id]; $('#' + id).value = F[k]; });
  if (F.image) $('#imgpv').innerHTML = `<img src="${F.image}" alt="">`;
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'nm') F.name = t.value; if (t.id === 'tk') { t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); F.symbol = t.value; } if (t.id === 'ds') F.description = t.value;
    if (t.dataset.h != null) { t.value = t.value.replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, ''); F.handles[+t.dataset.h] = t.value; }
    if (t.id === 'pq') { F.q = t.value; paintPairs(); }
    if (t.id === 'ok') F.ok = t.checked;
    $('#nmc').textContent = F.name.length; paintPv();
  });
  root.addEventListener('change', async e => {
    if (e.target.id === 'ok') { F.ok = e.target.checked; paintPv(); }
    if (e.target.id === 'img' && e.target.files[0]) { try { F.image = await squash(e.target.files[0]); $('#imgpv').innerHTML = `<img src="${F.image}" alt="">`; paintPv(); } catch (er) { toast('Could not read that image', true); } }
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'addfren' && F.handles.length < 3) { F.handles.push(''); frens(); paintPv(); }
    if (b.dataset.act === 'rmfren') { F.handles.splice(+b.dataset.i, 1); frens(); paintPv(); }
    if (b.dataset.act === 'cat') { F.cat = b.dataset.c; paintPairs(); }
    if (b.dataset.act === 'pair') { F.quote = S.pairs.find(p => p.mint === b.dataset.m); paintPairs(); paintPv(); }
  });
  $('#go').addEventListener('click', () => runLaunch());
  let pairs = null;
  function paintPairs() {
    if (!pairs) return;
    const cats = {}; pairs.forEach(p => { cats[p.categoryLabel] = (cats[p.categoryLabel] || 0) + 1; });
    $('#cats').innerHTML = [['All', pairs.length], ...Object.entries(cats).sort((a, b) => b[1] - a[1])].map(([k, n]) => `<button class="tab ${F.cat === k ? 'on' : ''}" data-act="cat" data-c="${esc(k)}">${esc(k)} ${n}</button>`).join('');
    const q = F.q.trim().toLowerCase();
    const list = pairs.filter(p => (F.cat === 'All' || p.categoryLabel === F.cat) && (!q || (p.symbol + ' ' + p.name + ' ' + p.mint).toLowerCase().includes(q))).slice(0, 150);
    $('#pairs').innerHTML = list.length ? list.map(p => `<button class="pair ${F.quote && F.quote.mint === p.mint ? 'on' : ''}" data-act="pair" data-m="${esc(p.mint)}">${p.logo ? `<img class="qlogo" src="${esc(p.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="qlogo"></span>'}<b>${esc(p.symbol)}</b><span>${esc(p.name)}</span><em>${esc(p.categoryLabel)}</em></button>`).join('') : '<div class="empty">No pair matches.</div>';
  }
  function valid() {
    const hs = F.handles.map(h => h.trim()).filter(Boolean);
    return F.name.trim() && /^[A-Z0-9]{1,10}$/.test(F.symbol) && hs.length && hs.every(h => /^[A-Za-z0-9_]{1,15}$/.test(h)) && new Set(hs.map(h => h.toLowerCase())).size === hs.length && F.image && F.quote && F.ok;
  }
  function paintPv() {
    const hs = F.handles.filter(Boolean);
    $('#pv').innerHTML = `<div class="kick" style="margin-bottom:12px">Preview</div><div class="pv">${F.image ? `<span class="av lg"><img src="${F.image}" alt=""></span>` : `<span class="av lg">${esc((F.symbol || '?').slice(0, 2))}</span>`}<div style="min-width:0"><h2>${esc(F.name || 'Coin name')}</h2><div class="muted">$${esc(F.symbol || 'TICKER')}</div></div></div>
    <dl class="kv"><dt>Venue</dt><dd>Stonk.fun · LaunchLab</dd><dt>Paired with</dt><dd>${F.quote ? esc(F.quote.symbol) + ' <span class="dim">' + esc(F.quote.categoryLabel) + '</span>' : '<span class="muted">pick a pair</span>'}</dd><dt>X link on the coin</dt><dd>${hs[0] ? '@' + esc(hs[0]) : '—'}</dd><dt>Launch cost</dt><dd>0.05 SOL, unused part refunded</dd></dl>
    <div class="kick" style="margin:18px 0 0">Fees claimable by X</div>${hs.length ? `<div class="chain">${hs.map((h, i) => `<div class="link ${i ? '' : 'on'}"><span class="n">${i + 1}</span><div><span class="h">@${esc(h)}</span><small>${i ? `if @${esc(hs[i - 1])} hasn't signed in by day ${i * 7}` : 'first 7 days'}</small></div></div>`).join('')}<div class="link"><span class="n">↩</span><div><span class="h">back to you</span><small>if nobody signs in by day ${hs.length * 7}</small></div></div></div>` : '<p class="muted">Add at least one fren.</p>'}
    <div class="split"><i style="width:${cfg ? cfg.splitBps / 100 : 80}%"></i><u></u></div><small class="muted">${cfg ? cfg.splitBps / 100 : 80}% to the fren · ${cfg ? 100 - cfg.splitBps / 100 : 20}% to the fren treasury</small>`;
    $('#go').disabled = !(valid() && ready);
    $('#go').textContent = !ready ? 'Launching opens soon' : wallet.pk ? 'Launch coin' : 'Connect wallet & launch';
  }
  paintPv();
  try { pairs = await getPairs(); if (!F.quote) F.quote = pairs.find(p => p.symbol === 'SOL' && p.categoryLabel === 'Solana') || null; paintPairs(); paintPv(); }
  catch (e) { $('#pairs').innerHTML = empty('Could not load Stonk pairs.', esc(e.message)); }
};
function squash(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const n = 512, c = document.createElement('canvas'); c.width = c.height = n; const x = c.getContext('2d');
      const s = Math.min(img.width, img.height); x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n);
      let d = c.toDataURL('image/png'); if (d.length > 1.2e6) d = c.toDataURL('image/jpeg', .9);
      URL.revokeObjectURL(url); res(d);
    };
    img.onerror = rej; img.src = url;
  });
}
const STEPS = ['Connect wallet', 'Save coin + metadata', 'Fund the coin wallet (0.05 SOL)', 'Launch on Stonk.fun', 'Live'];
function prog(i, err) { return `<ol class="prog">${STEPS.map((s, k) => `<li class="${k < i ? 'done' : k === i ? (err ? 'err' : 'run') : ''}"><i>${k < i ? '✓' : k + 1}</i>${s}</li>`).join('')}</ol>${err ? `<p class="bad" style="margin:14px 0 0">${esc(err)}</p>` : ''}`;}
async function runLaunch() {
  if (!needWallet(runLaunch)) return;
  const hs = F.handles.map(h => h.trim()).filter(Boolean);
  const show = (i, err, extra = '') => openModal(`<h3>Launching $${esc(F.symbol)}</h3><p class="muted">Keep this open. Your wallet asks you once, to send 0.05 SOL.</p>${prog(i, err)}${extra}`);
  show(1);
  let prep;
  try { prep = await api('launch/prepare', { name: F.name.trim(), symbol: F.symbol, description: F.description.trim(), handles: hs, launcher: wallet.pk, image: F.image, quoteMint: F.quote.mint }); }
  catch (e) { return show(1, e.message, '<button class="btn full" data-act="close" style="margin-top:14px">Close</button>'); }
  LS.set('fren:pending', prep.id);
  await finishLaunch(prep.id, show);
}
async function finishLaunch(id, show) {
  show = show || ((i, err, extra = '') => openModal(`<h3>Finishing launch</h3>${prog(i, err)}${extra}`));
  const retry = `<div class="two" style="margin-top:14px"><a class="btn" href="#/coin/${esc(id)}" data-act="close">Coin page</a><button class="btn sky" data-act="finish" data-id="${esc(id)}">Try again</button></div>`;
  show(2);
  try {
    const f = await api('launch/fund-tx', { id });
    if (!f.funded) { const sig = await signSend(f.tx); if (!sig) throw new Error('the wallet did not send'); }
  } catch (e) { return show(2, cancelled(e) ? 'Cancelled in your wallet. Nothing was sent.' : e.message, retry); }
  show(3);
  let out = null, last = '';
  for (let k = 0; k < 20 && !out; k++) {
    try { out = await api('launch/execute', { id }); }
    catch (e) { last = e.message; if (e.status !== 409 || !/holds/.test(e.message)) break; await new Promise(r => setTimeout(r, 3000)); }
  }
  if (!out) return show(3, last || 'launch failed', retry);
  LS.set('fren:pending', null); S.coins = null; S.bust = Date.now();
  show(5, null, `<p style="margin:14px 0 0">$${esc(out.coin.symbol)} is live on Stonk.fun. ${out.launchSig ? `<a href="${solscan(out.launchSig)}" target="_blank" rel="noopener">Launch tx ↗</a>` : ''}</p><a class="btn sky full" style="margin-top:14px" href="#/coin/${esc(id)}" data-act="close">Open the coin page</a>`);
}

/* ---------- coin ---------- */
V.coin = async (el, id) => {
  el.innerHTML = '<div class="load">loading coin…</div>';
  let d; try { d = await api('coin?id=' + encodeURIComponent(id)); } catch (e) { el.innerHTML = `<div class="head"><h1>Coin not found</h1><p>${esc(e.message)}</p></div>`; return; }
  const cfg = await getCfg().catch(() => ({}));
  const c = d.coin, r = d.route, w = d.wallet, live = c.status === 'live';
  const fees = w ? amt(w.raw, w.decimals) : '—', hasFees = w && (BigInt(w.raw || '0') > 0n || w.native > 0);
  let why = '';
  if (!live) why = 'The coin is not live yet.';
  else if (r && r.kind === 'waiting') why = `Waiting for @${r.handle} to sign in with X (${left(r.until)} left). Fees keep collecting until then.`;
  else if (!cfg.treasury) why = 'Payouts switch on once the fren treasury wallet is set. Fees wait safely in the coin wallet until then.';
  else if (!hasFees) why = 'No fees waiting right now. Stonk forwards them as the coin trades.';
  const canSettle = live && !why;
  const tweet = r && (r.kind === 'waiting' || r.kind === 'fren') ? `https://x.com/intent/post?text=${encodeURIComponent(`@${r.handle} you're the fren on $${c.symbol}. its creator fees route to you, sign in with X to claim:`)}&url=${encodeURIComponent(location.origin + '/#/coin/' + c.id)}` : '';
  el.innerHTML = `<div class="chead">${av(c, 1)}<div style="min-width:0"><h1>${esc(c.name)} <span class="muted">$${esc(c.symbol)}</span></h1>
    <div class="meta">${live ? '<span class="pill live"><span class="dot"></span>Live on Stonk</span>' : '<span class="pill wait"><span class="dot"></span>Not launched yet</span>'}${qchip(c.quote)}<button class="copy mono" data-act="copy" data-v="${esc(c.mint)}">CA ${esc(short(c.mint, 5))} ⧉</button>
    ${live ? `<a class="btn sm" href="${stonkUrl(c.mint)}" target="_blank" rel="noopener">Stonk.fun ↗</a><a class="btn sm" href="${solscan(c.mint, 'token')}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}${c.launchSig ? `<a class="btn sm" href="${solscan(c.launchSig)}" target="_blank" rel="noopener">Launch tx ↗</a>` : ''}</div></div></div>
  ${c.description ? `<p class="muted" style="margin:-4px 0 18px;max-width:720px">${esc(c.description)}</p>` : ''}
  ${live ? '' : pendingBox(c, w)}
  <div class="bento">
    <div class="card c7"><div class="kick">Fees route to</div><div class="big" style="margin:6px 0 2px">${!live ? '—' : !r ? '…' : r.kind === 'fren' ? `<a href="${xUrl(r.handle)}" target="_blank" rel="noopener" style="text-decoration:none">@${esc(r.handle)}</a>` : r.kind === 'waiting' ? `@${esc(r.handle)} <span class="warn" style="font-size:15px;font-weight:600">(not signed in yet)</span>` : 'the launcher'}</div>
      <p class="muted" style="margin:0">${!live ? 'The fren chain starts the moment the coin goes live.' : r.kind === 'fren' ? `Signed in with X and linked <span class="mono">${esc(short(r.wallet))}</span>.` : r.kind === 'waiting' ? `Has ${left(r.until)} to sign in with X at fren. After that the next fren is up.` : 'No fren signed in during their windows.'}</p>
      ${live ? chainView(c, r) : ''}${tweet ? `<a class="btn sm" style="margin-top:14px" href="${tweet}" target="_blank" rel="noopener">Tell @${esc(r.handle)} on X ↗</a>` : ''}</div>
    <div class="card c5"><div class="kick">Fees waiting in the coin wallet</div><div class="big" style="margin:6px 0 0">${fees} <span class="muted" style="font-size:16px">${esc(c.quote.symbol)}</span></div>
      ${w && w.native > 0 ? `<div class="muted">+ ${sol(w.native)} SOL</div>` : ''}
      <dl class="kv" style="margin-top:14px"><dt>Coin wallet</dt><dd><a class="mono" href="${solscan(c.deployer, 'account')}" target="_blank" rel="noopener">${esc(short(c.deployer))} ↗</a></dd><dt>Gas in wallet</dt><dd>${w ? sol(w.sol) + ' SOL' : '—'}</dd><dt>Split</dt><dd>${(cfg.splitBps || 8000) / 100}% fren · ${100 - (cfg.splitBps || 8000) / 100}% treasury</dd></dl>
      <div class="split"><i style="width:${(cfg.splitBps || 8000) / 100}%"></i><u></u></div>
      ${why ? `<p class="muted" style="font-size:13px">${esc(why)}</p>` : ''}
      <button class="btn ${canSettle ? 'sky' : ''} full" data-act="settle" data-id="${esc(c.id)}" ${canSettle ? '' : 'disabled'}>Pay out now</button>
      <small class="muted" style="display:block;margin-top:8px">Anyone can press it. The server decides who gets what, from the rules above. A daily run pays out too.</small></div>
    <div class="card c12"><div class="kick">Payouts for $${esc(c.symbol)}</div><div class="tscroll">${d.payouts.length ? `<table><tr><th>When</th><th>To</th><th>Fren</th><th>Treasury</th><th>Tx</th></tr>${d.payouts.map(p => `<tr><td>${ago(p.at)}</td><td>${p.kind === 'fren' ? '@' + esc(p.handle) : 'launcher'} <span class="mono muted">${esc(short(p.to))}</span></td><td>${p.fren !== '0' ? amt(p.fren, p.decimals) + ' ' + esc(p.token) : sol(p.nativeFren) + ' SOL'}</td><td>${p.treasury !== '0' ? amt(p.treasury, p.decimals) + ' ' + esc(p.token) : sol(p.nativeTreasury) + ' SOL'}</td><td><a href="${solscan(p.sig)}" target="_blank" rel="noopener">${esc(short(p.sig, 5))} ↗</a></td></tr>`).join('')}</table>` : empty('No payouts yet.', 'They land here with their Solscan links.')}</div></div>
    <div class="card c12"><div class="kick">On Stonk.fun</div>${d.market ? `<dl class="kv" style="max-width:420px;margin-top:10px">${Object.entries(d.market).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 8).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' ? v.toLocaleString() : v)}</dd>`).join('')}</dl>` : `<p class="muted" style="margin:8px 0 12px">${live ? 'Trade it on Stonk.fun. Stonk adopts new LaunchLab pools within a minute or two.' : 'Market data shows up once the coin is live.'}</p>`}${live ? `<a class="btn sm" href="${stonkUrl(c.mint)}" target="_blank" rel="noopener">Open on Stonk.fun ↗</a>` : ''}</div>
  </div>`;
};
function pendingBox(c, w) {
  const mine = wallet.pk && wallet.pk === c.launcher;
  return `<div class="card" style="margin-bottom:12px"><div class="kick">Launch not finished</div><p class="muted" style="margin:6px 0 12px">This coin is saved but not on Stonk yet. The coin wallet <a class="mono" href="${solscan(c.deployer, 'account')}" target="_blank" rel="noopener">${esc(short(c.deployer))}</a> holds ${w ? sol(w.sol) : '—'} SOL of the 0.05 SOL it needs.</p>
  ${mine ? `<div class="bar"><button class="btn sky" data-act="finish" data-id="${esc(c.id)}">Finish launch</button>${w && w.sol > 5000 ? `<button class="btn" data-act="refund" data-id="${esc(c.id)}">Refund my SOL</button>` : ''}</div>` : `<p class="muted" style="margin:0">Only the wallet that started it (${esc(short(c.launcher))}) can finish it. ${wallet.pk ? '' : '<a href="#" data-act="wallet">Connect</a> if that is you.'}</p>`}</div>`;
}

/* ---------- claim ---------- */
V.claim = async el => {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('error');
  el.innerHTML = '<div class="load">loading…</div>';
  let me; try { me = await api('me'); } catch (e) { me = { user: null, x: false }; }
  S.me = me;
  const coins = await getCoins().catch(() => []);
  if (!me.user) {
    el.innerHTML = `<div class="head"><div class="kick">Claim</div><h1>Were you named as a fren?</h1><p>Sign in with X to prove the handle is yours, link a Solana wallet, and every coin that names you pays you automatically.</p></div>
    ${err ? `<div class="note">${esc(err)}</div>` : ''}
    <div class="bento"><div class="card c6"><div class="kick">Step 1</div><h3>Sign in with X</h3><p class="muted">Read-only: fren asks X for your handle and nothing else. It can't post or read your DMs.</p>
      ${me.x ? '<a class="btn sky lg" href="/api/auth/x/start">Sign in with X</a>' : '<button class="btn lg" disabled>Sign in with X opens soon</button>'}</div>
    <div class="card c6"><div class="kick">Check a handle</div><h3>Is anything routing to you?</h3><div class="at" style="margin:12px 0"><input class="in" id="ch" placeholder="your X handle"></div><div id="chout" class="feed"></div></div></div>`;
    $('#ch').addEventListener('input', e => {
      const h = e.target.value.replace(/^@/, '').toLowerCase().trim();
      const hit = h ? coins.filter(c => c.handles.some(x => x.toLowerCase() === h)) : [];
      $('#chout').innerHTML = !h ? '' : hit.length ? hit.map(c => `<a class="row" href="#/coin/${esc(c.id)}" style="text-decoration:none">${av(c)}<div class="grow"><b>$${esc(c.symbol)}</b><small>you are fren ${c.handles.findIndex(x => x.toLowerCase() === h) + 1} of ${c.handles.length}</small></div></a>`).join('') : '<div class="empty">No coin names @' + esc(h) + ' yet.</div>';
    });
    return;
  }
  const u = me.user, link = me.link;
  el.innerHTML = `<div class="head"><div class="kick">Claim</div><h1>gm @${esc(u.username)}</h1><p>${link ? 'Your wallet is linked. Coins that name you pay you automatically.' : 'One step left: link the Solana wallet your fees should go to.'}</p></div>
  ${err ? `<div class="note">${esc(err)}</div>` : ''}
  <div class="bento"><div class="card c5"><div class="kick">Your payout wallet</div>
    ${link ? `<div class="big mono" style="font-size:18px;margin:8px 0">${esc(short(link.wallet, 6))}</div><p class="muted" style="font-size:13px">Linked ${ago(link.updatedAt)}. Signed by that wallet, so nobody else can point your fees somewhere else.</p>` : '<p class="muted">Connect the wallet you want paid in, then sign one message. It proves the wallet is yours. It costs nothing and moves no funds.</p>'}
    <button class="btn ${link ? '' : 'sky'} full" data-act="link">${link ? 'Change wallet' : wallet.pk ? 'Sign to link ' + short(wallet.pk) : 'Connect wallet to link'}</button>
    <button class="btn sm" style="margin-top:10px" data-act="logout">Sign out of X</button></div>
  <div class="card c7"><div class="kick">Coins that name you</div><div class="feed">${me.coins.length ? me.coins.map(c => { const i = c.handles.findIndex(x => x.toLowerCase() === u.username.toLowerCase()); const from = c.launchedAt + i * 7 * DAY, until = from + 7 * DAY; const st = !link ? (Date.now() < until ? `link a wallet within ${left(until)} to claim` : 'your window passed before you linked') : link.linkedAt > until ? 'you linked after your window closed' : i === 0 ? 'fees route to you' : 'fees route to you unless an earlier fren linked first'; return `<a class="row" href="#/coin/${esc(c.id)}" style="text-decoration:none">${av(c)}<div class="grow"><b>$${esc(c.symbol)} <span class="muted">· fren ${i + 1}</span></b><small>${esc(st)}</small></div><span class="btn sm">open</span></a>`; }).join('') : empty('No coin names you yet.', 'When someone launches a coin with @' + esc(u.username) + ' as a fren, it shows up here.')}</div></div>
  <div class="card c12"><div class="kick">Paid to you</div><div class="feed">${me.payouts.length ? me.payouts.map(payRow).join('') : empty('Nothing paid yet.', 'Payouts land in your linked wallet and show up here.')}</div></div></div>`;
};
async function doLink() {
  if (!needWallet(doLink)) return;
  const u = S.me && S.me.user; if (!u) return route();
  const ts = Date.now(), msg = `fren: link @${u.username} to ${wallet.pk}\nissued ${ts}`;
  try { const signature = await signText(msg); await api('link', { wallet: wallet.pk, ts, signature }); S.bust = Date.now(); toast('Wallet linked. Fees that route to @' + esc(u.username) + ' now pay here.'); route(); }
  catch (e) { toast(cancelled(e) ? 'Cancelled in your wallet' : esc(e.message), true); }
}

/* ---------- ledger ---------- */
V.ledger = async el => {
  el.innerHTML = `<div class="head"><div class="kick">Ledger</div><h1>Every payout, on-chain</h1><p>Each row is one Solana transaction from a coin wallet: ${'the fren\'s share and the treasury\'s share'} in the same transaction, with a <code>fren|v1|pay</code> memo.</p></div><div class="card"><div class="tscroll" id="lg"><div class="load">loading…</div></div></div>`;
  let p; try { p = await getLedger(true); } catch (e) { $('#lg').innerHTML = empty('Could not load the ledger.', esc(e.message)); return; }
  $('#lg').innerHTML = p.length ? `<table><tr><th>When</th><th>Coin</th><th>To</th><th>Fren share</th><th>Treasury share</th><th>Tx</th></tr>${p.map(x => `<tr><td>${ago(x.at)}</td><td><a href="#/coin/${esc(x.id)}">$${esc(x.symbol)}</a></td><td>${x.kind === 'fren' ? `<a href="${xUrl(x.handle)}" target="_blank" rel="noopener">@${esc(x.handle)}</a>` : 'launcher'}</td><td>${x.fren !== '0' ? amt(x.fren, x.decimals) + ' ' + esc(x.token) : sol(x.nativeFren) + ' SOL'}</td><td>${x.treasury !== '0' ? amt(x.treasury, x.decimals) + ' ' + esc(x.token) : sol(x.nativeTreasury) + ' SOL'}</td><td><a href="${solscan(x.sig)}" target="_blank" rel="noopener">${esc(short(x.sig, 5))} ↗</a></td></tr>`).join('')}</table>` : empty('No payouts yet.', 'The first one shows up here with its Solscan link. Until then there is nothing to count, so there is no number.');
};

/* ---------- docs ---------- */
V.docs = async el => {
  const cfg = await getCfg().catch(() => ({ splitBps: 8000 }));
  const pct = cfg.splitBps / 100;
  const D = [
    ['overview', 'Overview', `<p>fren is a launchpad on <strong>Stonk.fun</strong>. You launch a coin, name one to three X handles, and the coin's creator fees route to the first of them who signs in with X. <strong>${pct}%</strong> goes to the fren, ${100 - pct}% to the fren treasury.</p><p>Everything fren shows is read from Stonk.fun, from Solana, or from fren's own records. Where nothing has happened yet, you see a dash, not a zero.</p>`],
    ['launch', 'Launching on Stonk.fun', `<p>fren builds Raydium LaunchLab's <code>initialize_with_token2022</code> instruction itself, the same "build it yourself" path Stonk.fun documents: Stonk's config, Stonk's platform, and Stonk's curve rule appended last. There's no launch fee on this path, just Solana rent and network fees.</p><ol><li>You pick a pair. Every launchable Stonk pair is listed live: xStocks, PreStocks, SOL, STONK, currencies and more.</li><li>fren saves the image and metadata. The coin's X link points at fren 1, and its website points at the coin's fren page.</li><li>Your wallet sends <strong>0.05 SOL</strong> to the coin's own launch wallet. That's the only thing you sign.</li><li>fren signs the launch with that wallet and the new mint, then sends back what the launch didn't use. 0.01 SOL stays behind to pay payout fees.</li><li>Stonk.fun adopts the pool within a minute or two, and the coin trades on Stonk.</li></ol>`],
    ['chain', 'The fren chain', `<p>Each fren gets a 7-day window, starting when the coin goes live.</p><ul><li><strong>Fren 1</strong>: days 0 to 7. <strong>Fren 2</strong>: days 7 to 14. <strong>Fren 3</strong>: days 14 to 21.</li><li>The first fren who signs in with X and links a wallet before their window ends gets the coin's fees from then on.</li><li>A fren who linked before the coin launched is paid from day one.</li><li>If no fren signs in, the fees go back to the wallet that launched.</li></ul><p>So fees never sit forever on an account that will never claim, and you can still name someone famous as fren 1.</p>`],
    ['x', 'Signing in with X', `<p>Frens sign in with X (OAuth 2.0 with PKCE), asking only for <code>users.read</code> and <code>tweet.read</code>. fren sees your handle and nothing else. It can't post, follow, or read DMs.</p><p>Then you link a wallet by signing <code>fren: link @you to &lt;wallet&gt;</code> with it. That signature is stored with the link, so anyone can check that the wallet agreed to it. A link keeps its original date as long as it's the same X account. If a handle changes hands, the new owner's link starts from the day they link.</p>`],
    ['pay', 'Payouts and the split', `<p>Stonk forwards the creator share of every trade to the coin's launch wallet, in the pair's token (SPYX for an SPYX pair, SOL for a SOL pair). A payout sends the whole balance in <strong>one Solana transaction</strong>: ${pct}% to the fren's wallet, ${100 - pct}% to the treasury, with a <code>fren|v1|pay|&lt;coin&gt;|@handle</code> memo.</p><p>Anyone can press "Pay out now" on a coin page, and a daily run pays every coin too. The amounts come from the chain balance at that moment, so pressing it twice can't pay twice.</p>`],
    ['trust', 'Where you trust fren', `<p>We'd rather say this up front:</p><ul><li><strong>The launch wallets are custodial.</strong> Every coin's wallet is derived from one server key that fren holds. That's how fren can sign launches and payouts for you. The flip side: you're trusting fren not to misuse that key.</li><li><strong>The split runs on fren's server,</strong> not in an on-chain program. Every payout shows the exact amounts on Solscan, so a wrong split is public the moment it happens.</li><li><strong>Where you'd see it if we failed you:</strong> each coin page shows the fees sitting in its wallet with a Solscan link. Fees that sit there while the route shows a linked fren and the treasury is set are fees we owe. Anyone can press "Pay out now" to force the issue.</li><li><strong>X sign-in depends on X.</strong> If X's API goes down, frens can't sign in until it comes back. Windows keep running.</li></ul><p>Next step: move the split and the fren chain on-chain, so a program pays and fren is out of the loop.</p>`],
    ['xmoney', 'Why not X Money?', `<p>X Money has no public API for apps to send funds to a handle. So instead of X paying your fren, the fren proves the handle with Sign in with X and gets paid on Solana. The coin still routes to an X handle. The money just moves on-chain, where you can see it.</p>`],
    ['gloss', 'Glossary', `<ul><li><strong>Fren</strong>: an X handle a coin's fees route to.</li><li><strong>Coin wallet</strong>: the per-coin launch wallet. It's the pool's creator, so Stonk pays the creator fees into it.</li><li><strong>Pair</strong>: the token your coin trades against on Stonk (its quote token).</li><li><strong>Treasury</strong>: fren's wallet for the ${100 - pct}% protocol share.</li><li><strong>Route</strong>: where a coin's fees go right now: a fren, "waiting", or back to the launcher.</li></ul>`],
  ];
  el.innerHTML = `<div class="head"><div class="kick">Docs</div><h1>How fren works</h1><p>The whole mechanism, including the parts where you're trusting us.</p></div><div class="docs"><nav class="toc">${D.map((s, i) => `<a href="#/docs" data-act="toc" data-s="${s[0]}">${String(i + 1).padStart(2, '0')} ${s[1]}</a>`).join('')}</nav><div class="doc">${D.map((s, i) => `<section id="d-${s[0]}"><h2><small>${String(i + 1).padStart(2, '0')}</small>${s[1]}</h2>${s[2]}</section>`).join('')}</div></div>`;
};

/* ---------- router + events ---------- */
async function route() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0], [p, arg] = h.split('/');
  const name = V[p] ? p : 'home';
  document.querySelectorAll('#links a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
  const el = document.createElement('div'); $('#app').replaceChildren(el); // a slow earlier view renders into a detached node
  try { await V[name](el, arg && decodeURIComponent(arg)); } catch (e) { el.innerHTML = `<div class="head"><h1>Something broke</h1><p>${esc(e.message)}</p></div>`; }
  if (!V[p] || p !== route.last) window.scrollTo(0, 0); route.last = p;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (['wallet', 'close', 'pick', 'disconnect', 'copy', 'settle', 'finish', 'refund', 'link', 'logout', 'toc', 'topsort'].includes(a) && b.tagName !== 'A') e.preventDefault();
  if (a === 'wallet') openModal(walletModal());
  if (a === 'close') closeModal();
  if (a === 'pick') connectWith(providers()[+b.dataset.i]);
  if (a === 'disconnect') disconnect();
  if (a === 'copy') { try { await navigator.clipboard.writeText(b.dataset.v); toast('Copied'); } catch (er) { toast(esc(b.dataset.v)); } }
  if (a === 'toc') { e.preventDefault(); const s = document.getElementById('d-' + b.dataset.s); s && s.scrollIntoView({ behavior: 'smooth' }); }
  if (a === 'settle') {
    b.disabled = true; b.textContent = 'Paying out…';
    try { const r = await api('settle', { id: b.dataset.id }); S.bust = Date.now(); toast(r.paid ? `Paid out · <a href="${solscan(r.payout.sig)}" target="_blank" rel="noopener">view tx ↗</a>` : esc(r.reason)); S.ledger = null; route(); }
    catch (er) { toast(esc(er.message), true); b.disabled = false; b.textContent = 'Pay out now'; }
  }
  if (a === 'finish') { if (needWallet(() => finishLaunch(b.dataset.id))) finishLaunch(b.dataset.id); }
  if (a === 'refund') {
    b.disabled = true;
    try { const r = await api('launch/refund', { id: b.dataset.id }); S.bust = Date.now(); toast(`Refunded ${sol(r.lamports)} SOL · <a href="${solscan(r.sig)}" target="_blank" rel="noopener">tx ↗</a>`); LS.set('fren:pending', null); route(); }
    catch (er) { toast(esc(er.message), true); b.disabled = false; }
  }
  if (a === 'topsort') paintTop(b.dataset.s);
  if (a === 'link') doLink();
  if (a === 'logout') { await api('logout', {}).catch(() => {}); route(); }
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', route);
if (CFG.X_URL) { $('#xlink').href = CFG.X_URL; $('#xlink').hidden = false; }
(async () => {
  route();
  const pref = LS.get('fren:w');
  if (pref) { await new Promise(r => setTimeout(r, 400)); const x = providers().find(p => p.name === pref); if (x) connectWith(x, true); }
})();
