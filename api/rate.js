// Version: 12
// هذا الملف يسجّل تقييم العميل (1-5 نجوم) لمحصول معيّن، ويربطه أيضًا بالمحمصة.
// نخزن مجموع التقييمات وعددها بشكل منفصل (يومي + إجمالي دائم)، عشان نقدر نحسب
// لاحقًا "متوسط التقييم" لأي فترة نبيها (هذا الشهر، آخر 30 يوم، أو كل الوقت).
//
// التعليق النصي اختياري دائمًا — العميل يقدر يقيّم بالنجوم بس بدون ما يكتب شي.
// لو كتب تعليق، ينحفظ بقائمة منفصلة لكل محصول، جاهزة لعرضها لاحقًا بصفحة
// المحصول ("تعليقات الناس") بدون ما نحتاج نعيد بناء أي شي.

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
    const { beansId, roasteryId, rating, comment } = req.body || {};
    const stars = Number(rating);
    const commentText = (comment || "").toString().trim().slice(0, 500); // حد أقصى بسيط لمنع إساءة الاستخدام

    if (!beansId || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: "بيانات تقييم غير صحيحة" });
    }

    const tasks = [
      bumpRating("beans", beansId, stars),
      roasteryId ? bumpRating("roastery", roasteryId, stars) : Promise.resolve()
    ];

    // التعليق اختياري تمامًا — ما نحفظ شي إذا العميل ما كتب شي
    if (commentText) {
      tasks.push(redis.rpush(`beans_comments:${beansId}`, JSON.stringify({
        rating: stars,
        comment: commentText,
        createdAt: new Date().toISOString()
      })));
    }

    await Promise.all(tasks);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Rate error:", err);
    return res.status(500).json({ ok: false, error: "فشل حفظ التقييم" });
  }
}
