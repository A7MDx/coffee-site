// هذا الملف يسجّل كل عملية تحليل ناجحة بقاعدة بيانات بسيطة (Vercel KV / Redis).
// الهدف: بناء إحصائيات مستقبلية (الأكثر بحثًا: محاصيل، دول، معالجات، محامص)
// بدون ما نبني الآن أي واجهة عرض لها — بس نجمع الأرقام الخام أول.

import { Redis } from "@upstash/redis";

// Vercel يضيف متغيرات البيئة تلقائيًا بعد ربط تكامل Upstash.
// نجرب الأسماء الشائعة لأن التسمية تختلف حسب طريقة الربط (KV_* القديمة أو UPSTASH_* الجديدة).
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

function slugify(text) {
  return (text || "unknown")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { coffeeType, origin, process: coffeeProcess, roastLevel, roasteryName } = req.body || {};

    // beans_id فريد لكل تركيبة (محمصة + نوع المحصول + بلد المنشأ)
    // نفس المحصول من نفس المحمصة يرجع يزيد نفس العداد بدل ما ينشئ سجل جديد
    const beansId = [
      slugify(roasteryName),
      slugify(coffeeType),
      slugify(origin)
    ].join("_");

    const monthKey = new Date().toISOString().slice(0, 7); // مثل 2026-07

    // زيادة العدادات المختلفة — كل واحد مستقل عشان نقدر نبني كل إحصائية لحالها بالمستقبل
    await Promise.all([
      redis.hincrby(`beans:${monthKey}`, beansId, 1),
      redis.hincrby(`roastery:${monthKey}`, slugify(roasteryName), 1),
      origin ? redis.hincrby(`origin:${monthKey}`, slugify(origin), 1) : Promise.resolve(),
      coffeeProcess ? redis.hincrby(`process:${monthKey}`, slugify(coffeeProcess), 1) : Promise.resolve(),
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
