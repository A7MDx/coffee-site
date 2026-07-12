// Version: 3.1
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

  const { imageBase64, tempChoice, grinderInfo, cupCount } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: "لم يتم إرسال صورة" });
  }
  if (!tempChoice) {
    return res.status(400).json({ error: "لم يتم تحديد طريقة التحضير" });
  }

  const cups = Number(cupCount) > 0 ? Number(cupCount) : 1;

  // مهم: كل التحاليل حاليًا مبنية على طريقة V60 فقط (حار أو مثلج).
  // لاحقًا بيُضاف خيارات إسبريسو وكيمكس، لكن حاليًا نثبّت الطريقة على V60 صراحة
  // عشان الموديل ما يفهمها غلط كـ Cold brew منقوع تقليدي.
  const tempLabel = tempChoice === "cold"
    ? "V60 مثلّج (Iced V60): يُحضّر بنفس أسلوب الصب المعتاد لكن بماء أعلى تركيزًا وبثلج بالإبريق يستقبل القهوة الساخنة ليبردها فورًا. هذا مختلف تمامًا عن Cold brew التقليدي بالنقع البارد الطويل. لازم تحدد كمية الثلج المقترحة (ice_amount) ضمن الكمية الكلية للماء."
    : "V60 حار عادي (Pour-over ساخن)";

  const grinderLine = grinderInfo
    ? `العميل حدد إنه يستخدم طاحونة: ${grinderInfo}. اقترح رقم/إعداد طحن يناسب هذي الطاحونة تحديدًا ضمن حقل grind_setting، واشرح ليش بحقل why_grind. لو الطاحونة غير معروفة عندك بدقة، أعطِ أقرب تقدير معقول ووضّح بـ why_grind إن هذا تقدير تقريبي.`
    : "العميل ما حدد نوع طاحونته. أعطِ وصف طحن عام فقط (مثل: ناعم، متوسط، خشن) بحقل grind_setting بدون رقم محدد، ووضّح بـ why_grind أساس هذا الوصف.";

  const cupsLine = `العميل يبي يحضّر لعدد ${cups} كوب/أكواب. اضرب كل الكميات (وزن البن بالجرام، حجم الماء المستخدم بالصبات، كمية الثلج لو باردة) بما يتناسب مع هذا العدد من الأكواب، واذكر الكمية الإجمالية المناسبة لكل الأكواب مع بعض (مو لكوب واحد فقط لو كان العدد أكثر من واحد).`;

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
        max_tokens: 2200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            {
              type: "text",
              text: `أنت خبير قهوة متخصص وتعمل في تطبيق تثقيفي هدفه تعليم العميل عن القهوة، مو بس إعطاءه تعليمات.

طريقة التحضير المطلوبة: ${tempLabel}

${cupsLine}

${grinderLine}

انظر للصورة وقدّم تحليلك. حاول أيضًا تتعرف على اسم المحمصة (Roastery) لو مكتوب أو واضح على العبوة بالصورة. أجب بصيغة JSON فقط بدون أي نص إضافي أو markdown، بالشكل التالي بالضبط:
{
  "coffee_type": "النوع المتوقع",
  "roast_level": "درجة التحميص المتوقعة",
  "origin": "بلد المنشأ فقط بالإنجليزي القياسي (مثل Colombia أو Ethiopia)، بدون أي منطقة أو مدينة أو اسم عربي مرافق، وإلا اكتب unknown بالضبط",
  "process": "طريقة المعالجة (washed/natural/honey/anaerobic) بالإنجليزي فقط لو واضحة، وإلا unknown",
  "roastery_name": "اسم المحمصة لو ظاهر بالصورة بوضوح (نص أو شعار)، وإلا اكتب unknown بالضبط",
  "confidence_note": "ملاحظة قصيرة عن وضوح الصورة",
  "amount_grams": "كمية البن المقترحة بالجرام لكل الأكواب مجتمعة، مثل 18غ أو 30غ",
  "why_amount": "شرح تعليمي قصير (2-3 جمل) ليش هذي الكمية بالذات",
  "brew_ratio": "نسبة القهوة للماء مثل 1:16",
  "why_ratio": "شرح تعليمي قصير (2-3 جمل)",
  "temperature_c": رقم درجة الحرارة بالمئوية فقط,
  "why_temperature": "شرح تعليمي قصير (2-3 جمل)",
  "pours_count": رقم عدد الصبات بين 2 و4,
  "why_pours": "شرح تعليمي قصير (2-3 جمل)",
  "ice_amount": "كمية الثلج المقترحة بالمل أو الجرام لو طريقة التحضير باردة، وإلا اترك القيمة null",
  "why_ice": "شرح تعليمي قصير ليش هذي كمية الثلج بالذات لو باردة، وإلا null",
  "pours_breakdown": [
    {"label": "الصبة الأولى", "amount": "مثل 40 مل", "time": "0:00 - 0:30"}
  ],
  "grind_setting": "رقم أو وصف الطحنة المقترح حسب التعليمات أعلاه",
  "why_grind": "شرح تعليمي قصير (2-3 جمل)",
  "notes": "ملاحظة ختامية تعليمية قصيرة"
}

مهم جدًا بخصوص pours_breakdown: سمّي كل صبة بالضبط "الصبة الأولى"، "الصبة الثانية"، "الصبة الثالثة"، "الصبة الرابعة" فقط — بدون أي كلمة إضافية مثل (Bloom) أو أي وصف ثاني بجانب الاسم.`
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

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error("JSON parse failed. Raw model output:", clean);
      return res.status(502).json({ error: "فشل تحليل رد النموذج، جرّب مرة أخرى" });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "حدث خطأ غير متوقع بالسيرفر" });
  }
}
