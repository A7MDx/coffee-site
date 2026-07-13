// Version: 01
// حفظ الوصفة الكاملة (مو بس إحصائيات) تحت حساب العميل — يخلي النتيجة تُعرض
// له لاحقًا بالضبط زي ما ظهرت أول مرة، بدون إعادة استدعاء الذكاء الاصطناعي.
// الحذف بيد العميل بالكامل، ما فيه انتهاء صلاحية تلقائي.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const match = raw.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split("=")[1] : null;
}

async function requireUser(req) {
  const token = getCookie(req, "mohal_session");
  if (!token) return null;
  const userId = await redis.get(`session:${token}`);
  return userId || null;
}

export default async function handler(req, res) {
  const userId = await requireUser(req);
  if (!userId) {
    return res.status(401).json({ error: "لازم تسجّل دخول أول" });
  }

  try {
    // عرض كل المحاصيل المحفوظة بحساب العميل
    if (req.method === "GET") {
      const ids = await redis.smembers(`user_favorites:${userId}`);
      const items = await Promise.all(
        ids.map(async (beansId) => {
          const data = await redis.hget(`favorite:${userId}:${beansId}`, "recipe");
          return data ? { beansId, recipe: data } : null;
        })
      );
      return res.status(200).json({ favorites: items.filter(Boolean) });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "الطريقة غير مسموحة" });
    }

    const { action, beansId, recipe } = req.body || {};

    // إضافة للمفضلة — نخزّن الوصفة كاملة كما ظهرت بالضبط
    if (action === "add") {
      if (!beansId || !recipe) {
        return res.status(400).json({ error: "بيانات ناقصة" });
      }
      await Promise.all([
        redis.sadd(`user_favorites:${userId}`, beansId),
        redis.hset(`favorite:${userId}:${beansId}`, { recipe: JSON.stringify(recipe), savedAt: new Date().toISOString() })
      ]);
      return res.status(200).json({ ok: true });
    }

    // حذف من المفضلة — قرار العميل بالكامل
    if (action === "remove") {
      if (!beansId) return res.status(400).json({ error: "بيانات ناقصة" });
      await Promise.all([
        redis.srem(`user_favorites:${userId}`, beansId),
        redis.del(`favorite:${userId}:${beansId}`)
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "إجراء غير معروف" });
  } catch (err) {
    console.error("Favorites error:", err);
    return res.status(500).json({ error: "حدث خطأ بالسيرفر" });
  }
}
