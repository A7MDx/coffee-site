// Version: 22  (رقم إصدار هذا الملف بس — الخانة الأولى برقم الإصدار الكامل بالموقع)
// هذا الملف يشتغل على السيرفر فقط (Vercel) — المستخدم أبدًا ما يشوف محتواه.
// 4 أوضاع:
//  1) mode=identify: يستقبل الصورة بس، يتعرف على المحصول (بدون وصفة) — خطوة أولى خفيفة.
//  2) mode=recipe: يستقبل بيانات المحصول من identify + طريقة التحضير/الأكواب/الطاحونة
//     (نصي، بدون صورة)، ويبني الوصفة الكاملة.
//  3) mode=refine: "تحسين الوصفة" حسب تفضيلات حسية جديدة.
//  4) mode=freshness: نافذة الذروة حسب تاريخ التحميص.

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

// حقول التعرّف على المحصول بس — بدون أي أرقام وصفة
const IDENTIFY_SCHEMA = `{
  "coffee_type": "اسم المحصول التجاري كما هو مطبوع على الكيس، لكن مكتوب بحروف عربية دائمًا. لو الاسم مكتوب بالعربي على الكيس، استخدمه كما هو. لو مكتوب بالإنجليزي فقط (زي Hambela Buku أو Agustino Forest)، لا تترجم المعنى إطلاقًا — انقل النطق بحروف عربية بس (نقل صوتي/Transliteration)، مثل: Hambela Buku تصير 'هامبيلا بوكو'. لو ما فيه اسم واضح، وصف مختصر جدًا بالعربي (نوع الحبة فقط).",
  "roast_level": "درجة التحميص المتوقعة",
  "origin": "بلد المنشأ فقط بالإنجليزي القياسي (مثل Colombia)، بدون منطقة أو مدينة، وإلا unknown",
  "process": "طريقة المعالجة (washed/natural/honey/anaerobic) بالإنجليزي، وإلا unknown",
  "roastery_name": "اسم المحمصة (فضّل العربي لو موجود بلغتين)، وإلا unknown بالضبط",
  "confidence_note": "ملاحظة قصيرة عن وضوح الصورة أو مصدر البيانات",
  "sensory": {
    "acidity": رقم تقديري من 0 إلى 100 لشدة الإحساس بالحموضة المتوقع في الكوب,
    "sweetness": رقم تقديري من 0 إلى 100 للحلاوة المتوقعة,
    "body": رقم تقديري من 0 إلى 100 لقوام/كثافة الكوب المتوقعة,
    "bitterness": رقم تقديري من 0 إلى 100 للمرارة المتوقعة
  }
}`;

// حقول الوصفة الكاملة (تُبنى بخطوة ثانية بعد التعرّف على المحصول)
const RECIPE_SCHEMA = `{
  "amount_grams": "كمية البن المقترحة بالجرام لكل الأكواب مجتمعة، مثل 18غ",
  "why_amount": "شرح تعليمي قصير (2-3 جمل)",
  "brew_ratio": "نسبة القهوة للماء مثل 1:16",
  "why_ratio": "شرح تعليمي قصير (2-3 جمل)",
  "temperature_c": رقم درجة الحرارة بالمئوية فقط,
  "why_temperature": "شرح تعليمي قصير (2-3 جمل)",
  "pours_count": رقم عدد الصبات بين 2 و4,
  "why_pours": "شرح تعليمي قصير (2-3 جمل)",
  "ice_amount": "كمية الثلج المقترحة لو التحضير بارد، وإلا null",
  "why_ice": "شرح قصير لو باردة، وإلا null",
  "pours_breakdown": [{"label": "الصبة الأولى", "amount": "مثل 40 مل", "time": "0:00 - 0:30"}],
  "grind_setting": "رقم أو وصف الطحنة المقترح",
  "why_grind": "شرح تعليمي قصير (2-3 جمل)",
  "notes": "ملاحظة ختامية تعليمية قصيرة"
}`;

