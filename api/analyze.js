// هذا الملف يشتغل على السيرفر فقط (Vercel) — المستخدم أبدًا ما يشوف محتواه.
// وظيفته: يستقبل الصورة من الموقع، يتصل بـ Claude API باستخدام المفتاح السري،
// ثم يرجع النتيجة للموقع بدون ما يكشف المفتاح لأي حد.

const requestLog = new Map();
const MAX_REQUESTS_PER_HOUR = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < hour);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > MAX_REQUESTS_PER_HOUR;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { imageBase64, tempChoice } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: "لم يتم إرسال صورة" });
  }

  const tempLabel = tempChoice === "cold"
    ? "طريقة تحضير باردة (Cold brew / Iced pour-over)"
    : "طريقة تحضير ساخنة (Pour-over حار)";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            {
              type: "text",
              text: `أنت خبير قهوة متخصص وتعمل في تطبيق تثقيفي هدفه تعليم العميل عن القهوة، مو بس إعطاءه تعليمات. العميل اختار: ${tempLabel}.

انظر للصورة وقدّم تحليلك. أجب بصيغة JSON فقط بدون أي نص إضافي أو markdown، بالشكل التالي بالضبط:
{
  "coffee_type": "النوع المتوقع",
  "roast_level": "درجة التحميص المتوقعة",
  "confidence_note": "ملاحظة قصيرة عن وضوح الصورة",
  "brew_ratio": "نسبة القهوة للماء مثل 1:16",
  "why_ratio": "شرح تعليمي قصير (2-3 جمل)",
  "temperature_c": رقم درجة الحرارة بالمئوية فقط,
  "why_temperature": "شرح تعليمي قصير (2-3 جمل)",
  "pours_count": رقم عدد الصبات بين 2 و4,
  "why_pours": "شرح تعليمي قصير (2-3 جمل)",
  "pours_breakdown": [
    {"label": "الصبة الأولى", "amount": "مثل 40 مل", "time": "0:00 - 0:30"}
  ],
  "notes": "ملاحظة ختامية تعليمية قصيرة"
}`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ error: "فشل الاتصال بخدمة التحليل" });
    }

    const data = await response.json();
    const textBlock = data.content.find(b => b.type === "text");
    const clean = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "حدث خطأ غير متوقع بالسيرفر" });
  }
}
