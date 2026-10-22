// api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD 6 timeframe (D/4H/1H/30M/15M/5M) -> คำนวณ indicator เอง
// (RSI14 / MACD / EMA9-21 / ATR / Supertrend แบบ deterministic ล้วนๆ) -> ตัวเลข Entry/SL/TP1-3 มาจากสูตร
// ATR ตรงๆ ไม่ผ่าน AI เลย -> Claude ใช้แค่อธิบายโครงสร้าง/SMC/แนวรับแนวต้านเป็นข้อความประกอบเท่านั้น
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
// ===== ระบบใหม่ (เครื่องมือสามัญทั่วไป, สไตล์เดียวกับสคริปต์ TradingView ที่อ้างอิง) =====
// - วิเคราะห์ 6 timeframe เพื่อบริบท/SMC/แนวรับแนวต้าน: D > 4H > 1H > 30M > 15M > 5M
// - เทรนด์หลักของแต่ละ timeframe = ทิศทาง Supertrend (ATR trailing trend) ไม่ใช่ประเมินจาก AI
// - สัญญาณเข้าไม้จริงคำนวณจาก TF หลัก (1H) เท่านั้น ให้เรียบง่าย ไม่ซ้อนหลายคู่แบบรอบก่อน:
//     EMA9 ตัด EMA21 ขึ้น/ลง (ภายในไม่กี่แท่งล่าสุด) + RSI14 ยืนเหนือ/ต่ำกว่า 50 ตอนตัด + ทิศ Supertrend ตรงกัน
// - Entry/SL/TP1/TP2/TP3 คำนวณจาก ATR14 × ตัวคูณ (1.5 / 1.2 / 2.4 / 3.6) ล้วนๆ ด้วยโค้ด ไม่ผ่าน AI เลย
//   (Claude ใช้แค่อธิบายโครงสร้าง SMC / แนวรับแนวต้าน / สรุปแผนเป็นข้อความประกอบเท่านั้น)
// - เทรด "จบในวันเดียว" เท่านั้น ไม่มีแผนถือข้ามคืน/หลายวัน
// - Bias เริ่มต้นเน้น Long เป็นหลัก จะยอมให้สัญญาณ Short ผ่านได้ก็ต่อเมื่อ Supertrend ของ D และ 4H เป็น
//   "Bearish" ทั้งคู่เท่านั้น (hard gate บังคับด้วยโค้ด)

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://claude-xau.vercel.app/';

const SYMBOL = 'XAU/USD';
const CANDLE_COUNT = 220; // เผื่อคำนวณ EMA/ATR/Supertrend ได้แม่นยำขึ้น

// timeframe key ที่ใช้เก็บ/แสดงผล -> interval ที่ต้องส่งให้ Twelve Data
const TIMEFRAMES = {
  D: '1day',
  '4h': '4h',
  '1h': '1h',
  '30m': '30min',
  '15m': '15min',
  '5m': '5min',
};

// TF หลักที่ใช้สร้างสัญญาณเข้าไม้จริง (TF อื่นเป็นบริบทประกอบ/แนวรับแนวต้านในแดชบอร์ดเท่านั้น)
const PRIMARY_TF = '1h';

// จำนวนแท่งล่าสุดที่ส่งให้ Claude อ่านต่อ timeframe (คุมต้นทุน token) — ใช้แค่ประกอบคำอธิบาย ไม่ใช่คำนวณตัวเลขเทรด
const CLAUDE_CANDLE_WINDOW = {
  D: 20,
  '4h': 25,
  '1h': 35,
  '30m': 25,
  '15m': 20,
  '5m': 20,
};

