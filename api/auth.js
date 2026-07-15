// Version: 09
// نظام الحسابات: تسجيل بإيميل + كلمة مرور، دخول، خروج، والتحقق من الجلسة الحالية.
// بدون أي خدمة إيميل خارجية وقت التسجيل — يدخل مباشرة بدون تأكيد.
// الجلسة تُدار عبر كوكي آمن (HttpOnly) يحمل رمز جلسة عشوائي، والرمز نفسه
// مخزّن بـ Upstash Redis مربوط بمعرّف المستخدم.
//
// نظام الأدوار: 3 مستويات — owner (كل الصلاحيات + الإحصائيات)، admin (يشوف
// الإحصائيات بس)، user (عادي). حقل role ما يُكتب أبدًا للحساب العادي (توفير
// كتابة بسيط) — غيابه يعني تلقائيًا "user". يُكتب صراحة بس لما يصير admin/owner.
// أول مالك يُفعّل عبر مفتاح سري (OWNER_BOOTSTRAP_SECRET) لمرة وحدة فقط، وبعدها
// المالك نفسه يقدر يرفّع حسابات ثانية بدون الحاجة للمفتاح مرة ثانية.
//
// نسيت كلمة المرور: أول استخدام فعلي لخدمة الإيميل (Resend) بالموقع. رابط
// الاسترجاع صالح لمدة ساعة بس، ومرة وحدة (يُحذف فور الاستخدام). ما نكشف للزائر
// هل الإيميل مسجّل عندنا أو لا (حماية من تخمين الحسابات الموجودة).

import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const RESET_TOKEN_SECONDS = 60 * 60; // ساعة وحدة بس

// حماية بسيطة من محاولات الدخول المتكررة (Brute force) — بالذاكرة المؤقتة
// للسيرفر، نفس أسلوب الحد بملف analyze.js
const attemptLog = new Map();
const MAX_ATTEMPTS_PER_HOUR = 10;
function isRateLimited(key) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const timestamps = (attemptLog.get(key) || []).filter(t => now - t < hour);
  timestamps.push(now);
  attemptLog.set(key, timestamps);
  return timestamps.length > MAX_ATTEMPTS_PER_HOUR;
}

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

// إرسال إيميل عبر Resend — يُستخدم هنا بس لرابط استرجاع كلمة المرور
async function sendResetEmail(toEmail, resetLink) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "مُهل <no-reply@mohl.coffee>",
      to: [toEmail],
      subject: "استرجاع كلمة المرور — مُهل",
      html: `
        <div dir="rtl" style="font-family: Georgia, serif; color: #2B1D14;">
          <h2>استرجاع كلمة المرور</h2>
          <p>وصلنا طلب لاسترجاع كلمة مرور حسابك بموقع مُهل. اضغط الرابط تحت لتعيين كلمة مرور جديدة:</p>
          <p><a href="${resetLink}" style="background:#C89B3C;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;">تعيين كلمة مرور جديدة</a></p>
          <p style="font-size:12px;color:#8a7862;">هذا الرابط صالح لمدة ساعة وحدة بس. لو ما طلبت هذا الاسترجاع، تجاهل الإيميل ببساطة.</p>
        </div>
      `
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error("Resend send error:", errText);
    throw new Error("فشل إرسال إيميل الاسترجاع");
  }
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

