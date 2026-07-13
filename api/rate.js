// Version: 13
// هذا الملف يسجّل تقييم العميل (1-5 نجوم) لمحصول معيّن، ويربطه أيضًا بالمحمصة.
// نخزن مجموع التقييمات وعددها بشكل منفصل (يومي + إجمالي دائم)، عشان نقدر نحسب
// لاحقًا "متوسط التقييم" لأي فترة نبيها (هذا الشهر، آخر 30 يوم، أو كل الوقت).
//
// التعليق النصي اختياري دائمًا. كل تعليق له معرّف فريد ومرتبط بهوية كاتبه
// (لو كان مسجّل دخول) — عشان صاحب التعليق بس أو المالك يقدر يحذفه لاحقًا.
// ملاحظة تصميمية مهمة: زر التقييم/التعليق لازم يظهر بس لمن صوّر الكيس بنفسه
// أو فتح المحصول من مفضلته — مو لمن يتصفح "الأكثر بحثًا" بصفحة مستقبلية،
// وهذا محقق تلقائيًا حاليًا لأن مافيه صفحة تصفح عامة بعد.

import { Redis } from "@upstash/redis";
import crypto from "crypto";

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

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const match = raw.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split("=")[1] : null;
}

async function getRequester(req) {
  const token = getCookie(req, "mohal_session");
  if (!token) return null;
  const userId = await redis.get(`session:${token}`);
  if (!userId) return null;
  const user = await redis.hgetall(`user:${userId}`);
  if (!user || !user.email) return null;
  return { userId, email: user.email, role: user.role || "user" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { action } = req.body || {};

    // حذف تعليق — بس صاحبه أو المالك يقدر
    if (action === "delete-comment") {
      const { beansId, commentId } = req.body;
      if (!beansId || !commentId) {
        return res.status(400).json({ error: "بيانات ناقصة" });
      }
      const requester = await getRequester(req);
      if (!requester) {
        return res.status(401).json({ error: "لازم تسجّل دخول أول" });
      }

      const raw = await redis.hget(`beans_comments:${beansId}`, commentId);
      if (!raw) {
        return res.status(404).json({ error: "التعليق غير موجود" });
      }
      const commentData = typeof raw === "string" ? JSON.parse(raw) : raw;

      const isOwner = requester.role === "owner";
      const isAuthor = commentData.userId && commentData.userId === requester.userId;
      if (!isOwner && !isAuthor) {
        return res.status(403).json({ error: "ما عندك صلاحية تحذف هذا التعليق" });
      }

      await redis.hdel(`beans_comments:${beansId}`, commentId);
      return res.status(200).json({ ok: true });
    }

    // تسجيل تقييم جديد (+ تعليق اختياري)
    const { beansId, roasteryId, rating, comment } = req.body || {};
    const stars = Number(rating);
    const commentText = (comment || "").toString().trim().slice(0, 500);

    if (!beansId || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: "بيانات تقييم غير صحيحة" });
    }

    const tasks = [
      bumpRating("beans", beansId, stars),
      roasteryId ? bumpRating("roastery", roasteryId, stars) : Promise.resolve()
    ];

    if (commentText) {
      const requester = await getRequester(req); // قد يكون null لو ما سجّل دخول — التعليق يبقى مسموح، بس بدون إمكانية حذف ذاتي لاحقًا
      const commentId = crypto.randomUUID();
      tasks.push(redis.hset(`beans_comments:${beansId}`, {
        [commentId]: JSON.stringify({
          rating: stars,
          comment: commentText,
          userId: requester ? requester.userId : null,
          createdAt: new Date().toISOString()
        })
      }));
    }

    await Promise.all(tasks);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Rate error:", err);
    return res.status(500).json({ ok: false, error: "فشل حفظ التقييم" });
  }
}
