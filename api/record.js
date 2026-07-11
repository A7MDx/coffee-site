// هذا الملف يسجّل كل عملية تحليل ناجحة بقاعدة بيانات بسيطة (Upstash Redis).
// الهدف: بناء إحصائيات مستقبلية (الأكثر بحثًا: محاصيل، دول، معالجات، محامص)
// بدون ما نبني الآن أي واجهة عرض لها — بس نجمع الأرقام الخام أول.
//
// طريقة التخزين: لكل بُعد (beans, roastery, origin, process) نحتفظ بـ:
//   - مفتاح "day:<التاريخ>"  → عداد يومي، يسمح لاحقًا نجمع أي مدة نبيها (7 أيام، 30 يوم...)
//   - مفتاح "all"            → إجمالي تراكمي دائم منذ أول استخدام، ما ينصفر أبدًا

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

// قاموس تطبيع أسماء الدول — يحول أي صيغة (عربي/إنجليزي/مع منطقة) لاسم قياسي واحد.
const ORIGIN_ALIASES = {
  "colombia": "colombia", "كولومبيا": "colombia",
  "ethiopia": "ethiopia", "اثيوبيا": "ethiopia", "إثيوبيا": "ethiopia",
  "brazil": "brazil", "البرازيل": "brazil",
  "kenya": "kenya", "كينيا": "kenya",
  "guatemala": "guatemala", "غواتيمالا": "guatemala",
  "honduras": "honduras", "هندوراس": "honduras",
  "costa rica": "costa-rica", "كوستاريكا": "costa-rica", "كوستا ريكا": "costa-rica",
  "panama": "panama", "بنما": "panama",
  "peru": "peru", "بيرو": "peru",
  "yemen": "yemen", "اليمن": "yemen",
  "indonesia": "indonesia", "اندونيسيا": "indonesia", "إندونيسيا": "indonesia",
  "rwanda": "rwanda", "رواندا": "rwanda",
  "burundi": "burundi", "بوروندي": "burundi",
  "el salvador": "el-salvador", "السلفادور": "el-salvador",
  "mexico": "mexico", "المكسيك": "mexico"
};

// قاموس تطبيع طرق المعالجة — نفس فكرة الدول بالضبط.
const PROCESS_ALIASES = {
  "washed": "washed", "مغسولة": "washed", "مغسول": "washed",
  "natural": "natural", "طبيعية": "natural", "طبيعي": "natural", "جاف": "natural", "جافة": "natural",
  "honey": "honey", "عسلية": "honey", "عسلي": "honey",
  "anaerobic": "anaerobic", "لاهوائية": "anaerobic", "لاهوائي": "anaerobic",
  "wet hulled": "wet-hulled", "شبه مغسولة": "wet-hulled"
};

function normalizeWithAliases(text, aliasMap) {
  if (!text) return "unknown";
  // ناخذ أول جزء بس لو فيه شرطة أو أي فاصل (يعني فيه تفاصيل إضافية مرفقة)
  const firstPart = text.toString().trim().toLowerCase().split(/[-–,]/)[0].trim();
  return aliasMap[firstPart] || slugify(firstPart);
}

function slugify(text) {
  return (text || "unknown")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// يزيد عداد اليوم الحالي + العداد الإجمالي الدائم لبُعد معيّن، بضربة واحدة
async function bumpCounter(dimension, key) {
  const dayKey = new Date().toISOString().slice(0, 10); // مثل 2026-07-11
  return Promise.all([
    redis.hincrby(`${dimension}:day:${dayKey}`, key, 1),
    redis.hincrby(`${dimension}:all`, key, 1)
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { coffeeType, origin, process: coffeeProcess, roastLevel, roasteryName } = req.body || {};

    const normalizedOrigin = normalizeWithAliases(origin, ORIGIN_ALIASES);
    const normalizedProcess = normalizeWithAliases(coffeeProcess, PROCESS_ALIASES);
    const normalizedRoastery = slugify(roasteryName);
    const normalizedCoffeeType = slugify(coffeeType);

    // beans_id فريد لكل تركيبة (محمصة + نوع المحصول + بلد المنشأ)
    // نفس المحصول من نفس المحمصة يرجع يزيد نفس العداد بدل ما ينشئ سجل جديد
    const beansId = [normalizedRoastery, normalizedCoffeeType, normalizedOrigin].join("_");

    await Promise.all([
      bumpCounter("beans", beansId),
      bumpCounter("roastery", normalizedRoastery),
      origin ? bumpCounter("origin", normalizedOrigin) : Promise.resolve(),
      coffeeProcess ? bumpCounter("process", normalizedProcess) : Promise.resolve(),
      redis.hset(`beans_meta:${beansId}`, {
        coffeeType: coffeeType || "",
        origin: origin || "",
        process: coffeeProcess || "",
        roastLevel: roastLevel || "",
        roasteryName: roasteryName || "",
        lastSeen: new Date().toISOString()
      })
    ]);

    return res.status(200).json({ ok: true, beansId });
  } catch (err) {
    console.error("Record error:", err);
    // فشل التسجيل ما يفترض يوقف تجربة المستخدم أبدًا — بس نرجع خطأ صامت
    return res.status(500).json({ ok: false, error: "فشل حفظ الإحصائية" });
  }
}
