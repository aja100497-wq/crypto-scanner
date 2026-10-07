'use strict';
/* 코인 스캐너 v2 — 정적 프론트엔드
   데이터는 서버 파이프라인(scripts/build-data.mjs)이 5분마다 생성한 data.json(동일 오리진)을 읽는다.
   브라우저에서 업비트 API를 직접 호출하지 않으므로 CORS/요청 제한 문제가 없다.
   투자 조언이 아닌 스크리닝 도구. 점수는 지표 기반이며 수익을 보장하지 않음. */

const AUTO_REFRESH_MS = 5 * 60 * 1000;

let DATA = null;

const $ = id => document.getElementById(id);
const loadingEl = $('loading'), appEl = $('app'), errEl = $('error');

/* ---------- 유틸 ---------- */
function fmtPrice(p) {
  if (p == null) return '-';
  if (p >= 1000) return Math.round(p).toLocaleString('ko-KR') + '원';
  if (p >= 100) return p.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '원';
  return p.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) + '원';
}
function fmtPct(r) {
  if (r == null) return '-';
  return (r >= 0 ? '+' : '') + (r * 100).toFixed(2) + '%';
}
function fmtMoney(v) {
  if (v == null) return '-';
  if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
  if (v >= 1e8) return (v / 1e8).toFixed(0) + '억';
  return Math.round(v).toLocaleString('ko-KR') + '원';
}
function setLoad(msg) { $('loadingMsg').textContent = msg; }
function agoText(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return '방금 전';
  if (mins < 60) return mins + '분 전';
  return Math.floor(mins / 60) + '시간 ' + (mins % 60) + '분 전';
}

/* ---------- 데이터 로드 (동일 오리진, 재시도 포함) ---------- */
async function loadData() {
  const MAX = 5;
  for (let i = 0; i < MAX; i++) {
    try {
      const r = await fetch('data.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!d || !Array.isArray(d.coins) || !d.coins.length) throw new Error('empty data');
      return d;
    } catch (e) {
      if (i === MAX - 1) throw e;
      setLoad(`데이터 불러오는 중… (${i + 1}/${MAX})`);
      await new Promise(res => setTimeout(res, 1500 * (i + 1)));
    }
  }
}

async function refresh() {
  loadingEl.classList.remove('hidden');
  appEl.classList.add('hidden');
  errEl.classList.add('hidden');
  try {
    setLoad('최신 스코어 데이터 불러오는 중…');
    DATA = await loadData();
    render();
  } catch (e) {
    console.error(e);
    loadingEl.classList.add('hidden');
    errEl.classList.remove('hidden');
  }
}

/* ---------- 렌더 ---------- */
function render() {
  loadingEl.classList.add('hidden');
  appEl.classList.remove('hidden');

  $('updated').textContent = agoText(DATA.updated) + ' 기준';
  $('asof').textContent = '(' + DATA.updatedKst + ' KST)';

  const rg = $('regime');
  rg.textContent = DATA.regime.label;
  rg.className = 'regime ' + DATA.regime.cls;
  $('regimeNote').textContent = '📝 ' + DATA.regime.note;

  const coins = DATA.coins;

  // BEST 3
  $('best3').innerHTML = coins.slice(0, 3).map((c, i) => `
    <div class="pick" data-m="${c.market}">
      <div class="rank">BEST ${i + 1}</div>
      <div class="name">${c.korean} <span style="font-size:12px;color:var(--dim)">${c.market.slice(4)}</span></div>
      <div class="price">${fmtPrice(c.price)} <span class="${c.chg24 >= 0 ? 'up' : 'down'}">${fmtPct(c.chg24)}</span></div>
      <div class="meta"><span class="grade ${c.gradeClass}">${c.grade}</span><span class="score-num">${c.score}점</span><span class="signal ${c.signalClass}">${c.signal}</span></div>
    </div>`).join('');

  // 조기 돌파 후보
  const bo = coins.filter(c => c.distHigh != null && c.distHigh <= 0.03 && c.volRatio >= 1.5 && c.score >= 55).slice(0, 8);
  $('breakouts').innerHTML = bo.length
    ? bo.map(c => `<div class="chip" data-m="${c.market}"><b>${c.korean}</b> <span class="score-num">${c.score}점</span><br><span class="pct">고점대비 ${(c.distHigh * 100).toFixed(1)}%</span> <span class="score-num">· 거래량 ${c.volRatio.toFixed(1)}배</span></div>`).join('')
    : '<p class="empty">현재 조건을 만족하는 조기 돌파 후보가 없습니다.</p>';

  // TOP 20 테이블
  const tb = document.querySelector('#rankTable tbody');
  tb.innerHTML = coins.slice(0, 20).map((c, i) => `
    <tr data-m="${c.market}">
      <td>${i + 1}</td>
      <td><div class="coin-cell"><div><div class="k">${c.korean}</div><div class="e">${c.market.slice(4)}</div></div></div></td>
      <td>${fmtPrice(c.price)}</td>
      <td class="${c.chg24 >= 0 ? 'up' : 'down'}">${fmtPct(c.chg24)}</td>
      <td class="${(c.ret7 || 0) >= 0 ? 'up' : 'down'}">${fmtPct(c.ret7)}</td>
      <td><div style="display:flex;align-items:center;gap:6px;justify-content:flex-end"><div class="scorebar"><i style="width:${c.score}%"></i></div><b>${c.score}</b></div></td>
      <td><span class="grade ${c.gradeClass}">${c.grade}</span></td>
      <td><span class="signal ${c.signalClass}">${c.signal}</span></td>
      <td>${fmtMoney(c.tradeValue24)}</td>
    </tr>`).join('');

  document.querySelectorAll('[data-m]').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.m));
  });
}

