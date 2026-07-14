// Version: 02
// يجمع كل بيانات صفحة الإحصائيات بطلب واحد بدل عدة طلبات متفرقة.
// القسم العام يرجع لأي زائر. القسم الخاص (accounts, total searches, آخر
// التعليقات) يرجع بس لو الطالب owner أو admin.

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

async function getRequester(req) {
  const token = getCookie(req, "mohal_session");
  if (!token) return null;
  const userId = await redis.get(`session:${token}`);
  if (!userId) return null;
  const user = await redis.hgetall(`user:${userId}`);
  if (!user || !user.email) return null;
  return { userId, email: user.email, role: user.role || "user" };
}

// يرجع أعلى N عنصر من هاش عدادات (اسم -> رقم)، مرتبة تنازليًا
function topN(hash, n = 5) {
  if (!hash) return [];
  return Object.entries(hash)
    .map(([key, count]) => ({ key, count: Number(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// يجمع عدة مفاتيح يومية (لآخر X يوم) بنفس البُعد بهاش واحد مجموع
async function sumDailyHashes(dimension, days) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(`${dimension}:day:${d.toISOString().slice(0, 10)}`);
  }
  const hashes = await Promise.all(keys.map(k => redis.hgetall(k)));
  const merged = {};
  hashes.forEach(h => {
    if (!h) return;
    Object.entries(h).forEach(([k, v]) => {
      merged[k] = (merged[k] || 0) + Number(v);
    });
  });
  return merged;
}

function topRated(sumHash, countHash, n = 5) {
  if (!sumHash || !countHash) return [];
  return Object.entries(sumHash)
    .map(([key, sum]) => {
      const count = Number(countHash[key] || 0);
      return count > 0 ? { key, average: Number(sum) / count, count } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.average - a.average || b.count - a.count)
    .slice(0, n);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "الطريقة غير مسموحة" });
  }

  try {
    const requester = await getRequester(req);
    const isPrivileged = requester && (requester.role === "owner" || requester.role === "admin");

    const [
      beansAll, roasteryAll, originAll, processAll, tempAll,
      grinderBrandAll, grinderModelAll,
      beansRatingSumAll, beansRatingCountAll, roasteryRatingSumAll, roasteryRatingCountAll,
      beansThisMonth
    ] = await Promise.all([
      redis.hgetall("beans:all"),
      redis.hgetall("roastery:all"),
      redis.hgetall("origin:all"),
      redis.hgetall("process:all"),
      redis.hgetall("temp:all"),
      redis.hgetall("grinder_brand:all"),
      redis.hgetall("grinder_model:all"),
      redis.hgetall("beans_rating_sum:all"),
      redis.hgetall("beans_rating_count:all"),
      redis.hgetall("roastery_rating_sum:all"),
      redis.hgetall("roastery_rating_count:all"),
      sumDailyHashes("beans", 30)
    ]);

    const publicStats = {
      topBeansThisMonth: topN(beansThisMonth, 10),
      topBeansAllTime: topN(beansAll, 10),
      topRoastery: topN(roasteryAll, 10),
      topOrigin: topN(originAll, 10),
      topProcess: topN(processAll, 10),
      topGrinderBrand: topN(grinderBrandAll, 10),
      topGrinderModel: topN(grinderModelAll, 10),
      tempSplit: topN(tempAll, 2),
      topRatedBeans: topRated(beansRatingSumAll, beansRatingCountAll, 10),
      topRatedRoastery: topRated(roasteryRatingSumAll, roasteryRatingCountAll, 10)
    };

    let privateStats = null;
    if (isPrivileged) {
      const [accountsTotal, beansMetaKeysCount, commentsTotal, cupCountAll] = await Promise.all([
        redis.get("accounts:total"),
        Promise.resolve(Object.keys(beansAll || {}).length), // عدد المحاصيل الفريدة
        redis.get("comments:total"),
        redis.hgetall("cupcount:all")
      ]);

      const totalSearches = Object.values(beansAll || {}).reduce((sum, v) => sum + Number(v), 0);

      privateStats = {
        accountsTotal: accountsTotal || 0,
        totalSearches,
        uniqueBeansCount: beansMetaKeysCount,
        commentsTotal: commentsTotal || 0,
        cupCountSplit: topN(cupCountAll, 3)
      };
    }

    return res.status(200).json({ public: publicStats, private: privateStats, isPrivileged });
  } catch (err) {
    console.error("Stats error:", err);
    return res.status(500).json({ error: "فشل جلب الإحصائيات" });
  }
}
