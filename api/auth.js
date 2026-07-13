// Version: 05
// نظام الحسابات: تسجيل بإيميل + كلمة مرور، دخول، خروج، والتحقق من الجلسة الحالية.
// بدون أي خدمة إيميل خارجية — يدخل مباشرة بعد التسجيل بدون تأكيد.
// الجلسة تُدار عبر كوكي آمن (HttpOnly) يحمل رمز جلسة عشوائي، والرمز نفسه
// مخزّن بـ Upstash Redis مربوط بمعرّف المستخدم.
//
// نظام الأدوار: 3 مستويات — owner (كل الصلاحيات + الإحصائيات)، admin (يشوف
// الإحصائيات بس)، user (عادي). حقل role ما يُكتب أبدًا للحساب العادي (توفير
// كتابة بسيط) — غيابه يعني تلقائيًا "user". يُكتب صراحة بس لما يصير admin/owner.
// أول مالك يُفعّل عبر مفتاح سري (OWNER_BOOTSTRAP_SECRET) لمرة وحدة فقط، وبعدها
// المالك نفسه يقدر يرفّع حسابات ثانية بدون الحاجة للمفتاح مرة ثانية.

import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

function isValidEmail(email) {
  // تحقق واقعي من صيغة الإيميل: اسم@نطاق.امتداد — يرفض أي كلام عشوائي
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return pattern.test(email);
}

function normalizeEmail(email) {
  return (email || "").toString().trim().toLowerCase();
}

// تشفير كلمة المرور بدون مكتبات خارجية — PBKDF2 المدمجة بـ Node.js
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  const actualHash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `mohal_session=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `mohal_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const match = raw.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split("=")[1] : null;
}

async function createSession(userId, res) {
  const token = makeToken();
  await redis.set(`session:${token}`, userId, { ex: SESSION_SECONDS });
  setSessionCookie(res, token);
  return token;
}

async function getUserFromSession(req) {
  const token = getCookie(req, "mohal_session");
  if (!token) return null;
  const userId = await redis.get(`session:${token}`);
  if (!userId) return null;
  const user = await redis.hgetall(`user:${userId}`);
  if (!user || !user.email) return null;
  // غياب حقل role يعني "مستخدم عادي" — ما نكتبه أبدًا إلا لو admin أو owner
  return { userId, email: user.email, displayName: user.displayName || "", role: user.role || "user" };
}

export default async function handler(req, res) {
  const action = req.query.action || (req.body && req.body.action);

  try {
    // التحقق من حالة الدخول الحالية (يستخدمه الموقع باستمرار ليعرف هل العميل مسجّل)
    if (req.method === "GET" && action === "me") {
      const user = await getUserFromSession(req);
      return res.status(200).json({ loggedIn: !!user, user });
    }

    // إجراء تشخيصي مؤقت — يوضح هل المتغير السري وصل للسيرفر وهل استُخدم من قبل،
    // بدون كشف قيمته الحقيقية إطلاقًا. احذف هذا الجزء بعد ما تحل المشكلة.
    if (req.method === "GET" && action === "debug-secret") {
      const bootstrapUsed = await redis.get("owner_bootstrap_used");
      const candidate = req.query.candidate || null;
      return res.status(200).json({
        secretIsSet: !!process.env.OWNER_BOOTSTRAP_SECRET,
        secretLength: process.env.OWNER_BOOTSTRAP_SECRET ? process.env.OWNER_BOOTSTRAP_SECRET.length : 0,
        bootstrapAlreadyUsed: !!bootstrapUsed,
        candidateMatches: candidate ? candidate === process.env.OWNER_BOOTSTRAP_SECRET : null
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "الطريقة غير مسموحة" });
    }

    // إنشاء حساب جديد
    if (action === "signup") {
      const email = normalizeEmail(req.body.email);
      const password = req.body.password || "";
      const displayName = (req.body.displayName || "").toString().trim();

      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: "بريد إلكتروني غير صحيح" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
      }

      const existing = await redis.hgetall(`user_by_email:${email}`);
      if (existing && existing.userId) {
        return res.status(409).json({ error: "هذا البريد مسجّل مسبقًا، جرّب تسجيل الدخول" });
      }

      const userId = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = hashPassword(password, salt);

      await Promise.all([
        redis.hset(`user:${userId}`, { email, displayName, salt, passwordHash, createdAt: new Date().toISOString() }),
        redis.hset(`user_by_email:${email}`, { userId })
      ]);

      await createSession(userId, res);
      return res.status(200).json({ ok: true, user: { userId, email, displayName } });
    }

    // تسجيل الدخول
    if (action === "login") {
      const email = normalizeEmail(req.body.email);
      const password = req.body.password || "";

      const lookup = await redis.hgetall(`user_by_email:${email}`);
      if (!lookup || !lookup.userId) {
        return res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة" });
      }

      const user = await redis.hgetall(`user:${lookup.userId}`);
      if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
        return res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة" });
      }

      await createSession(lookup.userId, res);
      return res.status(200).json({ ok: true, user: { userId: lookup.userId, email: user.email, displayName: user.displayName || "", role: user.role || "user" } });
    }

    // تسجيل الخروج
    if (action === "logout") {
      const token = getCookie(req, "mohal_session");
      if (token) await redis.del(`session:${token}`);
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // ترفيع حساب لدور admin أو owner — يشتغل بطريقتين:
    // 1) مرة أولى فقط: عبر المفتاح السري (OWNER_BOOTSTRAP_SECRET) لتفعيل أول مالك.
    // 2) لاحقًا: المالك نفسه (وهو مسجّل دخول) يقدر يرفّع أي حساب بدون حاجة للمفتاح.
    if (action === "promote") {
      const { targetEmail, newRole, secret } = req.body;
      if (!["admin", "owner"].includes(newRole)) {
        return res.status(400).json({ error: "دور غير صحيح" });
      }

      const bootstrapUsed = await redis.get("owner_bootstrap_used");
      const usedSecret = !bootstrapUsed && secret && process.env.OWNER_BOOTSTRAP_SECRET && secret === process.env.OWNER_BOOTSTRAP_SECRET;
      let authorized = usedSecret;

      if (!authorized) {
        const requester = await getUserFromSession(req);
        authorized = requester && requester.role === "owner";
      }

      if (!authorized) {
        return res.status(403).json({ error: "ما عندك صلاحية لهذا الإجراء" });
      }

      const email = normalizeEmail(targetEmail);
      const lookup = await redis.hgetall(`user_by_email:${email}`);
      if (!lookup || !lookup.userId) {
        return res.status(404).json({ error: "ما فيه حساب بهذا الإيميل" });
      }

      await redis.hset(`user:${lookup.userId}`, { role: newRole });

      // لو كان استخدام المفتاح السري، نقفله تلقائيًا بعد أول استخدام (أمان إضافي)
      if (usedSecret) {
        await redis.set("owner_bootstrap_used", "true");
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "إجراء غير معروف" });
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "حدث خطأ بالسيرفر" });
  }
}
