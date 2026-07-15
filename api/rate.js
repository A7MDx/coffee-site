// Version: 16
// هذا الملف يسجّل تقييم العميل (1-5 نجوم) لمحصول معيّن، ويربطه أيضًا بالمحمصة.
// التقييم يتطلب تسجيل دخول إلزاميًا، ومرة وحدة بس لكل محصول لكل حساب (يمنع
// عبر مفتاح user_rated:{userId}:{beansId}) — لو يبي يغيّر رأيه، يحذف تقييمه
// القديم أول (وهذا يرجع ينقص الرقم من متوسط التقييم العام صح) وبعدها يقدر
// يقيّم من جديد.
// نخزن مجموع التقييمات وعددها بشكل منفصل (يومي + إجمالي دائم)، عشان نقدر نحسب
// لاحقًا "متوسط التقييم" لأي فترة نبيها (هذا الشهر، آخر 30 يوم، أو كل الوقت).
//
// التعليق النصي اختياري دائمًا. كل تعليق له معرّف فريد ومرتبط بهوية كاتبه
// (لو كان مسجّل دخول) — عشان صاحب التعليق بس أو المالك يقدر يحذفه لاحقًا.
//
// قائمة عامة (global_comments_feed): بدل ما نفتش كل مفاتيح beans_comments:*
// كل مرة (بطيء ومكلف)، نحتفظ بقائمة مختصرة تتحدّث تلقائيًا بكل تعليق جديد،
// بحد أقصى 200 عنصر — تُستخدم بصفحة الإحصائيات الخاصة بالمالك بس.

import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const GLOBAL_FEED_MAX = 200;

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
  // قائمة عامة بآخر التعليقات على كل المحاصيل — للمالك فقط
  if (req.method === "GET" && req.query.type === "global-feed") {
    const requester = await getRequester(req);
    if (!requester || requester.role !== "owner") {
      return res.status(403).json({ error: "ما عندك صلاحية لهذا الإجراء" });
    }
    try {
      const items = await redis.lrange("global_comments_feed", 0, GLOBAL_FEED_MAX - 1);
      const feed = items.map(i => (typeof i === "string" ? JSON.parse(i) : i));
      const totalComments = await redis.get("comments:total");
      return res.status(200).json({ feed, totalComments: totalComments || 0 });
    } catch (err) {
      console.error("Global feed error:", err);
      return res.status(200).json({ feed: [], totalComments: 0 });
    }
  }

  // جلب كل تعليقات محصول معيّن — يستخدمها أي زائر يشوف نفس المحصول
  if (req.method === "GET") {
    const { beansId } = req.query;
    if (!beansId) return res.status(400).json({ error: "بيانات ناقصة" });
    try {
      const raw = await redis.hgetall(`beans_comments:${beansId}`);
      const comments = Object.entries(raw || {}).map(([commentId, val]) => {
        const data = typeof val === "string" ? JSON.parse(val) : val;
        return { commentId, ...data };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ comments });
    } catch (err) {
      console.error("Fetch comments error:", err);
      return res.status(200).json({ comments: [] });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const { action } = req.body || {};

    // حذف تعليق/تقييم — بس صاحبه أو المالك يقدر، ويرجع ينقص من متوسط التقييم العام
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

      const tasks = [redis.hdel(`beans_comments:${beansId}`, commentId)];

      // نرجع ننقص من متوسط التقييم العام — بدون هذا، حذف تقييم ما يرجع يصحح الرقم الظاهر للناس
      if (commentData.rating) {
        tasks.push(bumpRating("beans", beansId, -commentData.rating));
        if (commentData.roasteryId) tasks.push(bumpRating("roastery", commentData.roasteryId, -commentData.rating));
      }

      // نفك القفل عن صاحب التعليق الأصلي — يقدر يقيّم من جديد بعد الحذف
      if (commentData.userId) tasks.push(redis.del(`user_rated:${commentData.userId}:${beansId}`));

      await Promise.all(tasks);
      return res.status(200).json({ ok: true });
    }

    // تسجيل تقييم جديد (+ تعليق اختياري) — يتطلب تسجيل دخول، ومرة وحدة بس لكل محصول
    const { beansId, roasteryId, rating, comment } = req.body || {};
    const stars = Number(rating);
    const commentText = (comment || "").toString().trim().slice(0, 500);

    if (!beansId || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: "بيانات تقييم غير صحيحة" });
    }

    const requester = await getRequester(req);
    if (!requester) {
      return res.status(401).json({ error: "لازم تسجّل دخول أول عشان تقيّم" });
    }

    const alreadyRated = await redis.get(`user_rated:${requester.userId}:${beansId}`);
    if (alreadyRated) {
      return res.status(409).json({ error: "قيّمت هذا المحصول من قبل — احذف تقييمك القديم لو تبي تغيّره" });
    }

    const commentId = crypto.randomUUID();
    const meta = await redis.hgetall(`beans_meta:${beansId}`);
    const commentRecord = {
      rating: stars,
      comment: commentText,
      userId: requester.userId,
      roasteryId: roasteryId || null,
      createdAt: new Date().toISOString()
    };

    const tasks = [
      bumpRating("beans", beansId, stars),
      roasteryId ? bumpRating("roastery", roasteryId, stars) : Promise.resolve(),
      redis.hset(`beans_comments:${beansId}`, { [commentId]: JSON.stringify(commentRecord) }),
      redis.set(`user_rated:${requester.userId}:${beansId}`, commentId)
    ];

    if (commentText) {
      tasks.push(redis.incr("comments:total"));
      tasks.push(
        redis.lpush("global_comments_feed", JSON.stringify({
          commentId,
          beansId,
          coffeeType: meta ? meta.coffeeType : "",
          roasteryName: meta ? meta.roasteryName : "",
          ...commentRecord
        }))
      );
      tasks.push(redis.ltrim("global_comments_feed", 0, GLOBAL_FEED_MAX - 1));
    }

    await Promise.all(tasks);

    return res.status(200).json({ ok: true, commentId });
  } catch (err) {
    console.error("Rate error:", err);
    return res.status(500).json({ ok: false, error: "فشل حفظ التقييم" });
  }
}