// พารามิเตอร์สัญญาณ (ตามสคริปต์อ้างอิง)
const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_LEN = 14;
const ATR_LEN = 10; // ใช้ทั้งคู่กับ Supertrend และ risk level เพื่อความสม่ำเสมอ
const ST_MULT = 3.0; // Supertrend ATR multiplier
const SL_MULT = 1.5;
const TP1_MULT = 1.2;
const TP2_MULT = 2.4;
const TP3_MULT = 3.6;
const SIGNAL_LOOKBACK = 3; // EMA cross ต้องเกิดภายในกี่แท่งล่าสุดถึงจะยังนับว่า "สด"

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

    // สัญญาณเข้าไม้ (deterministic ล้วนๆ): EMA9/21 cross + RSI50 + ทิศ Supertrend ตรงกัน บน TF หลัก (1H)
    const signal = buildSignal(candlesByTf[PRIMARY_TF], indicatorsByTf[PRIMARY_TF]);
    const shortAllowed = indicatorsByTf['D'].supertrendDirection === 'Bearish' && indicatorsByTf['4h'].supertrendDirection === 'Bearish';
    const tradeIdea = buildTradeIdea(signal, indicatorsByTf[PRIMARY_TF], shortAllowed);

    const analysis = await analyzeWithClaude(candlesByTf, indicatorsByTf, tradeIdea);
    analysis.trade_idea = tradeIdea; // ตัวเลข Entry/SL/TP มาจากโค้ดล้วนๆ เสมอ ไม่ใช้ค่าที่ Claude อาจเผลอใส่มา

    const previous = await getLastAnalysis();
    await saveToSupabase(candlesByTf, indicatorsByTf, analysis);

    // แจ้งเตือนทุกครั้งที่วิเคราะห์เสร็จ (ไม่กรองเฉพาะตอนสัญญาณเปลี่ยนแล้ว)
    const isNewSignal =
      analysis.bias && analysis.bias !== 'Wait' && analysis.bias !== (previous && previous.bias);
    await notifyTelegram(analysis, previous, isNewSignal);

    return res.status(200).json({ ok: true, bias: analysis.bias, signal_ready: tradeIdea.confirmed, notified: true });
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

// ---------- 2) คำนวณ Technical Indicator เอง (เครื่องมือสามัญทั่วไป: EMA / RSI / MACD / ATR / Supertrend) ----------
function calcEMASeries(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
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

function calcRSISeries(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
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

// ATR แบบ Wilder's smoothing (เหมือน ta.atr ของ Pine Script)
function calcATRSeries(candles, period) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
    } else {
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
    }
  }
  const out = new Array(n).fill(null);
  if (n < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  seed /= period;
  out[period - 1] = seed;
  let atr = seed;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// Supertrend แบบมาตรฐาน (basic/final upper-lower band + trend flip)
function calcSupertrend(candles, atrSeries, multiplier) {
  const n = candles.length;
  const finalUpper = new Array(n).fill(null);
  const finalLower = new Array(n).fill(null);
  const direction = new Array(n).fill(null); // 'up' | 'down'
  const value = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const atr = atrSeries[i];
    if (atr == null) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + multiplier * atr;
    const basicLower = mid - multiplier * atr;

    const prevFinalUpper = finalUpper[i - 1];
    const prevFinalLower = finalLower[i - 1];
    const prevClose = i > 0 ? candles[i - 1].close : null;

    const fu =
      prevFinalUpper == null || basicUpper < prevFinalUpper || (prevClose != null && prevClose > prevFinalUpper)
        ? basicUpper
        : prevFinalUpper;
    const fl =
      prevFinalLower == null || basicLower > prevFinalLower || (prevClose != null && prevClose < prevFinalLower)
        ? basicLower
        : prevFinalLower;
    finalUpper[i] = fu;
    finalLower[i] = fl;

    const prevDir = direction[i - 1];
    let dir;
    if (prevDir == null) {
      dir = candles[i].close >= mid ? 'up' : 'down';
    } else if (prevDir === 'up') {
      dir = candles[i].close < fl ? 'down' : 'up';
    } else {
      dir = candles[i].close > fu ? 'up' : 'down';
    }
    direction[i] = dir;
    value[i] = dir === 'up' ? fl : fu;
  }

  return { direction, value };
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const ema9Series = calcEMASeries(closes, EMA_FAST);
  const ema21Series = calcEMASeries(closes, EMA_SLOW);
  const rsiSeries = calcRSISeries(closes, RSI_LEN);
  const atrSeries = calcATRSeries(candles, ATR_LEN);
  const st = calcSupertrend(candles, atrSeries, ST_MULT);

  const ema9 = round2(lastDefined(ema9Series));
  const ema21 = round2(lastDefined(ema21Series));
  const rsi14 = round2(lastDefined(rsiSeries));
  const atr14 = round2(lastDefined(atrSeries));
  const macdRaw = calcMACD(closes);
  const macd = macdRaw
    ? { macdLine: round2(macdRaw.macdLine), signalLine: round2(macdRaw.signalLine), histogram: round2(macdRaw.histogram) }
    : null;

  let macdStatus = 'Neutral';
  if (macd) macdStatus = macd.histogram > 0 ? 'Bullish' : macd.histogram < 0 ? 'Bearish' : 'Neutral';

  let rsiStatus = 'Neutral';
  if (rsi14 != null) rsiStatus = rsi14 >= 70 ? 'Overbought' : rsi14 <= 30 ? 'Oversold' : 'Neutral';

  const lastDir = lastDefined(st.direction);
  const supertrendDirection = lastDir === 'up' ? 'Bullish' : lastDir === 'down' ? 'Bearish' : 'Bullish';
  const supertrendValue = round2(lastDefined(st.value));

  // ซีรีส์ Supertrend สำหรับวาดเส้นบนกราฟ (ส่งแค่ time/value/direction ของแท่งที่มีค่า)
  const supertrendSeries = [];
  for (let i = 0; i < candles.length; i++) {
    if (st.value[i] == null) continue;
    supertrendSeries.push({ time: candles[i].time, value: round2(st.value[i]), direction: st.direction[i] });
  }

  return {
    ema9,
    ema21,
    rsi14,
    rsiStatus,
    macd,
    macdStatus,
    atr14,
    supertrendDirection, // 'Bullish' | 'Bearish' — นี่คือ "trend" หลักของ timeframe นี้ (deterministic ล้วนๆ)
    supertrendValue,
    supertrendSeries,
    // เก็บ series ภายในไว้ใช้ต่อ (ไม่ต้องส่งออกไป Claude/DB ทั้งก้อนเพื่อลดขนาด)
    _ema9Series: ema9Series,
    _ema21Series: ema21Series,
    _rsiSeries: rsiSeries,
    _atrSeries: atrSeries,
    _stDirection: st.direction,
  };
}