/* ---------- 상세 모달 ---------- */
function openModal(market) {
  const c = DATA.coins.find(x => x.market === market);
  if (!c) return;

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
      <span class="grade ${c.gradeClass}">${c.grade}</span><b>${c.score}점</b><span class="signal ${c.signalClass}">${c.signal}</span>
    </div>
    <div class="frow"><span class="fl">현재가</span><b>${fmtPrice(c.price)} <span class="${c.chg24 >= 0 ? 'up' : 'down'}">${fmtPct(c.chg24)}</span></b></div>
    <div class="frow"><span class="fl">24h 고/저</span><b>${fmtPrice(c.high24)} / ${fmtPrice(c.low24)}</b></div>
    <div class="frow"><span class="fl">RSI(14)</span><b>${c.rsi != null ? c.rsi.toFixed(1) : '-'}</b></div>
    <div class="frow"><span class="fl">20일선 / 60일선</span><b>${fmtPrice(c.ma20)} / ${fmtPrice(c.ma60)}</b></div>
    <div class="frow"><span class="fl">20일 고점 대비</span><b>${c.distHigh != null ? (c.distHigh * 100).toFixed(1) + '% 아래' : '-'}</b></div>
    <div class="frow"><span class="fl">거래량 비율 (5일/20일)</span><b>${c.volRatio != null ? c.volRatio.toFixed(2) + '배' : '-'}</b></div>
    <div class="frow"><span class="fl">7일 수익률 / 30일 수익률</span><b>${fmtPct(c.ret7)} / ${fmtPct(c.ret30)}</b></div>
    <div class="frow"><span class="fl">BTC 대비 30일 초과수익</span><b>${fmtPct(c.exRet)}</b></div>
    <div class="frow"><span class="fl">일 변동성 (ATR%)</span><b>${c.atrPct != null ? c.atrPct.toFixed(2) + '%' : '-'}</b></div>
    <canvas id="spark"></canvas>
    <h3 style="font-size:14px;margin:10px 0 4px">팩터별 점수</h3>
    ${frows}
    <h3 style="font-size:14px;margin:10px 0 4px">감점 내역</h3>
    ${dem}
    <p style="font-size:11px;color:var(--dim);margin-top:12px">※ 지표 기반 스크리닝 결과이며 투자 권유가 아닙니다. (${DATA.updatedKst} KST 기준)</p>`;

  $('modal').classList.remove('hidden');
  drawSpark(c.spark);
}
function drawSpark(data) {
  if (!data || !data.length) return;
  const cv = $('spark');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
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
