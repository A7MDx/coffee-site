// Version: 11
// هذا الملف يسجّل تقييم العميل (1-5 نجوم) لمحصول معيّن، ويربطه أيضًا بالمحمصة.
// نخزن مجموع التقييمات وعددها بشكل منفصل (يومي + إجمالي دائم)، عشان نقدر نحسب
// لاحقًا "متوسط التقييم" لأي فترة نبيها (هذا الشهر، آخر 30 يوم، أو كل الوقت).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

// يزيد مجموع النجوم وعدد المقيّمين لبُعد معيّن (محصول أو محمصة)، يومي + إجمالي دائم
async function bumpRating(dimension, key, stars) {
  const dayKey = new Date().toISOString().slice(0, 10);
  return Promise.all([
    redis.hincrby(`${dimension}_rating_sum:day:${dayKey}`, key, stars),
    redis.hincrby(`${dimension}_rating_count:day:${dayKey}`, key, 1),
    redis.hincrby(`${dimension}_rating_sum:all`, key, stars),
    redis.hincrby(`${dimension}_rating_count:all`, key, 1)
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { beansId, roasteryId, rating } = req.body || {};
    const stars = Number(rating);

    if (!beansId || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: "بيانات تقييم غير صحيحة" });
    }

    await Promise.all([
      bumpRating("beans", beansId, stars),
      roasteryId ? bumpRating("roastery", roasteryId, stars) : Promise.resolve()
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Rate error:", err);
    return res.status(500).json({ ok: false, error: "فشل حفظ التقييم" });
  }
}