// ---------- 2.5) สัญญาณเข้าไม้ (deterministic): EMA9/21 cross + RSI50 + Supertrend ตรงทิศ บน TF หลัก ----------
function buildSignal(candles, ind) {
  const n = candles.length;
  const e9 = ind._ema9Series;
  const e21 = ind._ema21Series;
  const rsi = ind._rsiSeries;
  const stDir = ind._stDirection;

  for (let i = n - 1; i >= Math.max(1, n - SIGNAL_LOOKBACK); i--) {
    if (e9[i] == null || e21[i] == null || e9[i - 1] == null || e21[i - 1] == null || rsi[i] == null || stDir[i] == null) continue;
    const crossUp = e9[i - 1] <= e21[i - 1] && e9[i] > e21[i];
    const crossDown = e9[i - 1] >= e21[i - 1] && e9[i] < e21[i];

    if (crossUp && rsi[i] > 50 && stDir[i] === 'up') {
      return { direction: 'Long', index: i, time: candles[i].time, price: candles[i].close, rsiAtCross: round2(rsi[i]) };
    }
    if (crossDown && rsi[i] < 50 && stDir[i] === 'down') {
      return { direction: 'Short', index: i, time: candles[i].time, price: candles[i].close, rsiAtCross: round2(rsi[i]) };
    }
  }
  return null;
}

function signalStatusText(signal, ind, shortAllowed) {
  if (!signal) {
    return `ยังไม่มีสัญญาณสด — รอ EMA${EMA_FAST}/${EMA_SLOW} ตัดกันพร้อม RSI ยืนยันและ Supertrend ตรงทิศ (Supertrend ${ind.supertrendDirection} ตอนนี้)`;
  }
  if (signal.direction === 'Short' && !shortAllowed) {
    return `พบสัญญาณ Short (EMA ตัดลง + RSI ${signal.rsiAtCross} + Supertrend ขาลง) แต่ไม่อนุญาตให้เข้า เพราะเทรนด์ใหญ่ (D/4H) ยังไม่เป็น Bearish ชัดเจนทั้งคู่ (เน้น Buy เป็นหลัก)`;
  }
  return `คอนเฟิร์ม: EMA${EMA_FAST}/${EMA_SLOW} ตัด${signal.direction === 'Long' ? 'ขึ้น' : 'ลง'} + RSI ${signal.rsiAtCross} ${signal.direction === 'Long' ? 'เหนือ' : 'ต่ำกว่า'} 50 + Supertrend ${ind.supertrendDirection} ตรงทิศกัน`;
}

