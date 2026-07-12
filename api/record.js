// Version: 08
// هذا الملف يسجّل كل عملية تحليل ناجحة بقاعدة بيانات بسيطة (Upstash Redis) —
// يسجّل فورًا بمجرد التحليل، بغض النظر هل قيّم العميل المحصول أو لا.
// الهدف: بناء إحصائيات مستقبلية (الأكثر بحثًا: محاصيل، دول، معالجات، محامص، حار/بارد)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

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

const PROCESS_ALIASES = {
  "washed": "washed", "مغسولة": "washed", "مغسول": "washed",
  "natural": "natural", "طبيعية": "natural", "طبيعي": "natural", "جاف": "natural", "جافة": "natural",
  "honey": "honey", "عسلية": "honey", "عسلي": "honey",
  "anaerobic": "anaerobic", "لاهوائية": "anaerobic", "لاهوائي": "anaerobic",
  "wet hulled": "wet-hulled", "شبه مغسولة": "wet-hulled"
};

function normalizeWithAliases(text, aliasMap) {
  if (!text) return "unknown";
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

async function bumpCounter(dimension, key) {
  const dayKey = new Date().toISOString().slice(0, 10);
  return Promise.all([
    redis.hincrby(`${dimension}:day:${dayKey}`, key, 1),
    redis.hincrby(`${dimension}:all`, key, 1)
  ]);
}

export default async function handler(req, res) {
  // GET: يرجع قائمة بأسماء المحامص المعروفة سابقًا (تُستخدم كاقتراحات إكمال تلقائي
  // بالموقع، عشان نقلل تكرار نفس المحمصة بأسماء/لغات مختلفة)
  if (req.method === "GET") {
    try {
      const allCounts = await redis.hgetall("roastery:all") || {};
      const slugs = Object.keys(allCounts);
      const names = await Promise.all(
        slugs.map(async (slug) => {
          const meta = await redis.hget(`roastery_meta:${slug}`, "displayName");
          return meta || slug;
        })
      );
      return res.status(200).json({ roasteries: [...new Set(names)] });
    } catch (err) {
      console.error("Roastery list error:", err);
      return res.status(200).json({ roasteries: [] }); // فشل هذا الجزء ما يوقف الموقع
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { coffeeType, origin, process: coffeeProcess, roastLevel, roasteryName, tempChoice } = req.body || {};

    const normalizedOrigin = normalizeWithAliases(origin, ORIGIN_ALIASES);
    const normalizedProcess = normalizeWithAliases(coffeeProcess, PROCESS_ALIASES);
    const normalizedRoastery = slugify(roasteryName);
    const normalizedCoffeeType = slugify(coffeeType);

    // ملاحظة مهمة: beans_id يعتمد على اسم المحمصة كنص. لو نفس المحمصة الفعلية
    // انكتب اسمها بصيغتين مختلفتين تمامًا (مثل "صواع" يدويًا و"Roasting House"
    // من الصورة)، النظام حاليًا يعتبرهم محمصتين مختلفتين لأنه ما فيه تشابه نصي
    // بينهم يقدر الكود يكتشفه تلقائيًا. هذا يحتاج حل مستقبلي (دمج يدوي من لوحة
    // تحكم أو ربط الحساب بمحمصة مفضّلة بعد تسجيل الدخول) — مو خطأ بالكود الحالي.
    const beansId = [normalizedRoastery, normalizedCoffeeType, normalizedOrigin].join("_");

    await Promise.all([
      bumpCounter("beans", beansId),
      bumpCounter("roastery", normalizedRoastery),
      origin ? bumpCounter("origin", normalizedOrigin) : Promise.resolve(),
      coffeeProcess ? bumpCounter("process", normalizedProcess) : Promise.resolve(),
      tempChoice ? bumpCounter("temp", tempChoice === "cold" ? "cold" : "hot") : Promise.resolve(),
      redis.hset(`roastery_meta:${normalizedRoastery}`, { displayName: roasteryName || normalizedRoastery }),
      redis.hset(`beans_meta:${beansId}`, {
        coffeeType: coffeeType || "",
        origin: origin || "",
        process: coffeeProcess || "",
        roastLevel: roastLevel || "",
        roasteryName: roasteryName || "",
        lastSeen: new Date().toISOString()
      })
    ]);

    return res.status(200).json({ ok: true, beansId, roasteryId: normalizedRoastery });
  } catch (err) {
    console.error("Record error:", err);
    return res.status(500).json({ ok: false, error: "فشل حفظ الإحصائية" });
  }
}
