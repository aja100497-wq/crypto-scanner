'use strict';
/* 코인 스캐너 — 업비트 공개 API 실시간 데이터 + 100점 스코어링
   투자 조언이 아닌 스크리닝 도구. 점수는 과거/현재 지표 기반이며 수익을 보장하지 않음. */

const API = 'https://api.upbit.com/v1';
const STABLES = new Set(['USDT','USDC','DAI','FDUSD','TUSD','USDD','PYUSD','EURI','XAUT']);
const TOP_N = 60;          // 캔들 분석 대상 (24h 거래대금 상위)
const CANDLE_COUNT = 90;
const AUTO_REFRESH_MS = 5 * 60 * 1000;

let RESULTS = [];
let REGIME = { label: '분석 중', cls: '', adj: 0, note: '' };

const $ = id => document.getElementById(id);
const loadingEl = $('loading'), appEl = $('app'), errEl = $('error');

/* ---------- 유틸 ---------- */
function fmtPrice(p) {
  if (p >= 1000) return Math.round(p).toLocaleString('ko-KR') + '원';
  if (p >= 100) return p.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '원';
  return p.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) + '원';
}
function fmtPct(r) { return (r >= 0 ? '+' : '') + (r * 100).toFixed(2) + '%'; }
function fmtMoney(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
  if (v >= 1e8) return (v / 1e8).toFixed(0) + '억';
  return Math.round(v).toLocaleString('ko-KR') + '원';
}
function ma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  const rs = (g / n) / (l / n);
  return 100 - 100 / (1 + rs);
}
function atr(highs, lows, closes, n = 14) {
  if (closes.length < n + 1) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    s += tr;
  }
  return s / n;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

/* ---------- API ---------- */
async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}
async function loadMarkets() {
  const all = await api('/market/all?isDetails=false');
  return all.filter(m => {
    if (!m.market.startsWith('KRW-')) return false;
    const code = m.market.slice(4);
    return !STABLES.has(code);
  });
}
async function loadTickers(markets) {
  const out = [];
  for (let i = 0; i < markets.length; i += 80) {
    const chunk = markets.slice(i, i + 80).map(m => m.market).join(',');
    const data = await api('/ticker?markets=' + chunk);
    out.push(...data);
  }
  return out;
}
async function loadCandles(market) {
  return api(`/candles/days?market=${market}&count=${CANDLE_COUNT}`);
}