// بنية الـ JSON الكاملة (تُستخدم بوضع التحسين اللي يحتاج يرجع كل شي مع بعض)
const RESULT_SCHEMA = `{
  "coffee_type": "اسم المحصول (كما استُخرج سابقًا، انقله بدون تغيير)",
  "roast_level": "درجة التحميص (كما استُخرجت سابقًا)",
  "origin": "بلد المنشأ (كما استُخرج سابقًا)",
  "process": "طريقة المعالجة (كما استُخرجت سابقًا)",
  "roastery_name": "اسم المحمصة (كما استُخرج سابقًا)",
  "confidence_note": "ملاحظة قصيرة",
  ${RECIPE_SCHEMA.slice(1, -1)},
  "sensory": {
    "acidity": رقم من 0 إلى 100,
    "sweetness": رقم من 0 إلى 100,
    "body": رقم من 0 إلى 100,
    "bitterness": رقم من 0 إلى 100
  }
}`;

const POUR_LABEL_RULE = `مهم جدًا بخصوص pours_breakdown: سمّي كل صبة بالضبط "الصبة الأولى"، "الصبة الثانية"، "الصبة الثالثة"، "الصبة الرابعة" فقط — بدون أي كلمة إضافية مثل (Bloom).`;

async function callClaude(contentBlocks, maxTokens = 2200) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: contentBlocks }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Anthropic API error:", errText);
    throw { status: 502, message: "فشل الاتصال بخدمة التحليل" };
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === "text");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (parseErr) {
    console.error("JSON parse failed. Raw model output:", clean);
    throw { status: 502, message: "فشل تحليل رد النموذج، جرّب مرة أخرى" };
  }
}

// الخطوة الأولى: تعرّف على المحصول من الصورة بس (بدون وصفة، أرخص وأسرع)
async function handleIdentify(req, res, ip) {
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "لم يتم إرسال صورة" });

  try {
    const parsed = await callClaude([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
      {
        type: "text",
        text: `أنت خبير قهوة متخصص. انظر لصورة كيس القهوة هذي وتعرّف على المحصول: نوعه، درجة تحميصه، بلد منشأه، طريقة معالجته، واسم المحمصة لو ظاهر. استنتج أيضًا الملف الحسي المتوقع (sensory) بناءً على بلد المنشأ، الارتفاع، المعالجة، الصنف، التحميص، وأي إيحاءات مكتوبة على الكيس.

أجب بصيغة JSON فقط بدون أي نص إضافي، بالشكل التالي بالضبط:
${IDENTIFY_SCHEMA}`
      }
    ], 1200);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "حدث خطأ غير متوقع بالسيرفر" });
  }
}

