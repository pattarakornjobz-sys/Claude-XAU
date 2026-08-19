// api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD -> วิเคราะห์ด้วย Claude -> เก็บลง Supabase -> แจ้งเตือน Telegram (เฉพาะตอนมีสัญญาณใหม่)
//
// สำคัญ: ค่าทั้งหมดด้านล่างต้องตั้งเป็น Environment Variable บน Vercel เท่านั้น
// ห้ามเขียนค่าจริงลงในไฟล์นี้หรือใส่ไว้ในคอมเมนต์เด็ดขาด (เคยมีปัญหา key หลุดมาก่อน)
//
// ENV VARS ที่ต้องตั้งใน Vercel Project Settings -> Environment Variables:
//   TWELVEDATA_API_KEY   = API key จาก twelvedata.com
//   ANTHROPIC_API_KEY    = API key จาก console.anthropic.com
//   SUPABASE_URL         = URL โปรเจกต์ Supabase
//   SUPABASE_SERVICE_KEY = service_role key ของ Supabase (ใช้ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามส่งให้ browser)
//   TELEGRAM_BOT_TOKEN   = token ของ Telegram Bot (จาก BotFather)
//   TELEGRAM_CHAT_ID     = chat id ปลายทางที่จะรับการแจ้งเตือน
//   CRON_SECRET          = string สุ่มยาวๆ กันคนนอกยิง endpoint นี้เล่น

const SYMBOL = 'XAU/USD';
const INTERVAL = '1h';
const CANDLE_COUNT = 60;

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
    const candles = await fetchGoldCandles();
    const analysis = await analyzeWithClaude(candles);
    const previous = await getLastAnalysis();
    await saveToSupabase(candles, analysis);

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

// ---------- 1) ดึงราคา OHLC จาก Twelve Data ----------
async function fetchGoldCandles() {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า TWELVEDATA_API_KEY');

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${INTERVAL}&outputsize=${CANDLE_COUNT}&apikey=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();

  if (data.status === 'error' || !data.values) {
    throw new Error('Twelve Data error: ' + JSON.stringify(data));
  }

  return data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // เรียงจากเก่า -> ใหม่ ให้ Claude อ่านง่าย
}

// ---------- 2) วิเคราะห์ด้วย Claude API ----------
const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปโครงสร้างราคาทางเทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น
วิเคราะห์จากข้อมูลแท่งเทียน H1 ที่ให้มา แล้วตอบกลับเป็น JSON ล้วนๆ (ไม่มีข้อความอื่นนอก JSON ไม่มี markdown code fence) ตามโครงสร้างนี้เท่านั้น:
{
  "trend": "Bullish หรือ Bearish หรือ Sideway",
  "support_levels": ["ตัวเลขราคาแนวรับ เรียงจากใกล้สุดไปไกลสุด"],
  "resistance_levels": ["ตัวเลขราคาแนวต้าน เรียงจากใกล้สุดไปไกลสุด"],
  "structure_note": "อธิบายโครงสร้างราคาสั้นๆ เช่น BOS/CHoCH หรือ higher-high/lower-low pattern",
  "bias": "Long หรือ Short หรือ Wait",
  "plan_summary": "สรุปโครงสร้างราคาและโซนที่น่าสนใจสั้นๆ ไม่เกิน 3 บรรทัด ห้ามใช้ภาษาฟันธงแบบคำสั่งซื้อขาย เช่น ห้ามพูดว่า \\"ให้เข้าซื้อตอนนี้\\"",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่จะทำให้มุมมองนี้เปลี่ยนไป"
}
สำคัญ: นี่คือการสรุปโครงสร้างราคาเพื่อประกอบการตัดสินใจของผู้ใช้เอง ไม่ใช่คำแนะนำการลงทุนที่รับประกันผลลัพธ์ และไม่ใช่คำสั่งซื้อขายที่ชี้นำโดยตรง`;

async function analyzeWithClaude(candles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY');

  const lastPrice = candles[candles.length - 1].close;
  const candleText = candles
    .map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`)
    .join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `ราคาล่าสุด (close ล่าสุด): ${lastPrice}\n\nข้อมูลแท่งเทียน H1 ย้อนหลัง ${candles.length} แท่ง:\n${candleText}`,
        },
      ],
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

  return {
    price: lastPrice,
    full_text: textBlock.text,
    ...parsed,
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

async function saveToSupabase(candles, analysis) {
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
      timeframe: INTERVAL,
      trend: analysis.trend,
      support_levels: (analysis.support_levels || []).join(', '),
      resistance_levels: (analysis.resistance_levels || []).join(', '),
      structure_note: analysis.structure_note,
      bias: analysis.bias,
      plan_summary: analysis.plan_summary,
      confidence_note: analysis.confidence_note,
      full_analysis: analysis.full_text,
      raw_candles: candles,
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
  const msg =
    `🥇 XAUUSD — พบสัญญาณใหม่\n` +
    `เปลี่ยนจาก: ${prevBiasText} → ${analysis.bias}\n\n` +
    `ราคา: ${analysis.price}\n` +
    `เทรนด์: ${analysis.trend}\n` +
    `แนวรับ: ${(analysis.support_levels || []).join(', ') || '-'}\n` +
    `แนวต้าน: ${(analysis.resistance_levels || []).join(', ') || '-'}\n\n` +
    `แผน: ${analysis.plan_summary}\n` +
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