/* ---------- 스코어링 (100점) ---------- */
function scoreCoin(c, btcRet30, regimeAdj) {
  const { closes, highs, lows, vols } = c;
  const close = closes[closes.length - 1];
  const f = {};   // 팩터별 점수
  let total = 0;

  // A. 추세 25
  let a = 0;
  const ma20 = ma(closes, 20), ma60 = ma(closes, 60);
  if (ma20 !== null && close > ma20) a += 8;
  if (ma60 !== null && close > ma60) a += 7;
  if (ma20 !== null && ma60 !== null && ma20 > ma60) a += 5;
  if (closes.length >= 25) {
    const ma20prev = ma(closes.slice(0, -5), 20);
    if (ma20 !== null && ma20prev !== null && ma20 > ma20prev) a += 5;
  }
  f.A = { name: '추세', pts: a, max: 25 }; total += a;

  // B. 모멘텀 20
  let b = 0;
  const r = rsi(closes);
  if (r !== null) {
    if (r >= 50 && r <= 70) b += 10;
    else if (r >= 40 && r < 50) b += 5;
    else if (r > 70 && r < 80) b += 4;
    else b += 2;
  }
  if (closes.length >= 8) {
    const ret7 = close / closes[closes.length - 8] - 1;
    if (ret7 > 0) b += 5;
    if (ret7 > 0.10) b += 5;
    c._ret7 = ret7;
  }
  f.B = { name: '모멘텀', pts: b, max: 20 }; total += b;

  // C. 돌파 15
  let cc = 0;
  const n = Math.min(20, highs.length);
  const high20 = Math.max(...highs.slice(-n));
  const distHigh = (high20 - close) / high20;
  c._distHigh = distHigh;
  if (distHigh <= 0.03) cc += 10;
  else if (distHigh <= 0.07) cc += 5;
  const volRatio = vols.length >= 20 ? mean(vols.slice(-5)) / (mean(vols.slice(-20)) || 1) : 1;
  c._volRatio = volRatio;
  if (volRatio >= 1.5) cc += 5;
  f.C = { name: '돌파', pts: cc, max: 15 }; total += cc;

  // D. 거래량 15
  let d = 0;
  const tv = c.ticker.acc_trade_price_24h;
  if (tv >= 1e11) d += 8; else if (tv >= 3e10) d += 5; else if (tv >= 1e10) d += 3;
  if (volRatio >= 2.0) d += 7; else if (volRatio >= 1.5) d += 5; else if (volRatio >= 1.2) d += 3;
  f.D = { name: '거래량', pts: d, max: 15 }; total += d;

  // E. 변동성 10
  let e = 0;
  const a14 = atr(highs, lows, closes);
  const atrPct = a14 !== null ? (a14 / close) * 100 : null;
  c._atrPct = atrPct;
  if (atrPct !== null) {
    if (atrPct <= 3) e += 10;
    else if (atrPct <= 5) e += 7;
    else if (atrPct <= 8) e += 4;
  }
  f.E = { name: '변동성', pts: e, max: 10 }; total += e;

  // F. 상대강도 10 (BTC 대비 30일 초과수익)
  let ff = 0;
  if (closes.length >= 31 && btcRet30 !== null) {
    const ret30 = close / closes[closes.length - 31] - 1;
    const ex = ret30 - btcRet30;
    c._ret30 = ret30; c._exRet = ex;
    if (ex > 0.10) ff += 10; else if (ex > 0) ff += 6; else if (ex > -0.10) ff += 3;
  }
  f.F = { name: '상대강도', pts: ff, max: 10 }; total += ff;

  // 감점
  const demerits = [];
  if (closes.length < 60) { total -= 10; demerits.push('신규상장(60일 미만) −10'); }
  const chg24 = c.ticker.signed_change_rate;
  if (chg24 >= 0.30) { total -= 10; demerits.push('과열(24h +30%↑) −10'); }
  if (tv < 1e9) { total -= 10; demerits.push('유동성 부족(24h 10억↓) −10'); }
  if (chg24 <= -0.15) { total -= 5; demerits.push('급락(24h −15%↓) −5'); }
  if (r !== null && r >= 80) { total -= 5; demerits.push('RSI 80↑ 과매수 −5'); }
  if (regimeAdj) { total += regimeAdj; demerits.push(`시장 국면 조정 ${regimeAdj > 0 ? '+' : ''}${regimeAdj}`); }

  total = Math.max(0, Math.min(100, Math.round(total)));
  c._rsi = r; c._ma20 = ma20; c._ma60 = ma60;
  return { score: total, factors: f, demerits };
}

function gradeOf(s) {
  if (s >= 85) return ['A+', 'g-aplus'];
  if (s >= 75) return ['A', 'g-a'];
  if (s >= 65) return ['B+', 'g-bplus'];
  if (s >= 55) return ['B', 'g-b'];
  if (s >= 45) return ['C+', 'g-cplus'];
  if (s >= 35) return ['C', 'g-c'];
  return ['D', 'g-d'];
}
function signalOf(s) {
  if (s >= 75) return ['BUY WATCH', 's-buy'];
  if (s >= 55) return ['WATCH', 's-watch'];
  if (s >= 35) return ['WAIT', 's-wait'];
  return ['AVOID', 's-avoid'];
}