// สร้างแผนเทรดจากสัญญาณ — ตัวเลข Entry/SL/TP มาจากสูตร ATR ล้วนๆ ไม่ผ่าน AI เลย
function buildTradeIdea(signal, ind, shortAllowed) {
  const blocked = !!(signal && signal.direction === 'Short' && !shortAllowed);
  const confirmed = !!(signal && !blocked);
  const statusText = signalStatusText(signal, ind, shortAllowed);

  if (!confirmed || ind.atr14 == null) {
    return {
      confirmed: false,
      direction: signal ? signal.direction : null,
      entry_zone: '-',
      stop_loss: '-',
      take_profit: [],
      rr_ratio: '-',
      status_text: statusText,
      detail: { supertrendDirection: ind.supertrendDirection, atr14: ind.atr14, signal: signal || null },
    };
  }

  const entry = signal.price;
  const atr = ind.atr14;
  const isLong = signal.direction === 'Long';
  const sl = round2(isLong ? entry - atr * SL_MULT : entry + atr * SL_MULT);
  const tp1 = round2(isLong ? entry + atr * TP1_MULT : entry - atr * TP1_MULT);
  const tp2 = round2(isLong ? entry + atr * TP2_MULT : entry - atr * TP2_MULT);
  const tp3 = round2(isLong ? entry + atr * TP3_MULT : entry - atr * TP3_MULT);
  const risk = Math.abs(entry - sl);
  const reward1 = Math.abs(tp1 - entry);
  const rr = risk > 0 ? `1:${(reward1 / risk).toFixed(1)}` : '-';

  return {
    confirmed: true,
    direction: signal.direction,
    entry_zone: String(round2(entry)),
    stop_loss: String(sl),
    take_profit: [String(tp1), String(tp2), String(tp3)],
    rr_ratio: rr,
    status_text: statusText,
    note: `ปิดไม้ภายในวันนี้ ไม่ถือข้ามคืน — SL/TP คำนวณจาก ATR(${ATR_LEN}) × ${SL_MULT}/${TP1_MULT}/${TP2_MULT}/${TP3_MULT} บน ${PRIMARY_TF.toUpperCase()}`,
    detail: { supertrendDirection: ind.supertrendDirection, atr14: ind.atr14, signal },
  };
}

// ---------- 3) Claude ใช้แค่อธิบายโครงสร้าง/SMC/แนวรับแนวต้านเป็นข้อความประกอบ (ไม่แตะตัวเลขเทรด) ----------
const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปโครงสร้างราคาทางเทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น แนว Smart Money Concepts (SMC) และ Price Action
คุณจะได้รับข้อมูลแท่งเทียนและ indicator ที่คำนวณแม่นยำแล้วของ 6 timeframe: D (Daily), 4H, 1H, 30M, 15M, 5M — ใช้ตัวเลขที่ให้มาตรงๆ (RSI14, MACD, EMA9/21, ATR, ทิศทาง Supertrend) ห้ามคำนวณเอง และห้ามเปลี่ยนค่า "trend" ของแต่ละ timeframe ที่ระบบคำนวณมาให้ (Bullish/Bearish มาจากทิศทาง Supertrend แบบตายตัว)

สำคัญมาก: ระบบมีสัญญาณเข้าไม้ (object "signal") และตัวเลข Entry/SL/TP1-3 ที่คำนวณจากสูตร ATR ไว้ให้แล้วแยกต่างหาก คุณ**ไม่ต้อง**เสนอ Entry/SL/TP ของตัวเองเลย หน้าที่คุณคือ:
1) อธิบายโครงสร้างแต่ละ timeframe (BOS/CHoCH, โซน SMC เช่น Fair Value Gap / Order Block / Liquidity Sweep, แนวรับ-แนวต้าน)
2) สรุปภาพรวมว่าสอดคล้องกันไหม (confluence) โดยเฉพาะ TF หลัก (1H) กับบริบทจาก D/4H
3) ให้ overall_bias ที่เป็นมุมมองเชิงคุณภาพ (ไม่ใช่คำสั่งเข้าไม้) — เน้นฝั่ง Long เป็นหลักเสมอ จะให้ "Short" ได้ก็ต่อเมื่อ trend ของ D และ 4H เป็น "Bearish" ชัดเจนทั้งคู่เท่านั้น (ระบบแจ้งมาให้ว่า shortAllowed = true/false) ถ้า shortAllowed = false ห้ามตอบ "Short" เด็ดขาด ให้ตอบ "Long" หรือ "Wait" แทน
4) สรุปแผนของวันนี้สั้นๆ โดยอ้างอิงว่าสัญญาณ (signal) ตอนนี้คอนเฟิร์มหรือยัง เน้นว่าเทรดต้องจบในวันเดียว ไม่ถือข้ามคืน ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย เช่น ห้ามพูดว่า "ให้เข้าซื้อตอนนี้"

