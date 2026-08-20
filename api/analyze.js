// api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD หลาย timeframe (4H/1H/15M) -> คำนวณ indicator เอง (RSI/MACD/EMA)
// -> วิเคราะห์โครงสร้าง+SMC+แผนเทรดด้วย Claude -> เก็บลง Supabase -> แจ้งเตือน Telegram (ส่งทุกครั้งที่รัน)
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

// ลิงก์หน้า dashboard ที่แนบไปกับข้อความแจ้งเตือน Telegram ทุกครั้ง
// (ถ้าอยากเปลี่ยนโดเมนในอนาคต ไปตั้ง Environment Variable DASHBOARD_URL ใน Vercel ได้เลย ไม่ต้องแก้โค้ด)
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://claude-xau.vercel.app/';

const SYMBOL = 'XAU/USD';
const CANDLE_COUNT = 220; // เผื่อคำนวณ EMA200 ได้แม่นยำขึ้น
const CLAUDE_CANDLE_WINDOW = 40; // ส่งให้ Claude อ่านแค่แท่งล่าสุด (คุมต้นทุน token) ส่วน indicator คำนวณจากชุดเต็ม

// timeframe key ที่ใช้เก็บ/แสดงผล -> interval ที่ต้องส่งให้ Twelve Data
const TIMEFRAMES = {
  '4h': '4h',
  '1h': '1h',
  '15m': '15min',
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

    const analysis = await analyzeWithClaude(candlesByTf, indicatorsByTf);
    const previous = await getLastAnalysis();
    await saveToSupabase(candlesByTf, indicatorsByTf, analysis);

    // แจ้งเตือนทุกครั้งที่วิเคราะห์เสร็จ (ไม่กรองเฉพาะตอนสัญญาณเปลี่ยนแล้ว)
    const isNewSignal =
      analysis.bias && analysis.bias !== 'Wait' && analysis.bias !== (previous && previous.bias);
    await notifyTelegram(analysis, previous, isNewSignal);

    return res.status(200).json({ ok: true, bias: analysis.bias, notified: true });
  } catch (err) {
    console.error('analyze.js error:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- 1) ดึงราคา OHLC จาก Twelve Data (หลาย timeframe) ----------
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
  const keys = Object.keys(TIMEFRAMES); // ['4h','1h','15m']
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

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
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

  return { ema20, ema50, ema200, rsi14, rsiStatus, macd, macdStatus };
}

// ---------- 3) วิเคราะห์ด้วย Claude API (หลาย timeframe + indicator จริง + SMC + แผนเทรด) ----------
const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปโครงสร้างราคาทางเทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น แนว Smart Money Concepts (SMC) และ Price Action
คุณจะได้รับ (1) ข้อมูลแท่งเทียนล่าสุดของ 3 timeframe: 4H, 1H, 15M และ (2) ค่า indicator ที่คำนวณแม่นยำแล้ว (RSI14, MACD, EMA20/50/200) ของแต่ละ timeframe — ใช้ตัวเลข indicator ที่ให้มาตรงๆ ห้ามคำนวณเอง

วิเคราะห์แยกแต่ละ timeframe ก่อน (โครงสร้าง BOS/CHoCH, โซน SMC เช่น Fair Value Gap / Order Block / Liquidity Sweep, แนวรับ-แนวต้าน) แล้วสรุปภาพรวม (confluence) ว่าควรโฟกัสฝั่งไหน พร้อมประเมิน Confidence Score และแนวคิดแผนเทรด (entry zone / stop loss / take profit / R:R) แบบกว้างๆ เพื่อประกอบการตัดสินใจ — ไม่ใช่คำสั่งซื้อขายเด็ดขาด

สำคัญมาก: ทุก field ที่เป็นข้อความต้องกระชับที่สุด — "structure_note" และ "smc_zones" ของแต่ละ timeframe ห้ามเกิน 1 ประโยคสั้นๆ (ไม่เกิน ~25 คำ), "overall_structure_note" และ "plan_summary" ห้ามเกิน 2 ประโยคสั้นๆ, "confidence_note" ห้ามเกิน 1 ประโยค ห้ามใส่รายละเอียดราคาซ้ำกับ support/resistance levels ที่มีอยู่แล้ว เพราะคำตอบต้องจบเป็น JSON ที่สมบูรณ์เสมอ ห้ามถูกตัดกลางคัน

ตอบกลับเป็น JSON ล้วนๆ เท่านั้น (ไม่มีข้อความอื่นนอก JSON ไม่มี markdown code fence) ตามโครงสร้างนี้เป๊ะๆ:
{
  "overall_bias": "Long หรือ Short หรือ Wait",
  "overall_structure_note": "สรุปภาพรวมจากทั้ง 3 timeframe สั้นๆ ว่าสอดคล้องกันไหม (confluence) หรือขัดแย้งกันตรงไหน",
  "plan_summary": "สรุปแผนสั้นๆ ไม่เกิน 4 บรรทัด บอกว่าควรโฟกัส timeframe ไหนเป็นหลัก โซนที่น่าสนใจ ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย เช่น ห้ามพูดว่า \\"ให้เข้าซื้อตอนนี้\\"",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่จะทำให้มุมมองนี้เปลี่ยนไป",
  "confidence_score": 0,
  "trade_idea": {
    "entry_zone": "ช่วงราคาที่น่าสนใจถ้ามีโครงสร้างสนับสนุน เช่น '4478-4487' ถ้า bias เป็น Wait ให้ใส่ '-'",
    "stop_loss": "ราคา SL แบบกว้างๆ ตามโครงสร้าง หรือ '-'",
    "take_profit": ["TP1", "TP2", "TP3"],
    "rr_ratio": "เช่น '1:2.3' หรือ '-'"
  },
  "timeframes": {
    "4h": { "trend": "Bullish หรือ Bearish หรือ Sideway", "bias": "Long หรือ Short หรือ Wait", "structure_note": "อธิบายโครงสร้างสั้นๆ เช่น BOS/CHoCH", "smc_zones": "อธิบายโซน FVG / Order Block / Liquidity Sweep ที่น่าสนใจของ timeframe นี้ หรือ 'ไม่มีโซนเด่นชัด'", "support_levels": ["ราคาแนวรับ เรียงใกล้ไปไกล"], "resistance_levels": ["ราคาแนวต้าน เรียงใกล้ไปไกล"] },
    "1h": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] },
    "15m": { "trend": "...", "bias": "...", "structure_note": "...", "smc_zones": "...", "support_levels": [], "resistance_levels": [] }
  }
}
สำคัญ: นี่คือการสรุปโครงสร้างราคาเพื่อประกอบการตัดสินใจของผู้ใช้เอง ไม่ใช่คำแนะนำการลงทุนที่รับประกันผลลัพธ์ และไม่ใช่คำสั่งซื้อขายที่ชี้นำโดยตรง confidence_score คือความมั่นใจของ "การอ่านโครงสร้าง" ไม่ใช่การการันตีผลกำไร`;

async function analyzeWithClaude(candlesByTf, indicatorsByTf) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY');

  const lastPrice = candlesByTf['15m'][candlesByTf['15m'].length - 1].close;

  const fmtIndicators = (ind) => {
    if (!ind) return 'ไม่มีข้อมูล indicator';
    const macdText = ind.macd
      ? `MACD line ${ind.macd.macdLine} / signal ${ind.macd.signalLine} / histogram ${ind.macd.histogram} (${ind.macdStatus})`
      : 'MACD: ข้อมูลไม่พอคำนวณ';
    return (
      `RSI14: ${ind.rsi14 != null ? ind.rsi14 : '-'} (${ind.rsiStatus})\n` +
      `${macdText}\n` +
      `EMA20: ${ind.ema20 != null ? ind.ema20 : '-'} / EMA50: ${ind.ema50 != null ? ind.ema50 : '-'} / EMA200: ${ind.ema200 != null ? ind.ema200 : 'ข้อมูลไม่พอ'}`
    );
  };

  const section = (label, candles, indicators) => {
    const recent = candles.slice(-CLAUDE_CANDLE_WINDOW);
    return (
      `--- ${label} ---\n` +
      `Indicator (คำนวณแม่นยำแล้ว ใช้ตรงๆ):\n${fmtIndicators(indicators)}\n\n` +
      `แท่งเทียนล่าสุด ${recent.length} แท่ง:\n` +
      recent.map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join('\n')
    );
  };

  const userContent =
    `ราคาล่าสุด (close ของ 15M ล่าสุด): ${lastPrice}\n\n` +
    section('Timeframe 4H', candlesByTf['4h'], indicatorsByTf['4h']) +
    '\n\n' +
    section('Timeframe 1H', candlesByTf['1h'], indicatorsByTf['1h']) +
    '\n\n' +
    section('Timeframe 15M', candlesByTf['15m'], indicatorsByTf['15m']);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4500,
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

  const tf1h = (parsed.timeframes && parsed.timeframes['1h']) || {};

  return {
    price: lastPrice,
    full_text: textBlock.text,
    bias: parsed.overall_bias,
    trend: tf1h.trend,
    support_levels: tf1h.support_levels || [],
    resistance_levels: tf1h.resistance_levels || [],
    structure_note: parsed.overall_structure_note,
    plan_summary: parsed.plan_summary,
    confidence_note: parsed.confidence_note,
    confidence_score: Number.isFinite(parsed.confidence_score) ? parsed.confidence_score : null,
    trade_idea: parsed.trade_idea || {},
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
      timeframe: '4h/1h/15m',
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
      trade_idea_json: analysis.trade_idea,
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
        text: '🧪 ทดสอบการแจ้งเตือน XAUUSD Analysis\n\nถ้าคุณเห็นข้อความนี้ แปลว่าเชื่อมต่อ Telegram Bot สำเร็จแล้ว ระบบจริงจะส่งสรุปผลวิเคราะห์แบบนี้ให้ทุกครั้งที่รัน (ทุกรอบตามตารางเวลา)',
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

  const msg =
    headline +
    (analysis.confidence_score != null ? ` (Confidence ${analysis.confidence_score}%)` : '') +
    `\n\n` +
    `ราคา: ${analysis.price}\n\n` +
    tfLine('4H', '4h') +
    tfLine('1H', '1h') +
    tfLine('15M', '15m') +
    `\nEntry: ${ti.entry_zone || '-'} | SL: ${ti.stop_loss || '-'} | TP: ${(ti.take_profit || []).join(', ') || '-'} | R:R ${ti.rr_ratio || '-'}\n\n` +
    `แผน: ${analysis.plan_summary}\n` +
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
