// api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD 6 timeframe (D/4H/1H/30M/15M/5M) -> คำนวณ indicator เอง
// (RSI/MACD/EMA/Stochastic + จุดหักแบบ deterministic) -> วิเคราะห์โครงสร้าง+SMC+แผนเทรดวันต่อวันด้วย Claude
// -> เก็บลง Supabase -> แจ้งเตือน Telegram (ส่งทุกครั้งที่รัน วันละ 4 รอบ)
//
// สำคัญ: ค่าทั้งหมดด้านล่างต้องตั้งเป็น Environment Variable บน Vercel เท่านั้น
// ห้ามเขียนค่าจริงลงในไฟล์นี้หรือใส่ไว้ในคอมเมนต์เด็ดขาด (เคยมีปัญหา key หลุดมาก่อน)
//
// ENV VARS ที่ต้องตั้งใน Vercel Project Settings -> Environment Variables:
//   TWELVEDATA_API_KEY   = API key จาก twelvedata.com
//   ANTHROPIC_API_KEY    = API key จาก console.anthropic.com
//   SUPABASE_URL         = URL โปรเจกต์ Supabase
//   SUPABASE_SERVICE_KEY = service_role key ของ Supabase (ใช้ฝั่งเซิร์ฟเวอร์เท่านั้น)
//   TELEGRAM_BOT_TOKEN   = token ของ Telegram Bot (จาก BotFather)
//   TELEGRAM_CHAT_ID     = chat id ปลายทางที่จะรับการแจ้งเตือน
//   CRON_SECRET          = string สุ่มยาวๆ กันคนนอกยิง endpoint นี้เล่น
//
// หมายเหตุขอบเขต: ระบบนี้เป็นเครื่องมือ "วิเคราะห์แล้วแจ้งเตือน" เท่านั้น ไม่เชื่อมต่อบัญชีเทรดจริง
// ไม่มีการส่งคำสั่งซื้อขายหรือปิดออเดอร์ใดๆ ทั้งสิ้น
//
// ===== ระบบใหม่ (day-trade only, buy-biased, จับคู่ TF แยก 2 แผนอิสระ) =====
// - วิเคราะห์ 6 timeframe แบบ top-down เพื่อบริบท/SMC: D > 4H > 1H > 30M > 15M > 5M
// - เทรด "จบในวันเดียว" เท่านั้น ไม่มีแผนถือข้ามคืน/หลายวันอีกต่อไป
// - Bias เริ่มต้นเน้น Long เป็นหลัก จะเสนอ Short ได้ก็ต่อเมื่อ trend ของ D และ 4H เป็น "Bearish" ชัดเจนทั้งคู่
//   (คำนวณ trend แบบ deterministic จากการเรียง EMA20/50/200 ไม่ใช่ให้ AI ประเมินเอง กัน AI มองเทรนด์ผิด)
// - แผนเข้าไม้แยกเป็น "คู่ TF" อิสระกัน 2 คู่ แต่ละคู่มี Entry/SL/TP ของตัวเอง:
//     คู่ A = 4H (เทรนด์ใหญ่) ↔ 15M (จุดเข้าไม้)
//     คู่ B = 1H (เทรนด์ใหญ่) ↔ 5M (จุดเข้าไม้ ไวกว่า/สแคลป์)
//   (30M เป็นแค่บริบทประกอบในแดชบอร์ด ไม่ได้ใช้เป็นเงื่อนไขเข้าไม้แล้ว)
// - "จุดหัก" (จุดกลับตัวปลายแหลม) คำนวณแบบ deterministic จาก wick/body ของแท่งที่เป็นจุดสวิงจริง
//   (ไม่ใช่ทุกจุดสวิงจะหัก - ต้องปลายแหลมเท่านั้น ถ้าไม่แหลมคือไม่หัก)
// - เงื่อนไขเข้าไม้ต่อคู่ (hard gate, บังคับด้วยโค้ดไม่ใช่แค่สั่ง AI): เทรนด์ของ TF ใหญ่ต้อง "ตรงทิศ" กับ
//   จุดหักของ TF เล็ก + Stochastic ของ TF เล็กต้องตัดกันอยู่ในโซนกลับตัวตรงทิศทาง (ต่ำกว่า 25 = ซื้อ / เหนือ 75 = ขาย)
//   ถ้า TF ใหญ่เป็น Sideway หรือทิศไม่ตรงกัน = ไม่คอนเฟิร์มเลย ระบบจะล้างช่อง entry_zone/stop_loss/take_profit
//   ของคู่นั้นเป็น "-" เองไม่ว่า AI จะตอบว่าอย่างไร — คู่ A และคู่ B เป็นอิสระต่อกัน คู่หนึ่งคอนเฟิร์มได้โดยอีกคู่ยังไม่คอนเฟิร์มก็ได้

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://claude-xau.vercel.app/';

const SYMBOL = 'XAU/USD';
const CANDLE_COUNT = 220; // เผื่อคำนวณ EMA200 ได้แม่นยำขึ้น (ใช้เท่ากันทุก timeframe)

// timeframe key ที่ใช้เก็บ/แสดงผล -> interval ที่ต้องส่งให้ Twelve Data
// เรียงจากใหญ่ไปเล็กตามหลัก D > 4H > 1H > 30M > 15M > 5M
const TIMEFRAMES = {
  D: '1day',
  '4h': '4h',
  '1h': '1h',
  '30m': '30min',
  '15m': '15min',
  '5m': '5min',
};

