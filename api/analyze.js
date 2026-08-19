// /api/analyze.js
// Vercel Serverless Function: ดึงราคา XAUUSD -> วิเคราะห์ด้วย Claude -> เก็บ Supabase -> แจ้งเตือน LINE
//
// ENV VARS ที่ต้องตั้งใน Vercel Project Settings:
//   TWELVEDATA_API_KEY   = d6f320883cdb4aa9ba996c601445364a
//   ANTHROPIC_API_KEY    = key จาก console.anthropic.com
//   SUPABASE_URL         = https://uhefxwccuqagnbrbidbh.supabase.co
//   SUPABASE_SERVICE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZWZ4d2NjdXFhZ25icmJpZGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjAwMjU0NiwiZXhwIjoyMTAxNTc4NTQ2fQ.IXqz87BVcOXVTTwSwAb8CpCL8ATm4DjPMi1wTePQAkM
//   LINE_CHANNEL_TOKEN   = Channel access token ของ LINE Official Account (Messaging API)
//   LINE_USER_ID         = userId หรือ groupId ปลายทางที่จะรับข้อความ (วิธีหาไว้ใน README)
//   CRON_SECRET          = string สุ่มไว้กันคนอื่นยิง endpoint นี้เล่น

export default async function handler(req, res) {
  // กันคนนอกเรียก endpoint ตรงๆ (Vercel Cron จะแนบ header นี้ให้อัตโนมัติ หรือจะเช็ค query secret ก็ได้)
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const candles = await fetchGoldCandles();
    const analysis = await analyzeWithClaude(candles);
    await saveToSupabase(candles, analysis);
    await notifyLine(analysis);

    return res.status(200).json({ ok: true, summary: analysis.bias });
  } catch (err) {
    console.error('analyze.js error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

// ---------- 1) ดึงราคา OHLC จาก Twelve Data ----------
async function fetchGoldCandles() {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1h&outputsize=60&apikey=${process.env.TWELVEDATA_API_KEY}`;
  const r = await fetch(url);
  const data = await r.json();

  if (data.status === 'error' || !data.values) {
    throw new Error('Twelve Data error: ' + JSON.stringify(data));
  }

  // เรียงจากเก่า -> ใหม่ ให้ Claude อ่านง่าย
  const candles = data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();

  return candles;
}

// ---------- 2) วิเคราะห์ด้วย Claude API ----------
async function analyzeWithClaude(candles) {
  const lastPrice = candles[candles.length - 1].close;

  const candleText = candles
    .map((c) => `${c.time} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`)
    .join('\n');

  const systemPrompt = `คุณเป็นผู้ช่วยวิเคราะห์เทคนิคัลสำหรับ XAUUSD (ทองคำ) เท่านั้น
วิเคราะห์จากข้อมูลแท่งเทียน H1 ที่ให้มา แล้วตอบกลับเป็น JSON ล้วนๆ (ไม่มีข้อความอื่นนอก JSON) ตามโครงสร้างนี้เท่านั้น:
{
  "trend": "Bullish หรือ Bearish หรือ Sideway",
  "support_levels": ["ตัวเลขราคาแนวรับ เรียงจากใกล้สุดไปไกลสุด"],
  "resistance_levels": ["ตัวเลขราคาแนวต้าน เรียงจากใกล้สุดไปไกลสุด"],
  "structure_note": "อธิบายโครงสร้างราคาสั้นๆ เช่น BOS/CHoCH หรือ higher-high/lower-low pattern",
  "bias": "Long หรือ Short หรือ Wait",
  "plan_summary": "แผนแนวคิดสั้นๆ ไม่เกิน 3 บรรทัด ระบุโซนที่น่าสนใจ ไม่ใช่คำสั่งซื้อขายที่ฟันธง",
  "confidence_note": "ข้อควรระวัง หรือเงื่อนไขที่ทำให้มุมมองนี้เปลี่ยน"
}
สำคัญ: นี่คือการสรุปโครงสร้างราคาเพื่อประกอบการตัดสินใจของผู้ใช้เอง ไม่ใช่คำแนะนำการลงทุนที่รับประกันผลลัพธ์`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `ราคาล่าสุด (close ล่าสุด): ${lastPrice}\n\nข้อมูลแท่งเทียน H1 ย้อนหลัง 60 แท่ง:\n${candleText}`,
        },
      ],
    }),
  });

  const data = await r.json();
  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude API ไม่ส่ง text กลับมา: ' + JSON.stringify(data));

  let parsed;
  try {
    // กันกรณี Claude ใส่ ```json มาด้วย
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
async function saveToSupabase(candles, analysis) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/xauusd_analysis`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      price_snapshot: analysis.price,
      timeframe: '1h',
      trend: analysis.trend,
      support_levels: (analysis.support_levels || []).join(', '),
      resistance_levels: (analysis.resistance_levels || []).join(', '),
      structure_note: analysis.structure_note,
      bias: analysis.bias,
      plan_summary: analysis.plan_summary,
      full_analysis: analysis.full_text,
      raw_candles: candles,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('Supabase insert ล้มเหลว: ' + t);
  }
}

// ---------- 4) แจ้งเตือนผ่าน LINE Messaging API ----------
async function notifyLine(analysis) {
  if (!process.env.LINE_CHANNEL_TOKEN || !process.env.LINE_USER_ID) return; // ข้ามถ้ายังไม่ตั้งค่า

  const msg =
    `🥇 XAUUSD Update\n` +
    `ราคา: ${analysis.price}\n` +
    `เทรนด์: ${analysis.trend}\n` +
    `แนวรับ: ${(analysis.support_levels || []).join(', ')}\n` +
    `แนวต้าน: ${(analysis.resistance_levels || []).join(', ')}\n` +
    `Bias: ${analysis.bias}\n` +
    `แผน: ${analysis.plan_summary}\n` +
    `หมายเหตุ: ${analysis.confidence_note || '-'}`;

  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
    },
    body: JSON.stringify({
      to: process.env.LINE_USER_ID,
      messages: [{ type: 'text', text: msg.slice(0, 4900) }],
    }),
  });
}