// عداد بسيط لعدد الحسابات (يومي + إجمالي دائم) — يفيد مستقبلاً بصفحة الإحصائيات
// بدون ما نحتاج نعدّ كل المفاتيح بأثر رجعي لاحقًا
async function bumpAccountsCounter() {
  const dayKey = new Date().toISOString().slice(0, 10);
  return Promise.all([
    redis.incr("accounts:total"),
    redis.incr(`accounts:day:${dayKey}`)
  ]);
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
        redis.hset(`user_by_email:${email}`, { userId }),
        bumpAccountsCounter()
      ]);

      await createSession(userId, res);
      return res.status(200).json({ ok: true, user: { userId, email, displayName } });
    }

    // تسجيل الدخول
    if (action === "login") {
      const email = normalizeEmail(req.body.email);
      const password = req.body.password || "";

      if (isRateLimited(`login:${email}`)) {
        return res.status(429).json({ error: "محاولات كثيرة جدًا، حاول بعد شوي" });
      }

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

    // طلب استرجاع كلمة المرور — يرسل إيميل فيه رابط صالح لساعة وحدة
    if (action === "request-password-reset") {
      const email = normalizeEmail(req.body.email);

      if (isRateLimited(`reset:${email}`)) {
        return res.status(429).json({ error: "محاولات كثيرة جدًا، حاول بعد شوي" });
      }

      // نرجع نفس الرسالة دائمًا (سواء الإيميل مسجّل أو لا) — عشان محد يقدر
      // يكتشف أي إيميلات مسجّلة عندنا بمجرد تجربتها هنا
      const genericMessage = "لو هذا البريد مسجّل عندنا، وصلته رسالة استرجاع الآن";

      if (!email || !isValidEmail(email)) {
        return res.status(200).json({ ok: true, message: genericMessage });
      }

      const lookup = await redis.hgetall(`user_by_email:${email}`);
      if (lookup && lookup.userId) {
        const token = makeToken();
        await redis.set(`password_reset:${token}`, lookup.userId, { ex: RESET_TOKEN_SECONDS });
        const resetLink = `https://mohl.coffee/?reset=${token}`;
        try {
          await sendResetEmail(email, resetLink);
        } catch (e) {
          console.error("Failed to send reset email:", e);
          // ما نفشل الطلب للزائر حتى لو فشل الإرسال فعليًا — نفس مبدأ عدم كشف المعلومة
        }
      }

      return res.status(200).json({ ok: true, message: genericMessage });
    }

    // تنفيذ استرجاع كلمة المرور — يستهلك الرابط لمرة وحدة بس
    if (action === "reset-password") {
      const { token, newPassword } = req.body;
      if (!token || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
      }

      const userId = await redis.get(`password_reset:${token}`);
      if (!userId) {
        return res.status(400).json({ error: "رابط الاسترجاع منتهي أو غير صحيح — اطلب رابط جديد" });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = hashPassword(newPassword, salt);

      await Promise.all([
        redis.hset(`user:${userId}`, { salt, passwordHash }),
        redis.del(`password_reset:${token}`)
      ]);

      return res.status(200).json({ ok: true });
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

    // حذف انتقائي: يمسح كل بيانات التجربة (إحصائيات، تقييمات، مفضلة) لكن
    // يحافظ على الحسابات والجلسات تمامًا. يشتغل بس لحساب Owner، ويحتاج
    // تأكيد صريح (confirm: true) عشان ما يصير بالغلط.
    if (action === "purge-data") {
      const requester = await getUserFromSession(req);
      if (!requester || requester.role !== "owner") {
        return res.status(403).json({ error: "ما عندك صلاحية لهذا الإجراء" });
      }
      if (req.body.confirm !== true) {
        return res.status(400).json({ error: "لازم تأكيد صريح (confirm: true) لتنفيذ هذا الإجراء" });
      }

      // بادئات محمية — أي مفتاح يبدأ بواحد منها ما ينحذف أبدًا
      const PROTECTED_PREFIXES = [
        "user:", "user_by_email:", "session:", "user_favorites:", "favorite:",
        "accounts:", "owner_bootstrap_used"
      ];

      const allKeys = await redis.keys("*");
      const keysToDelete = allKeys.filter(
        k => !PROTECTED_PREFIXES.some(prefix => k.startsWith(prefix))
      );

      if (keysToDelete.length > 0) {
        // نحذف على دفعات عشان ما نتجاوز حدود الطلب الواحد
        const batchSize = 100;
        for (let i = 0; i < keysToDelete.length; i += batchSize) {
          const batch = keysToDelete.slice(i, i + batchSize);
          await redis.del(...batch);
        }
      }

      return res.status(200).json({ ok: true, deletedCount: keysToDelete.length, keptCount: allKeys.length - keysToDelete.length });
    }

    return res.status(400).json({ error: "إجراء غير معروف" });
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "حدث خطأ بالسيرفر" });
  }
}