// TF หลักที่ใช้ตัดสินใจเข้าไม้จริง (เล่นสั้น ไม่ถือยาว) ส่วนที่เหลือเป็นบริบทประกอบ
const PRIMARY_TFS = ['1h', '30m', '15m'];

// จำนวนแท่งล่าสุดที่ส่งให้ Claude อ่านต่อ timeframe (คุมต้นทุน token)
// TF หลักให้รายละเอียดมากกว่า TF บริบท เพราะใช้ตัดสินใจเข้าไม้จริง
const CLAUDE_CANDLE_WINDOW = {
  D: 20,
  '4h': 25,
  '1h': 40,
  '30m': 40,
  '15m': 40,
  '5m': 25,
};

module.exports = async function handler(req, res) {
  // กันคนนอกเรียก endpoint ตรงๆ — ต้องแนบ secret มาด้วยทุกครั้ง
  const authHeader = req.headers['authorization'];
  const querySecret = req.query && req.query.secret;
  const expected = process.env.CRON_SECRET;
  const provided = authHeader === `Bearer ${expected}` ? true : querySecret === expected;
  if (!expected || !provided) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // โหมดทดสอบ Telegram อย่างเดียว — ไม่เรียก TwelveData/Claude ให้เสียเครดิต แค่เช็คว่า token/chat_id เชื่อมได้จริง
  // เรียกผ่าน: GET /api/analyze?secret=...&test_telegram=1
  if (req.query && req.query.test_telegram === '1') {
    const result = await testTelegram();
    return res.status(result.ok ? 200 : 500).json(result);
  }

  try {
    const candlesByTf = await fetchAllTimeframes();
    const indicatorsByTf = {};
    Object.keys(candlesByTf).forEach((k) => (indicatorsByTf[k] = computeIndicators(candlesByTf[k])));

    // คำนวณสัญญาณ 2 คู่ (4H↔15M, 1H↔5M: TF ใหญ่ยืนยันทิศ + จุดหัก/Stochastic ของ TF เล็ก) และ buy-bias gate (trend D+4H) แบบ deterministic
    const pairSignals = buildPairSignals(candlesByTf, indicatorsByTf);
    const shortAllowed = indicatorsByTf['D'].trendClass === 'Bearish' && indicatorsByTf['4h'].trendClass === 'Bearish';

    const analysis = await analyzeWithClaude(candlesByTf, indicatorsByTf, pairSignals, shortAllowed);
    enforcePairGates(analysis, pairSignals, shortAllowed);

    const previous = await getLastAnalysis();
    await saveToSupabase(candlesByTf, indicatorsByTf, analysis);

    // แจ้งเตือนทุกครั้งที่วิเคราะห์เสร็จ (ไม่กรองเฉพาะตอนสัญญาณเปลี่ยนแล้ว)
    const isNewSignal =
      analysis.bias && analysis.bias !== 'Wait' && analysis.bias !== (previous && previous.bias);
    await notifyTelegram(analysis, previous, isNewSignal);

    return res.status(200).json({
      ok: true,
      bias: analysis.bias,
      pair_4h_15m_ready: pairSignals.pairA.confirmed,
      pair_1h_5m_ready: pairSignals.pairB.confirmed,
      notified: true,
    });
  } catch (err) {
    console.error('analyze.js error:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- 1) ดึงราคา OHLC จาก Twelve Data (6 timeframe) ----------
async function fetchGoldCandles(interval) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า TWELVEDATA_API_KEY');

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&outputsize=${CANDLE_COUNT}&apikey=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();

  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data error (${interval}): ` + JSON.stringify(data));
  }

  return data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // เรียงจากเก่า -> ใหม่
}

async function fetchAllTimeframes() {
  const keys = Object.keys(TIMEFRAMES); // ['D','4h','1h','30m','15m','5m']
  const results = await Promise.all(keys.map((k) => fetchGoldCandles(TIMEFRAMES[k])));
  const out = {};
  keys.forEach((k, i) => (out[k] = results[i]));
  return out;
}

// ---------- 2) คำนวณ Technical Indicator เอง (แม่นยำกว่าให้ AI คำนวณเลขเอง) ----------
function calcEMASeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed = seed / period;
  out[period - 1] = seed;
  let ema = seed;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes, fast, slow, signalPeriod) {
  fast = fast || 12;
  slow = slow || 26;
  signalPeriod = signalPeriod || 9;
  if (closes.length < slow + signalPeriod) return null;

  const emaFast = calcEMASeries(closes, fast);
  const emaSlow = calcEMASeries(closes, slow);
  const macdValues = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdValues.push(emaFast[i] - emaSlow[i]);
  }
  const signalSeries = calcEMASeries(macdValues, signalPeriod);
  const macdLine = macdValues[macdValues.length - 1];
  const signalLine = lastDefined(signalSeries);
  if (macdLine == null || signalLine == null) return null;
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

// ---- Stochastic Oscillator (%K สมูทแล้ว / %D) ----
function smaIgnoreLeadingNulls(arr, period) {
  const out = new Array(arr.length).fill(null);
  let windowVals = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) {
      windowVals = [];
      continue;
    }
    windowVals.push(arr[i]);
    if (windowVals.length > period) windowVals.shift();
    if (windowVals.length === period) out[i] = windowVals.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

function calcStochasticSeries(candles, kPeriod, smoothK, dPeriod) {
  kPeriod = kPeriod || 14;
  smoothK = smoothK || 3;
  dPeriod = dPeriod || 3;
  const n = candles.length;
  const rawK = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    rawK[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const kSeries = smaIgnoreLeadingNulls(rawK, smoothK);
  const dSeries = smaIgnoreLeadingNulls(kSeries, dPeriod);
  return { kSeries, dSeries };
}

// หา crossover ล่าสุดภายใน `lookback` แท่ง ที่ตัดกันอยู่ในโซนกลับตัว (เหนือ 75 = Sell / ต่ำกว่า 25 = Buy)
function detectStochSignal(kSeries, dSeries, lookback) {
  lookback = lookback || 3;
  const n = kSeries.length;
  for (let i = n - 1; i >= Math.max(1, n - lookback); i--) {
    const k = kSeries[i];
    const d = dSeries[i];
    const pk = kSeries[i - 1];
    const pd = dSeries[i - 1];
    if (k == null || d == null || pk == null || pd == null) continue;
    const crossUp = pk <= pd && k > d;
    const crossDown = pk >= pd && k < d;
    if (crossUp && k <= 25 && d <= 25) return { signal: 'Buy', zone: '<25', k: round2(k), d: round2(d), index: i };
    if (crossDown && k >= 75 && d >= 75) return { signal: 'Sell', zone: '>75', k: round2(k), d: round2(d), index: i };
  }
  return null;
}

// ---- "จุดหัก" (จุดกลับตัวปลายแหลม) — fractal swing point ที่ wick ยาวเด่นชัดกว่า body (ปลายแหลมจริง) ----
function isSwingLow(candles, i, bars) {
  for (let j = i - bars; j <= i + bars; j++) {
    if (j === i) continue;
    if (candles[j].low < candles[i].low) return false;
  }
  return true;
}
function isSwingHigh(candles, i, bars) {
  for (let j = i - bars; j <= i + bars; j++) {
    if (j === i) continue;
    if (candles[j].high > candles[i].high) return false;
  }
  return true;
}
// เกณฑ์ "ปลายแหลม": wick ด้านที่กลับตัวต้องยาวกว่า body อย่างน้อย 1.5 เท่า และกิน >=45% ของ range ทั้งแท่ง
// ถ้า wick ไม่เด่นแบบนี้ = ปลายไม่แหลม = ไม่ถือเป็นจุดหัก (ไม่เข้าเงื่อนไขเลย ตามที่ขอ)
function isSharpTip(c, direction) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  if (direction === 'bullish') {
    if (body === 0) return lowerWick / range >= 0.5;
    return lowerWick >= body * 1.5 && lowerWick / range >= 0.45;
  }
  if (body === 0) return upperWick / range >= 0.5;
  return upperWick >= body * 1.5 && upperWick / range >= 0.45;
}

function detectSharpReversals(candles, bars) {
  bars = bars || 2;
  const out = [];
  for (let i = bars; i < candles.length - bars; i++) {
    if (isSwingLow(candles, i, bars) && isSharpTip(candles[i], 'bullish')) {
      out.push({ index: i, time: candles[i].time, price: candles[i].low, direction: 'bullish' });
    } else if (isSwingHigh(candles, i, bars) && isSharpTip(candles[i], 'bearish')) {
      out.push({ index: i, time: candles[i].time, price: candles[i].high, direction: 'bearish' });
    }
  }
  return out;
}

// เอาจุดหักล่าสุด เฉพาะถ้ายังสดอยู่ (เกิดภายใน recencyBars แท่งที่ผ่านมา) ไม่งั้นถือว่าเก่าเกินจะใช้
function mostRecentWithin(list, totalLen, recencyBars) {
  if (!list.length) return null;
  const last = list[list.length - 1];
  if (totalLen - 1 - last.index > recencyBars) return null;
  return last;
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

// เทรนด์แบบ deterministic จากการเรียงตัวของ EMA20/50/200 — ใช้ตัดสิน Sideway ชัดเจน ไม่ให้ AI ประเมินเอง
function trendClassFromEMA(ema20, ema50, ema200) {
  if (ema20 == null || ema50 == null || ema200 == null) return 'Sideway';
  if (ema20 > ema50 && ema50 > ema200) return 'Bullish';
  if (ema20 < ema50 && ema50 < ema200) return 'Bearish';
  return 'Sideway';
}

function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const ema20 = round2(lastDefined(calcEMASeries(closes, 20)));
  const ema50 = round2(lastDefined(calcEMASeries(closes, 50)));
  const ema200 = closes.length >= 200 ? round2(lastDefined(calcEMASeries(closes, 200))) : null;
  const rsi14 = round2(calcRSI(closes, 14));
  const macdRaw = calcMACD(closes);
  const macd = macdRaw
    ? { macdLine: round2(macdRaw.macdLine), signalLine: round2(macdRaw.signalLine), histogram: round2(macdRaw.histogram) }
    : null;

  let macdStatus = 'Neutral';
  if (macd) macdStatus = macd.histogram > 0 ? 'Bullish' : macd.histogram < 0 ? 'Bearish' : 'Neutral';

  let rsiStatus = 'Neutral';
  if (rsi14 != null) rsiStatus = rsi14 >= 70 ? 'Overbought' : rsi14 <= 30 ? 'Oversold' : 'Neutral';

  const { kSeries, dSeries } = calcStochasticSeries(candles, 14, 3, 3);
  const stochK = round2(lastDefined(kSeries));
  const stochD = round2(lastDefined(dSeries));
  const stochCross = detectStochSignal(kSeries, dSeries, 3);

  const trendClass = trendClassFromEMA(ema20, ema50, ema200);

  return {
    ema20,
    ema50,
    ema200,
    rsi14,
    rsiStatus,
    macd,
    macdStatus,
    stochK,
    stochD,
    stochSignal: stochCross ? stochCross.signal : null, // 'Buy' | 'Sell' | null
    stochZone: stochCross ? stochCross.zone : null,
    trendClass, // 'Bullish' | 'Bearish' | 'Sideway' — deterministic, ไม่ใช่จาก AI
  };
}

// ---------- 2.5) สัญญาณแบบจับคู่ TF: 4H↔15M (pair A) และ 1H↔5M (pair B) ----------
// กติกาต่อคู่ (hard gate ทั้งคู่ ไม่ใช่แค่ TF เล็กอย่างเดียวเหมือนระบบเดิม):
//   - เทรนด์ของ TF ใหญ่ (deterministic จาก EMA) ต้อง "ตรงทิศ" กับจุดหัก (ปลายแหลม) ของ TF เล็ก
//   - Stochastic ของ TF เล็กต้องตัดกันในโซนกลับตัวที่ตรงทิศทางเดียวกันด้วย
//   - ถ้า TF ใหญ่เป็น Sideway = ไม่คอนเฟิร์มเด็ดขาด (ไม่มีทิศให้ตรงด้วย)
//   - คู่ไหนจะเสนอ Short ได้ ต้องผ่าน shortAllowed (D+4H Bearish ชัดเจนทั้งคู่) เพิ่มอีกชั้นด้วย (buy-bias skew เดิม)
function buildPairSignal(candlesLTF, indicatorsLTF, trendBig, recencyBars) {
  const reversals = detectSharpReversals(candlesLTF, 2);
  const latest = mostRecentWithin(reversals, candlesLTF.length, recencyBars);
  const stochSignal = indicatorsLTF ? indicatorsLTF.stochSignal : null; // 'Buy' | 'Sell' | null

  const bullMatch = trendBig === 'Bullish' && latest && latest.direction === 'bullish' && stochSignal === 'Buy';
  const bearMatch = trendBig === 'Bearish' && latest && latest.direction === 'bearish' && stochSignal === 'Sell';
  const confirmed = !!(bullMatch || bearMatch);

  return {
    confirmed,
    direction: confirmed ? (bullMatch ? 'Long' : 'Short') : null,
    trendBig,
    latestReversal: latest ? { direction: latest.direction, price: latest.price, time: latest.time } : null,
    stochSignal,
  };
}

function buildPairSignals(candlesByTf, indicatorsByTf) {
  // Pair A: 4H (เทรนด์ใหญ่) ↔ 15M (จุดเข้าไม้) — recency 4 แท่ง 15M (~1 ชม.)
  const pairA = buildPairSignal(candlesByTf['15m'], indicatorsByTf['15m'], indicatorsByTf['4h'].trendClass, 4);
  // Pair B: 1H (เทรนด์ใหญ่) ↔ 5M (จุดเข้าไม้) — recency 6 แท่ง 5M (~30 นาที, ไวกว่าเพราะ 5M เป็นสแคลป์)
  const pairB = buildPairSignal(candlesByTf['5m'], indicatorsByTf['5m'], indicatorsByTf['1h'].trendClass, 6);
  return { pairA, pairB };
}

function pairStatusText(pair, bigLabel, smallLabel) {
  if (pair.confirmed) {
    return `คอนเฟิร์ม: เทรนด์ ${bigLabel} (${pair.trendBig}) ตรงกับจุดหัก + Stochastic ของ ${smallLabel} แล้ว`;
  }
  if (!pair.latestReversal) {
    return `${smallLabel} ยังไม่เกิดจุดหักที่ชัดเจน (ปลายยังไม่แหลม) — รอสัญญาณ`;
  }
  if (pair.trendBig === 'Sideway') {
    return `${smallLabel} มีจุดหัก (${pair.latestReversal.direction}) แล้ว แต่ ${bigLabel} ยัง Sideway อยู่ — ไม่คอนเฟิร์ม`;
  }
  const bigDirWord = pair.trendBig === 'Bullish' ? 'bullish' : 'bearish';
  if (pair.latestReversal.direction !== bigDirWord) {
    return `${smallLabel} มีจุดหัก (${pair.latestReversal.direction}) แต่ทิศทางขัดกับเทรนด์ ${bigLabel} (${pair.trendBig}) — ไม่เข้า`;
  }
  if (!pair.stochSignal || ((pair.trendBig === 'Bullish' && pair.stochSignal !== 'Buy') || (pair.trendBig === 'Bearish' && pair.stochSignal !== 'Sell'))) {
    return `${smallLabel} มีจุดหักตรงทิศ ${bigLabel} แล้ว (${pair.latestReversal.direction}) แต่ Stochastic ของ ${smallLabel} ยังไม่ยืนยันโซนกลับตัว — รอก่อน`;
  }
  return `ยังไม่ครบเงื่อนไขคอนเฟิร์มของคู่ ${bigLabel}↔${smallLabel}`;
}

// บังคับ hard gate ด้วยโค้ด ไม่ไว้ใจแค่คำสั่งใน prompt — ล้างช่องเข้าไม้ถ้าเงื่อนไขยังไม่ครบ (ทำทั้ง 2 คู่แยกกัน)
function enforceOnePairGate(planFromClaude, pair, shortAllowed, bigLabel, smallLabel) {
  const plan = planFromClaude || {};
  plan.pair = `${bigLabel}+${smallLabel}`;
  plan.confirmed = pair.confirmed;
  plan.detail = {
    trendBig: pair.trendBig,
    latestReversal: pair.latestReversal,
    stochSignal: pair.stochSignal,
  };

  let blockedByShortGate = false;
  if (pair.direction === 'Short' && !shortAllowed) blockedByShortGate = true;

  plan.status_text = blockedByShortGate
    ? `${pairStatusText(pair, bigLabel, smallLabel)} · ไม่อนุญาตให้ Short เพราะเทรนด์ใหญ่ (D/4H) ยังไม่ Bearish ชัดเจน (เน้น Buy เป็นหลัก)`
    : pairStatusText(pair, bigLabel, smallLabel);

  const entryReady = pair.confirmed && !blockedByShortGate;

  if (!entryReady) {
    plan.direction = blockedByShortGate ? null : pair.direction;
    plan.entry_zone = '-';
    plan.stop_loss = '-';
    plan.take_profit = [];
    plan.rr_ratio = '-';
  } else {
    plan.direction = pair.direction;
  }
  plan.confirmed = entryReady;
  return plan;
}

function enforcePairGates(analysis, pairSignals, shortAllowed) {
  analysis.trade_idea = analysis.trade_idea || {};
  analysis.trade_idea.plan_4h_15m = enforceOnePairGate(
    analysis.trade_idea.plan_4h_15m, pairSignals.pairA, shortAllowed, '4H', '15M'
  );
  analysis.trade_idea.plan_1h_5m = enforceOnePairGate(
    analysis.trade_idea.plan_1h_5m, pairSignals.pairB, shortAllowed, '1H', '5M'
  );

  // overall_bias (ใช้แสดงป้ายรวมบนแดชบอร์ด) ก็ผ่าน buy-bias skew เดียวกัน
  if (analysis.bias === 'Short' && !shortAllowed) {
    analysis.bias = 'Wait';
  }
}

// ---------- 3) วิเคราะห์ด้วย Claude API (6 timeframe + indicator จริง + SMC + แผนเทรดวันเดียว) ----------
const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปโครงสร้างราคาทางเทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น แนว Smart Money Concepts (SMC) และ Price Action
คุณจะได้รับข้อมูลแท่งเทียนและ indicator ที่คำนวณแม่นยำแล้วของ 6 timeframe เรียงจากใหญ่ไปเล็ก: D (Daily) > 4H > 1H > 30M > 15M > 5M
ใช้ตัวเลข indicator ที่ให้มาตรงๆ (RSI14, MACD, EMA20/50/200, Stochastic %K/%D) ห้ามคำนวณเอง และห้ามเปลี่ยนค่า "trend" ของแต่ละ timeframe ที่ระบบคำนวณมาให้ (Bullish/Bearish/Sideway มาจากการเรียง EMA แบบตายตัว) — หน้าที่คุณคืออธิบายเหตุผลเชิงโครงสร้าง (SMC/แนวรับแนวต้าน) ประกอบ ไม่ใช่เปลี่ยนค่า trend เอง

กฎสำคัญที่ต้องทำตามเป๊ะๆ (ระบบมีการบังคับด้วยโค้ดอีกชั้นอยู่แล้ว แต่ต้องตอบให้สอดคล้องกันด้วย):

1) BUY-BIAS: ให้เน้นฝั่ง Long เป็นหลักเสมอ จะเสนอ overall_bias เป็น "Short" ได้ก็ต่อเมื่อ trend ของ D และ 4H เป็น "Bearish" ชัดเจนทั้งคู่เท่านั้น (ระบบจะแจ้งมาให้ว่า shortAllowed = true/false) ถ้า shortAllowed = false ห้ามตอบ "Short" เด็ดขาด ให้ตอบ "Long" (ถ้ามีเหตุผลสนับสนุน) หรือ "Wait" แทน ห้ามใช้ภาวะ Sideway เป็นเหตุผลเข้า Short

2) เล่นสั้นจบในวันเดียว: ทุกแผนต้องปิดภายในวันเดียวกัน ไม่มีแผนถือข้ามคืนหรือหลายวันอีกต่อไป ถ้าใกล้หมดช่วงเวลาที่เหมาะเทรดของวันนั้นให้เตือนใน plan_summary

3) ระบบวิเคราะห์เป็น "คู่ TF" (TF ใหญ่ = เทรนด์/บริบท, TF เล็ก = จุดเข้าไม้) แยก 2 คู่อิสระกัน ไม่ใช่แผนเดียวอีกต่อไป:
   - คู่ A = 4H (ใหญ่) ↔ 15M (เล็ก)
   - คู่ B = 1H (ใหญ่) ↔ 5M (เล็ก)
   แต่ละคู่มีแผนเทรดของตัวเอง ไม่เกี่ยวกัน — คู่หนึ่งคอนเฟิร์มอาจจะมีแผน ส่วนอีกคู่ยังไม่คอนเฟิร์มก็ได้ ให้ตอบทั้ง 2 คู่เสมอ (30M เป็นแค่บริบทประกอบไม่ใช่ TF เข้าไม้แล้ว)

4) เงื่อนไขคอนเฟิร์มต่อคู่ (ระบบคำนวณมาให้แล้วเป็น object "pairA"/"pairB" — ใช้ตรงๆ ห้ามตีความใหม่):
   - เทรนด์ของ TF ใหญ่ (deterministic จาก EMA: Bullish/Bearish/Sideway) ต้อง "ตรงทิศ" กับ "จุดหัก" (จุดกลับตัวปลายแหลม) ที่เกิดบน TF เล็ก — ถ้า TF ใหญ่เป็น Sideway ถือว่าไม่คอนเฟิร์มเสมอ
   - Stochastic ของ TF เล็กต้องตัดกันอยู่ในโซนกลับตัวที่ตรงทิศทางเดียวกันด้วย (ต่ำกว่า 25 = ซื้อ / เหนือ 75 = ขาย)
   - ถ้า pairX.confirmed = false ห้ามใส่ตัวเลขใน entry_zone/stop_loss/take_profit ของคู่นั้นเด็ดขาด ให้ใส่ "-" ทุกช่อง (ระบบจะล้างค่าให้ตรงกันอีกชั้นอยู่แล้วถ้าคุณพลาด)

5) ทุก field ข้อความต้องกระชับที่สุด — "structure_note" และ "smc_zones" ของแต่ละ timeframe ห้ามเกิน 1 ประโยคสั้นๆ (ไม่เกิน ~25 คำ), "overall_structure_note" และ "plan_summary" ห้ามเกิน 3 ประโยคสั้นๆ, "confidence_note" ห้ามเกิน 1 ประโยค, "note" ในแต่ละแผนห้ามเกิน 1 ประโยคสั้นๆ ห้ามใส่รายละเอียดราคาซ้ำกับ support/resistance levels ที่มีอยู่แล้ว เพราะคำตอบต้องจบเป็น JSON ที่สมบูรณ์เสมอ ห้ามถูกตัดกลางคัน

ตอบกลับเป็น JSON ล้วนๆ เท่านั้น (ไม่มีข้อความอื่นนอก JSON ไม่มี markdown code fence) ตามโครงสร้างนี้เป๊ะๆ:
{
  "overall_bias": "Long หรือ Short หรือ Wait",
  "overall_structure_note": "สรุปภาพรวมจากทั้ง 6 timeframe สั้นๆ ว่าสอดคล้องกันไหม (confluence) หรือขัดแย้งกันตรงไหน เน้นว่าคู่ A (4H/15M) และคู่ B (1H/5M) เป็นอย่างไร",
  "plan_summary": "สรุปแผนของวันนี้สั้นๆ ไม่เกิน 4 บรรทัด บอกว่าคู่ไหนน่าสนใจกว่า โซนที่น่าสนใจ ย้ำว่าต้องจบในวัน ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย เช่น ห้ามพูดว่า \\"ให้เข้าซื้อตอนนี้\\"",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่จะทำให้มุมมองนี้เปลี่ยนไป",
  "confidence_score": 0,
  "trade_idea": {
    "plan_4h_15m": {
      "entry_zone": "ช่วงราคาที่น่าสนใจ อิงโครงสร้าง 15M เป็นหลัก เช่น '4478-4487' ถ้า pairA ยังไม่ confirmed ให้ใส่ '-'",
      "stop_loss": "ราคา SL วางเลยจุดหักล่าสุดของ 15M ไปพอประมาณ กันโดน noise สะบัด หรือ '-' ถ้ายังไม่ confirmed",
      "take_profit": ["TP1", "TP2"],
      "rr_ratio": "เช่น '1:1.8' หรือ '-'",
      "note": "อธิบายสั้นๆ 1 ประโยคเกี่ยวกับคู่นี้ หรือทำไมควรปิดไม้ภายในวันนี้"
    },
    "plan_1h_5m": {
      "entry_zone": "ช่วงราคาที่น่าสนใจ อิงโครงสร้าง 5M เป็นหลัก เช่น '4478-4487' ถ้า pairB ยังไม่ confirmed ให้ใส่ '-'",
      "stop_loss": "ราคา SL วางเลยจุดหักล่าสุดของ 5M ไปพอประมาณ กันโดน noise สะบัด หรือ '-' ถ้ายังไม่ confirmed",
      "take_profit": ["TP1", "TP2"],
      "rr_ratio": "เช่น '1:1.5' หรือ '-'",
      "note": "อธิบายสั้นๆ 1 ประโยคเกี่ยวกับคู่นี้ (สแคลป์ไวกว่าคู่ 4H/15M) หรือทำไมควรปิดไม้ภายในวันนี้"
    }
  },
  "timeframes": {
    "D": { "trend": "ใช้ค่าที่ระบบให้มาตรงๆ", "bias": "Long หรือ Short หรือ Wait", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "4h": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "1h": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "30m": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "15m": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "5m": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] }
  }
}
สำคัญ: นี่คือการสรุปโครงสร้างราคาเพื่อประกอบการตัดสินใจของผู้ใช้เอง ไม่ใช่คำแนะนำการลงทุนที่รับประกันผลลัพธ์ และไม่ใช่คำสั่งซื้อขายที่ชี้นำโดยตรง confidence_score คือความมั่นใจของ "การอ่านโครงสร้าง" ไม่ใช่การการันตีผลกำไร`;

async function analyzeWithClaude(candlesByTf, indicatorsByTf, pairSignals, shortAllowed) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY');

  const tfKeys = Object.keys(TIMEFRAMES);
  const lastPrice = candlesByTf['15m'][candlesByTf['15m'].length - 1].close;
  const nowThai = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' });

  const fmtIndicators = (ind) => {
    if (!ind) return 'ไม่มีข้อมูล indicator';
    const macdText = ind.macd
      ? `MACD line ${ind.macd.macdLine} / signal ${ind.macd.signalLine} / histogram ${ind.macd.histogram} (${ind.macdStatus})`
      : 'MACD: ข้อมูลไม่พอคำนวณ';
    const stochText = `Stochastic %K ${ind.stochK != null ? ind.stochK : '-'} / %D ${ind.stochD != null ? ind.stochD : '-'}${
      ind.stochSignal ? ` -> สัญญาณ ${ind.stochSignal} (ตัดกันในโซน ${ind.stochZone})` : ' (ยังไม่มี crossover ในโซนกลับตัวล่าสุด)'
    }`;
    return (
      `Trend (deterministic จาก EMA): ${ind.trendClass}\n` +
      `RSI14: ${ind.rsi14 != null ? ind.rsi14 : '-'} (${ind.rsiStatus})\n` +
      `${macdText}\n` +
      `${stochText}\n` +
      `EMA20: ${ind.ema20 != null ? ind.ema20 : '-'} / EMA50: ${ind.ema50 != null ? ind.ema50 : '-'} / EMA200: ${ind.ema200 != null ? ind.ema200 : 'ข้อมูลไม่พอ'}`
    );
  };

  const section = (label, key, candles, indicators) => {
    const win = CLAUDE_CANDLE_WINDOW[key] || 30;
    const recent = candles.slice(-win);
    return (
      `--- ${label} ---\n` +
      `Indicator (คำนวณแม่นยำแล้ว ใช้ตรงๆ):\n${fmtIndicators(indicators)}\n\n` +
      `แท่งเทียนล่าสุด ${recent.length} แท่ง:\n` +
      recent.map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join('\n')
    );
  };

  const pairText = (label, pair) =>
    `${label} (คำนวณมาให้แล้ว ใช้ตรงๆ ห้ามตีความใหม่):\n` +
    `- confirmed: ${pair.confirmed}\n` +
    `- direction: ${pair.direction || '-'}\n` +
    `- เทรนด์ TF ใหญ่: ${pair.trendBig}\n` +
    `- จุดหักล่าสุดของ TF เล็ก: ${pair.latestReversal ? `${pair.latestReversal.direction} @ ${pair.latestReversal.price}` : 'ไม่มี/ไม่สด'}\n` +
    `- Stochastic ของ TF เล็กล่าสุด: ${pair.stochSignal || 'ไม่มี crossover ในโซน'}`;

  const pairsText =
    pairText('pairA (4H ↔ 15M)', pairSignals.pairA) +
    '\n\n' +
    pairText('pairB (1H ↔ 5M)', pairSignals.pairB) +
    `\n\nshortAllowed (D และ 4H Bearish ทั้งคู่หรือไม่): ${shortAllowed}`;

  const userContent =
    `เวลาปัจจุบัน (ไทย): ${nowThai}\n` +
    `ราคาล่าสุด (close ของ 15M ล่าสุด): ${lastPrice}\n\n` +
    pairsText +
    '\n\n' +
    tfKeys.map((k) => section(`Timeframe ${k}`, k, candlesByTf[k], indicatorsByTf[k])).join('\n\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 100000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error('Claude API error: ' + JSON.stringify(data));

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude API ไม่ส่ง text กลับมา: ' + JSON.stringify(data));

  if (data.stop_reason === 'max_tokens') {
    throw new Error('คำตอบจาก Claude ถูกตัดกลางคันเพราะยาวเกิน max_tokens — ลองเพิ่ม max_tokens หรือให้ตอบสั้นลง');
  }

  let parsed;
  try {
    const clean = textBlock.text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error('parse JSON จาก Claude ไม่ได้: ' + textBlock.text);
  }

  const tfPrimary = (parsed.timeframes && parsed.timeframes['1h']) || {};

  return {
    price: lastPrice,
    full_text: textBlock.text,
    bias: parsed.overall_bias,
    trend: tfPrimary.trend,
    support_levels: tfPrimary.support_levels || [],
    resistance_levels: tfPrimary.resistance_levels || [],
    structure_note: parsed.overall_structure_note,
    plan_summary: parsed.plan_summary,
    confidence_note: parsed.confidence_note,
    confidence_score: Number.isFinite(parsed.confidence_score) ? parsed.confidence_score : null,
    trade_idea: {
      plan_4h_15m: (parsed.trade_idea && parsed.trade_idea.plan_4h_15m) || {},
      plan_1h_5m: (parsed.trade_idea && parsed.trade_idea.plan_1h_5m) || {},
    },
    timeframes: parsed.timeframes || {},
  };
}

// ---------- 4) เก็บลง Supabase ----------
async function getLastAnalysis() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;

  try {
    const r = await fetch(
      `${url}/rest/v1/xauusd_analysis?select=bias,created_at&order=created_at.desc&limit=1`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } }
    );
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    console.error('getLastAnalysis failed', e);
    return null;
  }
}