/* ---------- 메인 로드 ---------- */
async function refresh() {
  loadingEl.classList.remove('hidden');
  appEl.classList.add('hidden');
  errEl.classList.add('hidden');
  try {
    setLoad('마켓 목록 수집 중…');
    const markets = await loadMarkets();
    const nameMap = Object.fromEntries(markets.map(m => [m.market, m]));

    setLoad('24시간 시세 수집 중…');
    const tickers = await loadTickers(markets);
    const tmap = Object.fromEntries(tickers.map(t => [t.market, t]));

    // BTC 기준 수익률 (상대강도용)
    setLoad('비트코인 기준 데이터 수집 중…');
    const btcC = await loadCandles('KRW-BTC');
    const btcCloses = btcC.map(c => c.trade_price).reverse();
    const btcRet30 = btcCloses.length >= 31 ? btcCloses[btcCloses.length - 1] / btcCloses[btcCloses.length - 31] - 1 : null;

    // 시장 국면 판단 (BTC 기준)
    const btcMa20 = ma(btcCloses, 20), btcMa60 = ma(btcCloses, 60);
    const btcClose = btcCloses[btcCloses.length - 1];
    if (btcMa20 && btcMa60 && btcClose > btcMa20 && btcMa20 > btcMa60) {
      REGIME = { label: '🔴 강세장', cls: 'bull', adj: 0, note: 'BTC가 20일·60일선 위 정배열 — 추세 추종 전략이 유리한 국면입니다.' };
    } else if (btcMa20 && btcMa60 && btcClose < btcMa20 && btcMa20 < btcMa60) {
      REGIME = { label: '🔵 약세장', cls: 'bear', adj: -5, note: 'BTC가 20일·60일선 아래 역배열 — 전체 점수 −5 조정, 보수적 접근을 권장합니다.' };
    } else {
      REGIME = { label: '🟡 횡보/혼조', cls: 'flat', adj: 0, note: 'BTC 추세가 불분명 — 돌파·박스권 전략 병행, 손절 기준을 엄격히.' };
    }

    // 거래대금 상위 TOP_N 캔들 수집
    const sorted = tickers
      .filter(t => tmap[t.market] && nameMap[t.market])
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, TOP_N);

    const coins = [];
    let done = 0;
    const CONC = 6;
    for (let i = 0; i < sorted.length; i += CONC) {
      const batch = sorted.slice(i, i + CONC);
      const res = await Promise.all(batch.map(async t => {
        try {
          const cs = await loadCandles(t.market);
          return { t, cs };
        } catch { return null; }
      }));
      for (const r of res) {
        done++;
        setLoad(`캔들 분석 중… ${done}/${sorted.length}`);
        if (!r || !r.cs || r.cs.length < 20) continue;
        const cs = r.cs.slice().reverse(); // 오래된 → 최신
        const coin = {
          market: r.t.market,
          korean: nameMap[r.t.market].korean_name,
          english: nameMap[r.t.market].english_name,
          ticker: r.t,
          closes: cs.map(c => c.trade_price),
          highs: cs.map(c => c.high_price),
          lows: cs.map(c => c.low_price),
          vols: cs.map(c => c.candle_acc_trade_volume),
        };
        const { score, factors, demerits } = scoreCoin(coin, btcRet30, REGIME.adj);
        coin.score = score; coin.factors = factors; coin.demerits = demerits;
        coins.push(coin);
      }
    }

    coins.sort((a, b) => b.score - a.score);
    RESULTS = coins;
    render();
  } catch (e) {
    console.error(e);
    loadingEl.classList.add('hidden');
    errEl.classList.remove('hidden');
  }
}
function setLoad(msg) { $('loadingMsg').textContent = msg; }

