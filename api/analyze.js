// هذا الملف يشتغل على السيرفر فقط (Vercel) — المستخدم أبدًا ما يشوف محتواه.
// وظيفته: يستقبل الصورة من الموقع، يتصل بـ Claude API باستخدام المفتاح السري،
// ثم يرجع النتيجة للموقع بدون ما يكشف المفتاح لأي حد.

// حد بسيط لعدد الطلبات لكل IP (يحمي من إساءة الاستخدام والفواتير المفاجئة)
const requestLog = new Map(); // ip -> [timestamps]
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
  // السماح فقط بطلبات POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  // تحديد هوية الزائر لتطبيق حد الاستخدام
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { imageBase64, tempChoice, grinderInfo } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: "لم يتم إرسال صورة" });
  }

  // مهم: كل التحاليل حاليًا مبنية على طريقة V60 فقط (حار أو مثلج).
  // لاحقًا بيُضاف خيارات إسبريسو وكيمكس، لكن حاليًا نثبّت الطريقة على V60 صراحة
  // عشان الموديل ما يفهمها غلط كـ Cold brew منقوع تقليدي.
  const tempLabel = tempChoice === "cold"
    ? "V60 مثلّج (Iced V60): يُحضّر بنفس أسلوب الصب المعتاد لكن بماء أعلى تركيزًا وبثلج بالإبريق يستقبل القهوة الساخنة ليبردها فورًا. هذا مختلف تمامًا عن Cold brew التقليدي بالنقع البارد الطويل."
    : "V60 حار عادي (Pour-over ساخن)";

  const grinderLine = grinderInfo
    ? `العميل حدد إنه يستخدم طاحونة: ${grinderInfo}. اقترح رقم/إعداد طحن يناسب هذي الطاحونة تحديدًا ضمن حقل grind_setting، واشرح ليش بحقل why_grind. لو الطاحونة غير معروفة عندك بدقة، أعطِ أقرب تقدير معقول ووضّح بـ why_grind إن هذا تقدير تقريبي.`
    : "العميل ما حدد نوع طاحونته. أعطِ وصف طحن عام فقط (مثل: ناعم، متوسط، خشن) بحقل grind_setting بدون رقم محدد، ووضّح بـ why_grind أساس هذا الوصف.";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY, // المفتاح مقروء من متغيرات بيئة Vercel فقط
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
              text: `أنت خبير قهوة متخصص وتعمل في تطبيق تثقيفي هدفه تعليم العميل عن القهوة، مو بس إعطاءه تعليمات.

طريقة التحضير المطلوبة: ${tempLabel}

${grinderLine}

انظر للصورة وقدّم تحليلك. حاول أيضًا تتعرف على اسم المحمصة (Roastery) لو مكتوب أو واضح على العبوة بالصورة. أجب بصيغة JSON فقط بدون أي نص إضافي أو markdown، بالشكل التالي بالضبط:
{
  "coffee_type": "النوع المتوقع",
  "roast_level": "درجة التحميص المتوقعة",
  "origin": "بلد المنشأ لو واضح بالصورة أو معروف من اسم المحصول، وإلا اكتب unknown",
  "process": "طريقة المعالجة (مغسولة/طبيعية/عسلية) لو واضحة، وإلا unknown",
  "roastery_name": "اسم المحمصة لو ظاهر بالصورة بوضوح (نص أو شعار)، وإلا اكتب unknown بالضبط",
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
  "grind_setting": "رقم أو وصف الطحنة المقترح حسب التعليمات أعلاه",
  "why_grind": "شرح تعليمي قصير (2-3 جمل)",
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
