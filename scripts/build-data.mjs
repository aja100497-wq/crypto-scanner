// 코인 스캐너 데이터 파이프라인: 업비트 수집 → 100점 스코어링 → data.json 생성
// 5분마다 크론으로 실행. 브라우저는 data.json(동일 오리진)만 읽으므로 CORS/요청제한 문제 없음.
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ma, scoreCoin, gradeOf, signalOf } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.upbit.com/v1';
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'EURI', 'XAUT']);
const TOP_N = 50;
const CANDLE_COUNT = 90;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[build-data]', ...a);

async function api(path, attempt = 0) {
  const MAX = 8;
  let res = null, err = null;
  try { res = await fetch(API + path); } catch (e) { err = e; }
  if (err || (res && (res.status === 429 || res.status >= 500))) {
    if (attempt >= MAX) throw err || new Error('API ' + res.status + ' ' + path);
    const wait = Math.min(20000, 1500 * Math.pow(2, attempt)) + Math.random() * 500;
    log(`retry ${attempt + 1}/${MAX} after ${Math.round(wait)}ms (${path.slice(0, 40)}…)`);
    await sleep(wait);
    return api(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status} ${path}`);
  return res.json();
}

async function main() {
  log('마켓 목록 수집…');
  const all = await api('/market/all?isDetails=false');
  const markets = all.filter(m => m.market.startsWith('KRW-') && !STABLES.has(m.market.slice(4)));
  const nameMap = Object.fromEntries(markets.map(m => [m.market, m]));
  log(`KRW 마켓 ${markets.length}개`);

  log('24h 시세 수집…');
  const tickers = [];
  for (let i = 0; i < markets.length; i += 80) {
    const q = markets.slice(i, i + 80).map(m => m.market).join(',');
    tickers.push(...await api('/ticker?markets=' + q));
    await sleep(500);
  }

  log('BTC 기준 데이터 수집…');
  const btcC = await api('/candles/days?market=KRW-BTC&count=' + CANDLE_COUNT);
  const btcCloses = btcC.map(c => c.trade_price).reverse();
  const btcRet30 = btcCloses.length >= 31
    ? btcCloses[btcCloses.length - 1] / btcCloses[btcCloses.length - 31] - 1 : null;
  const btcMa20 = ma(btcCloses, 20), btcMa60 = ma(btcCloses, 60);
  const btcClose = btcCloses[btcCloses.length - 1];
  let regime;
  if (btcMa20 && btcMa60 && btcClose > btcMa20 && btcMa20 > btcMa60) {
    regime = { label: '🔴 강세장', cls: 'bull', adj: 0, note: 'BTC가 20일·60일선 위 정배열 — 추세 추종 전략이 유리한 국면입니다.' };
  } else if (btcMa20 && btcMa60 && btcClose < btcMa20 && btcMa20 < btcMa60) {
    regime = { label: '🔵 약세장', cls: 'bear', adj: -5, note: 'BTC가 20일·60일선 아래 역배열 — 전체 점수 −5 조정, 보수적 접근을 권장합니다.' };
  } else {
    regime = { label: '🟡 횡보/혼조', cls: 'flat', adj: 0, note: 'BTC 추세가 불분명 — 돌파·박스권 전략 병행, 손절 기준을 엄격히.' };
  }
  log('시장 국면:', regime.label);

  const sorted = tickers
    .filter(t => nameMap[t.market])
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, TOP_N);

  log(`상위 ${sorted.length}개 캔들 수집…`);
  const coins = [];
  let done = 0;
  for (let i = 0; i < sorted.length; i += 2) {
    const batch = sorted.slice(i, i + 2);
    const res = await Promise.all(batch.map(async t => {
      try { return { t, cs: await api(`/candles/days?market=${t.market}&count=${CANDLE_COUNT}`) }; }
      catch (e) { log('캔들 실패:', t.market, e.message); return null; }
    }));
    for (const r of res) {
      done++;
      if (!r || !r.cs || r.cs.length < 20) continue;
      const cs = r.cs.slice().reverse();
      const coin = {
        market: r.t.market, ticker: r.t,
        closes: cs.map(c => c.trade_price),
        highs: cs.map(c => c.high_price),
        lows: cs.map(c => c.low_price),
        vols: cs.map(c => c.candle_acc_trade_volume),
      };
      const { score, factors, demerits } = scoreCoin(coin, btcRet30, regime.adj);
      const [grade, gradeClass] = gradeOf(score);
      const [signal, signalClass] = signalOf(score);
      coins.push({
        market: coin.market,
        korean: nameMap[coin.market].korean_name,
        english: nameMap[coin.market].english_name,
        price: r.t.trade_price,
        chg24: r.t.signed_change_rate,
        high24: r.t.high_price,
        low24: r.t.low_price,
        tradeValue24: r.t.acc_trade_price_24h,
        score, grade, gradeClass, signal, signalClass,
        rsi: coin._rsi, ma20: coin._ma20, ma60: coin._ma60,
        distHigh: coin._distHigh, volRatio: coin._volRatio,
        ret7: coin._ret7 ?? null, ret30: coin._ret30 ?? null, exRet: coin._exRet ?? null,
        atrPct: coin._atrPct,
        factors, demerits,
        spark: coin.closes.slice(-90),
      });
    }
    log(`캔들 ${done}/${sorted.length}`);
    await sleep(600);
  }

  coins.sort((a, b) => b.score - a.score);
  const data = {
    updated: new Date().toISOString(),
    updatedKst: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    regime: { label: regime.label, cls: regime.cls, note: regime.note },
    btcRet30,
    coins,
  };
  writeFileSync(join(ROOT, 'data.json'), JSON.stringify(data));
  log(`data.json 저장 완료 (${coins.length}개 코인)`);
  const top = coins[0];
  if (top) log(`1위: ${top.korean} ${top.score}점 (${top.grade})`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