// الخطوة الثانية: بناء الوصفة الكاملة نصيًا بعد ما يختار العميل حار/بارد، الأكواب، والطاحونة
async function handleRecipe(req, res, ip) {
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { beanProfile, tempChoice, grinderInfo, cupCount } = req.body || {};
  if (!beanProfile) return res.status(400).json({ error: "بيانات المحصول ناقصة" });
  if (!tempChoice) return res.status(400).json({ error: "لم يتم تحديد طريقة التحضير" });

  const cups = Number(cupCount) > 0 ? Number(cupCount) : 1;

  const tempLabel = tempChoice === "cold"
    ? "V60 مثلّج (Iced V60): يُحضّر بنفس أسلوب الصب المعتاد لكن بماء أعلى تركيزًا وبثلج بالإبريق يستقبل القهوة الساخنة ليبردها فورًا. هذا مختلف تمامًا عن Cold brew التقليدي بالنقع البارد الطويل. لازم تحدد كمية الثلج المقترحة (ice_amount) ضمن الكمية الكلية للماء."
    : "V60 حار عادي (Pour-over ساخن)";

  const grinderLine = grinderInfo
    ? `العميل حدد إنه يستخدم طاحونة: ${grinderInfo}. اقترح رقم/إعداد طحن يناسب هذي الطاحونة تحديدًا ضمن حقل grind_setting، واشرح ليش بحقل why_grind.`
    : "العميل ما حدد نوع طاحونته. أعطِ وصف طحن عام فقط (ناعم/متوسط/خشن) بحقل grind_setting بدون رقم محدد.";

  const cupsLine = `العميل يبي يحضّر ${cups} كوب/أكواب. افترض أن كل كوب نهائي جاهز للشرب يعادل تقريبًا 280 إلى 300 مل. احسب الكمية الإجمالية بناءً على هذا الحجم مضروبًا بعدد الأكواب، مو ضرب خطي بسيط.
${cups > 1 ? `مهم: بما إن الكمية أكبر من كوب واحد، خشّن الطحنة قليلًا لتفادي الاستخلاص الزائد، ووضّح هذا بـ why_grind.` : ""}`;

  try {
    const parsed = await callClaude([
      {
        type: "text",
        text: `أنت خبير قهوة متخصص وتعمل في تطبيق تثقيفي هدفه تعليم العميل عن القهوة، مو بس إعطاءه تعليمات.

هذي بيانات المحصول اللي استخرجناها مسبقًا من الصورة:
${JSON.stringify(beanProfile)}

طريقة التحضير المطلوبة: ${tempLabel}

${cupsLine}

${grinderLine}

ابنِ الوصفة الكاملة المناسبة لهذا المحصول بالذات. أجب بصيغة JSON فقط بدون أي نص إضافي، بالشكل التالي بالضبط:
${RECIPE_SCHEMA}

${POUR_LABEL_RULE}`
      }
    ]);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "حدث خطأ غير متوقع بالسيرفر" });
  }
}

async function handleRefine(req, res, ip) {
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { beanProfile, originalRecipe, targetSensory, tempChoice, cupCount } = req.body || {};
  if (!beanProfile || !originalRecipe || !targetSensory) {
    return res.status(400).json({ error: "بيانات التحسين ناقصة" });
  }

  const cups = Number(cupCount) > 0 ? Number(cupCount) : 1;
  const tempLabel = tempChoice === "cold" ? "V60 مثلّج (Iced V60)" : "V60 حار عادي";

  try {
    const parsed = await callClaude([
      {
        type: "text",
        text: `أنت خبير قهوة متخصص. عميل حلّل بالفعل كيس قهوة، وهذي بيانات البن الحقيقية المستخرجة منه:
${JSON.stringify(beanProfile)}

والوصفة الأصلية اللي اقترحتها سابقًا:
${JSON.stringify(originalRecipe)}

الملف الحسي الأصلي المتوقع كان:
${JSON.stringify(originalRecipe.sensory)}

الآن العميل يبي يخصص كوبه، وحدد أهداف حسية جديدة (من 0 إلى 100 لكل خاصية):
${JSON.stringify(targetSensory)}

طريقة التحضير: ${tempLabel}، لعدد ${cups} كوب/أكواب (كل كوب نهائي ≈ 280-300 مل).

أعد بناء الوصفة الكاملة بأفضل شكل يقارب هذي الأهداف قدر الإمكان، وتقدر تعدل أي عنصر (كمية البن، الماء، النسبة، الحرارة، الطحن، عدد الصبات، كمية كل صبة، توقيتها) إذا رأيت أنه يساعد.

قيد مهم جدًا: حافظ على طبيعة البن الحقيقية. لو البن منخفض الحموضة بطبيعته، لا يجوز تحويله لحموضة عالية جدًا — اقترب من رغبة العميل قدر الإمكان بس بدون تجاوز حدود ما يسمح فيه البن فعليًا، ووضّح هذا القيد بحقل notes لو صار تعارض بين الهدف والواقع.

أرجع نفس بنية الـ JSON الكاملة التالية (بما فيها sensory محدث يعكس التقدير الواقعي الجديد، مو بالضرورة نفس رقم الهدف بالضبط):
${RESULT_SCHEMA}

${POUR_LABEL_RULE}`
      }
    ]);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "حدث خطأ غير متوقع بالسيرفر" });
  }
}

