// 코인 스캐너 공용 스코어링 라이브러리 (Node 파이프라인용, 순수 함수)
// 투자 조언이 아닌 스크리닝 도구. 점수는 지표 기반이며 수익을 보장하지 않음.

export function ma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

export function rsi(closes, n = 14) {
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

export function atr(highs, lows, closes, n = 14) {
  if (closes.length < n + 1) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    s += tr;
  }
  return s / n;
}

export const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

export function gradeOf(s) {
  if (s >= 85) return ['A+', 'g-aplus'];
  if (s >= 75) return ['A', 'g-a'];
  if (s >= 65) return ['B+', 'g-bplus'];
  if (s >= 55) return ['B', 'g-b'];
  if (s >= 45) return ['C+', 'g-cplus'];
  if (s >= 35) return ['C', 'g-c'];
  return ['D', 'g-d'];
}

export function signalOf(s) {
  if (s >= 75) return ['BUY WATCH', 's-buy'];
  if (s >= 55) return ['WATCH', 's-watch'];
  if (s >= 35) return ['WAIT', 's-wait'];
  return ['AVOID', 's-avoid'];
}

/* 100점 스코어링. coin: {closes, highs, lows, vols, ticker} — 지표 필드를 coin._* 에 기록 */
export function scoreCoin(c, btcRet30, regimeAdj) {
  const { closes, highs, lows, vols } = c;
  const close = closes[closes.length - 1];
  const f = {};
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