async function saveToSupabase(candlesByTf, indicatorsByTf, analysis) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const r = await fetch(`${url}/rest/v1/xauusd_analysis`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      price_snapshot: analysis.price,
      timeframe: 'D/4H/1H/30M/15M/5M',
      trend: analysis.trend,
      support_levels: (analysis.support_levels || []).join(', '),
      resistance_levels: (analysis.resistance_levels || []).join(', '),
      structure_note: analysis.structure_note,
      bias: analysis.bias,
      plan_summary: analysis.plan_summary,
      confidence_note: analysis.confidence_note,
      confidence_score: analysis.confidence_score,
      full_analysis: analysis.full_text,
      timeframes_json: analysis.timeframes,
      trade_idea_json: analysis.trade_idea, // { plan_4h_15m, plan_1h_5m } — 2 แผนคู่อิสระกัน, status_text/detail ฝังอยู่ในแต่ละแผนแล้ว
      trade_idea_short_json: null, // เลิกใช้แล้ว (ยุบเป็น 2 แผนคู่แทน) — เก็บ column ไว้เฉยๆ ไม่ต้อง migration
      indicators_json: indicatorsByTf,
      raw_candles: candlesByTf,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('Supabase insert ล้มเหลว: ' + t);
  }
}

// ---------- 5) ทดสอบการเชื่อมต่อ Telegram อย่างเดียว (ไม่ผ่านการวิเคราะห์จริง) ----------
async function testTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, error: 'ยังไม่ได้ตั้งค่า TELEGRAM_BOT_TOKEN หรือ TELEGRAM_CHAT_ID ใน Vercel Environment Variables' };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🧪 ทดสอบการแจ้งเตือน XAUUSD Analysis\n\nถ้าคุณเห็นข้อความนี้ แปลว่าเชื่อมต่อ Telegram Bot สำเร็จแล้ว ระบบจริงจะส่งสรุปผลวิเคราะห์ให้วันละ 4 รอบ (8:00 / 12:00 / 16:00 / 20:00 น. ไทย) ทุกรอบที่รัน',
      }),
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, error: 'Telegram API error', telegram_response: data };
    return { ok: true, message: 'ส่งข้อความทดสอบสำเร็จ เช็คแชทกับบอทของคุณได้เลย', telegram_response: data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------- 6) แจ้งเตือนผ่าน Telegram (ส่งทุกครั้งที่วิเคราะห์เสร็จ) ----------