/* ---------- 렌더 ---------- */
function render() {
  loadingEl.classList.add('hidden');
  appEl.classList.remove('hidden');

  const now = new Date();
  $('updated').textContent = now.toLocaleString('ko-KR') + ' 기준';
  $('asof').textContent = '(' + now.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ')';

  const rg = $('regime');
  rg.textContent = REGIME.label;
  rg.className = 'regime ' + REGIME.cls;
  $('regimeNote').textContent = '📝 ' + REGIME.note;

  // BEST 3
  const best = RESULTS.slice(0, 3);
  $('best3').innerHTML = best.map((c, i) => {
    const [g, gc] = gradeOf(c.score);
    const [s, sc] = signalOf(c.score);
    return `<div class="pick" data-m="${c.market}">
      <div class="rank">BEST ${i + 1}</div>
      <div class="name">${c.korean} <span style="font-size:12px;color:var(--dim)">${c.market.slice(4)}</span></div>
      <div class="price">${fmtPrice(c.ticker.trade_price)} <span class="${c.ticker.signed_change_rate >= 0 ? 'up' : 'down'}">${fmtPct(c.ticker.signed_change_rate)}</span></div>
      <div class="meta"><span class="grade ${gc}">${g}</span><span class="score-num">${c.score}점</span><span class="signal ${sc}">${s}</span></div>
    </div>`;
  }).join('');

  // 조기 돌파 후보
  const bo = RESULTS.filter(c => c._distHigh !== undefined && c._distHigh <= 0.03 && c._volRatio >= 1.5 && c.score >= 55).slice(0, 8);
  $('breakouts').innerHTML = bo.length
    ? bo.map(c => `<div class="chip" data-m="${c.market}"><b>${c.korean}</b> <span class="score-num">${c.score}점</span><br><span class="pct">고점대비 ${(c._distHigh * 100).toFixed(1)}%</span> <span class="score-num">· 거래량 ${c._volRatio.toFixed(1)}배</span></div>`).join('')
    : '<p class="empty">현재 조건을 만족하는 조기 돌파 후보가 없습니다.</p>';

  // TOP 20 테이블
  const tb = document.querySelector('#rankTable tbody');
  tb.innerHTML = RESULTS.slice(0, 20).map((c, i) => {
    const [g, gc] = gradeOf(c.score);
    const [s, sc] = signalOf(c.score);
    const chg = c.ticker.signed_change_rate;
    return `<tr data-m="${c.market}">
      <td>${i + 1}</td>
      <td><div class="coin-cell"><div><div class="k">${c.korean}</div><div class="e">${c.market.slice(4)}</div></div></div></td>
      <td>${fmtPrice(c.ticker.trade_price)}</td>
      <td class="${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</td>
      <td class="${(c._ret7 || 0) >= 0 ? 'up' : 'down'}">${c._ret7 !== undefined ? fmtPct(c._ret7) : '-'}</td>
      <td><div style="display:flex;align-items:center;gap:6px;justify-content:flex-end"><div class="scorebar"><i style="width:${c.score}%"></i></div><b>${c.score}</b></div></td>
      <td><span class="grade ${gc}">${g}</span></td>
      <td><span class="signal ${sc}">${s}</span></td>
      <td>${fmtMoney(c.ticker.acc_trade_price_24h)}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('[data-m]').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.m));
  });
}

/* ---------- 상세 모달 ---------- */
function openModal(market) {
  const c = RESULTS.find(x => x.market === market);
  if (!c) return;
  const [g, gc] = gradeOf(c.score);
  const [s, sc] = signalOf(c.score);
  const chg = c.ticker.signed_change_rate;

  const frows = Object.entries(c.factors).map(([k, f]) =>
    `<div class="frow"><span class="fl">${k}. ${f.name}</span><b>${f.pts}/${f.max}점</b></div>
     <div class="fbar"><i style="width:${(f.pts / f.max) * 100}%"></i></div>`
  ).join('');

  const dem = c.demerits.length
    ? c.demerits.map(d => `<div class="frow"><span class="fl">⚠️ ${d}</span></div>`).join('')
    : '<div class="frow"><span class="fl">감점 없음</span><b>—</b></div>';

  $('modalBody').innerHTML = `
    <h2 style="font-size:20px">${c.korean} <span style="font-size:13px;color:var(--dim)">${c.market} · ${c.english}</span></h2>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap">
      <span class="grade ${gc}">${g}</span><b>${c.score}점</b><span class="signal ${sc}">${s}</span>
    </div>
    <div class="frow"><span class="fl">현재가</span><b>${fmtPrice(c.ticker.trade_price)} <span class="${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span></b></div>
    <div class="frow"><span class="fl">24h 고/저</span><b>${fmtPrice(c.ticker.high_price)} / ${fmtPrice(c.ticker.low_price)}</b></div>
    <div class="frow"><span class="fl">RSI(14)</span><b>${c._rsi !== null ? c._rsi.toFixed(1) : '-'}</b></div>
    <div class="frow"><span class="fl">20일선 / 60일선</span><b>${c._ma20 ? fmtPrice(c._ma20) : '-'} / ${c._ma60 ? fmtPrice(c._ma60) : '-'}</b></div>
    <div class="frow"><span class="fl">20일 고점 대비</span><b>${(c._distHigh * 100).toFixed(1)}% 아래</b></div>
    <div class="frow"><span class="fl">거래량 비율 (5일/20일)</span><b>${c._volRatio.toFixed(2)}배</b></div>
    <div class="frow"><span class="fl">7일 수익률 / 30일 수익률</span><b>${c._ret7 !== undefined ? fmtPct(c._ret7) : '-'} / ${c._ret30 !== undefined ? fmtPct(c._ret30) : '-'}</b></div>
    <div class="frow"><span class="fl">BTC 대비 30일 초과수익</span><b>${c._exRet !== undefined ? fmtPct(c._exRet) : '-'}</b></div>
    <div class="frow"><span class="fl">일 변동성 (ATR%)</span><b>${c._atrPct !== null ? c._atrPct.toFixed(2) + '%' : '-'}</b></div>
    <canvas id="spark"></canvas>
    <h3 style="font-size:14px;margin:10px 0 4px">팩터별 점수</h3>
    ${frows}
    <h3 style="font-size:14px;margin:10px 0 4px">감점 내역</h3>
    ${dem}
    <p style="font-size:11px;color:var(--dim);margin-top:12px">※ 지표 기반 스크리닝 결과이며 투자 권유가 아닙니다.</p>`;

  $('modal').classList.remove('hidden');
  drawSpark(c.closes);
}
function drawSpark(closes) {
  const cv = $('spark');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const data = closes.slice(-90);
  const min = Math.min(...data), max = Math.max(...data);
  const px = i => (i / (data.length - 1)) * (w - 8) + 4;
  const py = v => h - 8 - ((v - min) / (max - min || 1)) * (h - 16);
  const up = data[data.length - 1] >= data[0];
  ctx.strokeStyle = up ? '#ef5350' : '#2979ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)));
  ctx.stroke();
}
$('modalClose').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });

/* ---------- 이벤트 ---------- */
$('refresh').addEventListener('click', refresh);
$('retry').addEventListener('click', refresh);
setInterval(refresh, AUTO_REFRESH_MS);

refresh();