ทุก field ข้อความต้องกระชับที่สุด — "structure_note" และ "smc_zones" ของแต่ละ timeframe ห้ามเกิน 1 ประโยคสั้นๆ (ไม่เกิน ~25 คำ), "overall_structure_note" และ "plan_summary" ห้ามเกิน 3 ประโยคสั้นๆ, "confidence_note" ห้ามเกิน 1 ประโยค ห้ามใส่รายละเอียดราคาซ้ำกับ support/resistance levels ที่มีอยู่แล้ว เพราะคำตอบต้องจบเป็น JSON ที่สมบูรณ์เสมอ ห้ามถูกตัดกลางคัน

ตอบกลับเป็น JSON ล้วนๆ เท่านั้น (ไม่มีข้อความอื่นนอก JSON ไม่มี markdown code fence) ตามโครงสร้างนี้เป๊ะๆ:
{
  "overall_bias": "Long หรือ Short หรือ Wait",
  "overall_structure_note": "สรุปภาพรวมจากทั้ง 6 timeframe สั้นๆ ว่าสอดคล้องกันไหม (confluence) หรือขัดแย้งกันตรงไหน เน้นว่า 1H (TF หลัก) เทียบกับ D/4H เป็นอย่างไร",
  "plan_summary": "สรุปแผนของวันนี้สั้นๆ ไม่เกิน 4 บรรทัด อ้างอิงสถานะสัญญาณที่ระบบให้มา ย้ำว่าต้องจบในวัน ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่จะทำให้มุมมองนี้เปลี่ยนไป",
  "confidence_score": 0,
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

async function analyzeWithClaude(candlesByTf, indicatorsByTf, tradeIdea) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY');

  const tfKeys = Object.keys(TIMEFRAMES);
  const lastPrice = candlesByTf[PRIMARY_TF][candlesByTf[PRIMARY_TF].length - 1].close;
  const nowThai = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' });

  const fmtIndicators = (ind) => {
    if (!ind) return 'ไม่มีข้อมูล indicator';
    const macdText = ind.macd
      ? `MACD line ${ind.macd.macdLine} / signal ${ind.macd.signalLine} / histogram ${ind.macd.histogram} (${ind.macdStatus})`
      : 'MACD: ข้อมูลไม่พอคำนวณ';
    return (
      `Supertrend (trend หลัก): ${ind.supertrendDirection} (value ${ind.supertrendValue})\n` +
      `RSI14: ${ind.rsi14 != null ? ind.rsi14 : '-'} (${ind.rsiStatus})\n` +
      `${macdText}\n` +
      `EMA${EMA_FAST}: ${ind.ema9 != null ? ind.ema9 : '-'} / EMA${EMA_SLOW}: ${ind.ema21 != null ? ind.ema21 : '-'}\n` +
      `ATR${ATR_LEN}: ${ind.atr14 != null ? ind.atr14 : '-'}`
    );
  };

  const section = (label, key, candles, indicators) => {
    const win = CLAUDE_CANDLE_WINDOW[key] || 25;
    const recent = candles.slice(-win);
    return (
      `--- ${label} ---\n` +
      `Indicator (คำนวณแม่นยำแล้ว ใช้ตรงๆ):\n${fmtIndicators(indicators)}\n\n` +
      `แท่งเทียนล่าสุด ${recent.length} แท่ง:\n` +
      recent.map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join('\n')
    );
  };

  const signalText =
    `signal (คำนวณมาให้แล้ว ใช้ตรงๆ ห้ามตีความใหม่ ห้ามเสนอ Entry/SL/TP เอง):\n` +
    `- confirmed: ${tradeIdea.confirmed}\n` +
    `- direction: ${tradeIdea.direction || '-'}\n` +
    `- entry/SL/TP (ระบบคำนวณแล้ว): ${tradeIdea.entry_zone} / ${tradeIdea.stop_loss} / ${(tradeIdea.take_profit || []).join(', ') || '-'}\n` +
    `- status: ${tradeIdea.status_text}`;

  const userContent =
    `เวลาปัจจุบัน (ไทย): ${nowThai}\n` +
    `ราคาล่าสุด (close ของ ${PRIMARY_TF.toUpperCase()} ล่าสุด): ${lastPrice}\n\n` +
    signalText +
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

  const tfPrimary = (parsed.timeframes && parsed.timeframes[PRIMARY_TF]) || {};
  let bias = parsed.overall_bias;
  if (bias === 'Short' && !(indicatorsByTf['D'].supertrendDirection === 'Bearish' && indicatorsByTf['4h'].supertrendDirection === 'Bearish')) {
    bias = 'Wait'; // บังคับ buy-bias skew ด้วยโค้ดอีกชั้น เผื่อ Claude พลาด
  }

  return {
    price: lastPrice,
    full_text: textBlock.text,
    bias,
    trend: tfPrimary.trend,
    support_levels: tfPrimary.support_levels || [],
    resistance_levels: tfPrimary.resistance_levels || [],
    structure_note: parsed.overall_structure_note,
    plan_summary: parsed.plan_summary,
    confidence_note: parsed.confidence_note,
    confidence_score: Number.isFinite(parsed.confidence_score) ? parsed.confidence_score : null,
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

// ตัด key ที่ขึ้นต้นด้วย _ (ซีรีส์ภายในที่ใช้คำนวณ ไม่ต้องเก็บทั้งก้อนลง DB) ออกจาก indicators ก่อนบันทึก/ส่ง Claude
function publicIndicators(ind) {
  const out = {};
  Object.keys(ind).forEach((k) => {
    if (!k.startsWith('_')) out[k] = ind[k];
  });
  return out;
}

async function saveToSupabase(candlesByTf, indicatorsByTf, analysis) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY');

  const cleanIndicators = {};
  Object.keys(indicatorsByTf).forEach((k) => (cleanIndicators[k] = publicIndicators(indicatorsByTf[k])));

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
      trade_idea_json: analysis.trade_idea, // แผนเดียว คำนวณจาก Supertrend+EMA9/21+RSI+ATR ล้วนๆ
      trade_idea_short_json: null, // เลิกใช้แล้ว — เก็บ column ไว้เฉยๆ ไม่ต้อง migration
      indicators_json: cleanIndicators,
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

  const headline = isNewSignal
    ? `🥇 XAUUSD — พบสัญญาณใหม่\nเปลี่ยนจาก: ${prevBiasText} → ${analysis.bias}`
    : `🥇 XAUUSD — อัปเดตผลวิเคราะห์ (สัญญาณเดิม: ${analysis.bias})`;

  const planLine = ti.confirmed
    ? `📋 แผนวันนี้ (${PRIMARY_TF.toUpperCase()}) — ${ti.direction}\n` +
      `Entry: ${ti.entry_zone} | SL: ${ti.stop_loss}\n` +
      `TP1: ${ti.take_profit[0] || '-'} | TP2: ${ti.take_profit[1] || '-'} | TP3: ${ti.take_profit[2] || '-'} | R:R ${ti.rr_ratio}\n` +
      `⏱️ ปิดไม้ภายในวันนี้ ไม่ถือข้ามคืน\n`
    : `📋 แผนวันนี้ (${PRIMARY_TF.toUpperCase()}): ยังไม่มีสัญญาณ\n${ti.status_text || '-'}\n`;

  const msg =
    headline +
    (analysis.confidence_score != null ? ` (Confidence ${analysis.confidence_score}%)` : '') +
    `\n\n` +
    `ราคา: ${analysis.price}\n\n` +
    `บริบทเทรนด์ (Supertrend): D ${((tf.D || {}).trend) || '-'} · 4H ${((tf['4h'] || {}).trend) || '-'} · 1H ${((tf['1h'] || {}).trend) || '-'} · 30M ${((tf['30m'] || {}).trend) || '-'} · 15M ${((tf['15m'] || {}).trend) || '-'} · 5M ${((tf['5m'] || {}).trend) || '-'}\n\n` +
    planLine +
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
