// api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD หลาย timeframe (4H/1H/15M) -> วิเคราะห์ด้วย Claude -> เก็บลง Supabase -> แจ้งเตือน Telegram (เฉพาะตอนมีสัญญาณใหม่)
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

const SYMBOL = 'XAU/USD';
const CANDLE_COUNT = 80;

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

  try {
    const candlesByTf = await fetchAllTimeframes();
    const analysis = await analyzeWithClaude(candlesByTf);
    const previous = await getLastAnalysis();
    await saveToSupabase(candlesByTf, analysis);

    const isNewSignal =
      analysis.bias && analysis.bias !== 'Wait' && analysis.bias !== (previous && previous.bias);
    if (isNewSignal) {
      await notifyTelegram(analysis, previous);
    }

    return res.status(200).json({ ok: true, bias: analysis.bias, notified: !!isNewSignal });
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

// ---------- 2) วิเคราะห์ด้วย Claude API (หลาย timeframe พร้อมกัน) ----------
const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปโครงสร้างราคาทางเทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น แนว Smart Money / Price Action (BOS, CHoCH, higher-high/lower-low)
คุณจะได้รับข้อมูลแท่งเทียน 3 timeframe: 4H, 1H, 15M ให้วิเคราะห์แยกแต่ละ timeframe ก่อน แล้วสรุปภาพรวม (confluence) ว่าควรโฟกัสฝั่งไหน

ตอบกลับเป็น JSON ล้วนๆ เท่านั้น (ไม่มีข้อความอื่นนอก JSON ไม่มี markdown code fence) ตามโครงสร้างนี้เป๊ะๆ:
{
  "overall_bias": "Long หรือ Short หรือ Wait",
  "overall_structure_note": "สรุปภาพรวมจากทั้ง 3 timeframe สั้นๆ ว่าสอดคล้องกันไหม (confluence) หรือขัดแย้งกันตรงไหน",
  "plan_summary": "สรุปแผนสั้นๆ ไม่เกิน 4 บรรทัด บอกว่าควรโฟกัส timeframe ไหนเป็นหลัก โซนที่น่าสนใจ ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย เช่น ห้ามพูดว่า \\"ให้เข้าซื้อตอนนี้\\"",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่จะทำให้มุมมองนี้เปลี่ยนไป",
  "timeframes": {
    "4h": { "trend": "Bullish หรือ Bearish หรือ Sideway", "bias": "Long หรือ Short หรือ Wait", "structure_note": "อธิบายโครงสร้างสั้นๆ เช่น BOS/CHoCH", "support_levels": ["ราคาแนวรับ เรียงใกล้ไปไกล"], "resistance_levels": ["ราคาแนวต้าน เรียงใกล้ไปไกล"] },
    "1h": { "trend": "...", "bias": "...", "structure_note": "...", "support_levels": [], "resistance_levels": [] },
    "15m": { "trend": "...", "bias": "...", "structure_note": "...", "support_levels": [], "resistance_levels": [] }
  }
}
สำคัญ: นี่คือการสรุปโครงสร้างราคาเพื่อประกอบการตัดสินใจของผู้ใช้เอง ไม่ใช่คำแนะนำการลงทุนที่รับประกันผลลัพธ์ และไม่ใช่คำสั่งซื้อขายที่ชี้นำโดยตรง`;

async function analyzeWithClaude(candlesByTf) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY');

  const lastPrice = candlesByTf['15m'][candlesByTf['15m'].length - 1].close;

  const section = (label, candles) =>
    `--- ${label} (${candles.length} แท่งล่าสุด) ---\n` +
    candles.map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join('\n');

  const userContent =
    `ราคาล่าสุด (close ของ 15M ล่าสุด): ${lastPrice}\n\n` +
    section('Timeframe 4H', candlesByTf['4h']) +
    '\n\n' +
    section('Timeframe 1H', candlesByTf['1h']) +
    '\n\n' +
    section('Timeframe 15M', candlesByTf['15m']);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error('Claude API error: ' + JSON.stringify(data));

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude API ไม่ส่ง text กลับมา: ' + JSON.stringify(data));

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
    timeframes: parsed.timeframes || {},
  };
}

// ---------- 3) เก็บลง Supabase ----------
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

async function saveToSupabase(candlesByTf, analysis) {
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
      full_analysis: analysis.full_text,
      timeframes_json: analysis.timeframes,
      raw_candles: candlesByTf,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('Supabase insert ล้มเหลว: ' + t);
  }
}

// ---------- 4) แจ้งเตือนผ่าน Telegram (เฉพาะตอนมีสัญญาณใหม่) ----------
async function notifyTelegram(analysis, previous) {
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

  const msg =
    `🥇 XAUUSD — พบสัญญาณใหม่\n` +
    `เปลี่ยนจาก: ${prevBiasText} → ${analysis.bias}\n\n` +
    `ราคา: ${analysis.price}\n\n` +
    tfLine('4H', '4h') +
    tfLine('1H', '1h') +
    tfLine('15M', '15m') +
    `\nแผน: ${analysis.plan_summary}\n` +
    `ข้อควรระวัง: ${analysis.confidence_note || '-'}\n\n` +
    `⚠️ นี่คือการสรุปโครงสร้างราคาโดย AI เพื่อประกอบการตัดสินใจเท่านั้น ไม่ใช่คำแนะนำการลงทุน`;

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg.slice(0, 4000) }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error('ส่ง Telegram ไม่สำเร็จ:', t);
  }
}