async function notifyTelegram(analysis, previous, isNewSignal) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('ยังไม่ได้ตั้งค่า TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — ข้ามการแจ้งเตือน');
    return;
  }

  const prevBiasText = previous && previous.bias ? previous.bias : 'ยังไม่มีข้อมูลก่อนหน้า';
  const tf = analysis.timeframes || {};
  const tfLine = (label, key) => {
    const t = tf[key];
    if (!t) return '';
    return `${label}: ${t.trend || '-'} / ${t.bias || '-'}\n`;
  };
  const ti = analysis.trade_idea || {};
  const planBlock = (title, plan) => {
    plan = plan || {};
    const hasPlan = plan.entry_zone && plan.entry_zone !== '-';
    if (hasPlan) {
      return (
        `📋 ${title} — ${plan.direction || '-'}\n` +
        `Entry: ${plan.entry_zone || '-'} | SL: ${plan.stop_loss || '-'} | TP: ${(plan.take_profit || []).join(', ') || '-'} | R:R ${plan.rr_ratio || '-'}\n` +
        `⏱️ ปิดไม้ภายในวันนี้ ไม่ถือข้ามคืน\n`
      );
    }
    return `📋 ${title} — ยังไม่ครบเงื่อนไข\n${plan.status_text || 'รอจุดหัก + Stochastic ยืนยันทิศเดียวกับเทรนด์ใหญ่'}\n`;
  };

  const headline = isNewSignal
    ? `🥇 XAUUSD — พบสัญญาณใหม่\nเปลี่ยนจาก: ${prevBiasText} → ${analysis.bias}`
    : `🥇 XAUUSD — อัปเดตผลวิเคราะห์ (สัญญาณเดิม: ${analysis.bias})`;

  const msg =
    headline +
    (analysis.confidence_score != null ? ` (Confidence ${analysis.confidence_score}%)` : '') +
    `\n\n` +
    `ราคา: ${analysis.price}\n\n` +
    `บริบทเทรนด์: D ${((tf.D || {}).trend) || '-'} · 4H ${((tf['4h'] || {}).trend) || '-'} · 1H ${((tf['1h'] || {}).trend) || '-'} · 30M ${((tf['30m'] || {}).trend) || '-'}\n\n` +
    planBlock('คู่ A (4H ↔ 15M)', ti.plan_4h_15m) +
    `\n` +
    planBlock('คู่ B (1H ↔ 5M)', ti.plan_1h_5m) +
    `\nแผน: ${analysis.plan_summary}\n` +
    `ข้อควรระวัง: ${analysis.confidence_note || '-'}\n\n` +
    `🔗 ดูกราฟ + รายละเอียดเต็มที่ dashboard: ${DASHBOARD_URL}\n\n` +
    `⚠️ นี่คือการสรุปโครงสร้างราคาโดย AI เพื่อประกอบการตัดสินใจเท่านั้น ไม่ใช่คำแนะนำการลงทุน`;

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg.slice(0, 4000), disable_web_page_preview: false }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error('ส่ง Telegram ไม่สำเร็จ:', t);
  }
}