async function handleFreshness(req, res, ip) {
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "عدد كبير من الطلبات. حاول بعد قليل." });
  }

  const { beanProfile, roastDate } = req.body || {};
  if (!beanProfile || !roastDate) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const daysSinceRoast = Math.floor((new Date(today) - new Date(roastDate)) / (1000 * 60 * 60 * 24));

  if (daysSinceRoast < 0) {
    return res.status(400).json({ error: "تاريخ التحميص لازم يكون بالماضي" });
  }

  try {
    const parsed = await callClaude([
      {
        type: "text",
        text: `أنت خبير قهوة متخصص. هذي بيانات محصول حقيقي:
${JSON.stringify(beanProfile)}

تاريخ التحميص: ${roastDate}
تاريخ اليوم: ${today}
عدد الأيام منذ التحميص: ${daysSinceRoast} يوم

بناءً على درجة التحميص وطريقة المعالجة وبلد المنشأ لهذا البن تحديدًا (مو قاعدة عامة ثابتة لكل قهوة)، استنتج:
1. النافذة المثلى المتوقعة لهذا البن بالذات (بعد كم يوم من التحميص تبدأ، ومتى تقريبًا تنتهي) — واشرح ليش هذي المدة بالذات لهذا البن (مثلاً: تحميص فاتح يحتاج تهوية أطول قبل ما يوصل ذروته، معالجة طبيعية تتصرف بشكل مختلف عن المغسولة، إلخ).
2. وضع البن الحالي بالنسبة لهذي النافذة: "لسه مبكر"، "بالنافذة المثلى"، أو "بدأ يفقد نكهته".

مهم جدًا بخصوص التقدير:
- خذ بالك إن القهوة المختصة عمومًا تبقى صالحة وذات نكهة جيدة لفترة أطول بكثير مما يتخيله أغلب الناس — التدهور الفعلي بالنكهة يصير تدريجي وبطيء، مو انهيار مفاجئ بيوم معين.
- وسّع تقديرك للنافذة المثلى (بدل مدى ضيق يخلي القهوة "تخرج من النافذة" بسرعة) ما لم يكن فيه سبب واضح وقوي يستدعي تضييقها.
- ميل للتفاؤل بتقديرك الافتراضي. لا تختر "بدأ يفقد نكهته" إلا لو البن تجاوز نافذته المثلى بمدة واضحة وكبيرة (مو بمجرد تجاوز يوم أو يومين بسيطين عن النهاية المتوقعة) — بهالحالة البسيطة اختر "بالنافذة المثلى" بدلاً منها.
- الهدف إنك تطمّن العميل على محصوله لا تخوّفه، إلا لو فيه سبب فعلي وواضح للقلق.

أجب بصيغة JSON فقط بدون أي نص إضافي:
{
  "window_start_days": رقم الأيام لبداية النافذة المثلى,
  "window_end_days": رقم الأيام لنهاية النافذة المثلى,
  "current_status": "لسه مبكر" أو "بالنافذة المثلى" أو "بدأ يفقد نكهته",
  "why": "شرح تعليمي (3-4 جمل) ليش هذي النافذة بالذات مبني على خصائص هذا البن تحديدًا، مو قاعدة عامة"
}`
      }
    ], 800);

    return res.status(200).json({ ...parsed, daysSinceRoast });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "حدث خطأ غير متوقع بالسيرفر" });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const mode = (req.body && req.body.mode) || "initial";

  if (mode === "identify") return handleIdentify(req, res, ip);
  if (mode === "recipe") return handleRecipe(req, res, ip);
  if (mode === "refine") return handleRefine(req, res, ip);
  if (mode === "freshness") return handleFreshness(req, res, ip);
  return handleIdentify(req, res, ip); // احتياطي، ما يفترض يُستخدم عادة
}
