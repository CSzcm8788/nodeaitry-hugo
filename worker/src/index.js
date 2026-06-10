const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.nodeaitry.com") {
      url.hostname = "nodeaitry.com";
      return Response.redirect(url.toString(), 301);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/health") {
        return json(request, env, { ok: true });
      }
      if (url.pathname === "/v1/comments" && request.method === "GET") {
        return listComments(request, env, url);
      }
      if (url.pathname === "/v1/comments" && request.method === "POST") {
        return createComment(request, env);
      }
      if (url.pathname === "/v1/stats" && request.method === "GET") {
        return commentStats(request, env, url);
      }
      if (url.pathname === "/v1/moderate" && request.method === "GET") {
        return moderateFromUrl(request, env, url);
      }
      if (url.pathname.startsWith("/v1/telegram") && request.method === "POST") {
        return telegramWebhook(request, env, url);
      }
      return json(request, env, { ok: false, error: { message: "Not found" } }, 404);
    } catch (error) {
      return json(request, env, { ok: false, error: { message: error.message || "Internal error" } }, error.status || 500);
    }
  }
};

async function listComments(request, env, url) {
  const pageKey = normalizePageKey(url.searchParams.get("pageKey"));
  if (!pageKey) throw httpError("Missing pageKey", 400);

  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 20)));
  const offset = (page - 1) * pageSize;
  const pageRow = await env.DB.prepare("SELECT id FROM pages WHERE page_key = ?").bind(pageKey).first();

  if (!pageRow) {
    return json(request, env, { ok: true, comments: [], pagination: { page, pageSize, total: 0, totalPages: 1 } });
  }

  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE page_id = ? AND status = 'approved'")
    .bind(pageRow.id)
    .first();
  const total = Number(totalRow?.count || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rows = await env.DB.prepare(
    `SELECT id, parent_id, root_id, depth, author_name, author_link, content, is_admin, source, avatar_url,
            ip_country, ip_country_code, ip_asn, ip_as_org, browser, os, created_at
       FROM comments
      WHERE page_id = ? AND status = 'approved'
      ORDER BY created_at ASC, id ASC
      LIMIT ? OFFSET ?`
  ).bind(pageRow.id, pageSize, offset).all();

  return json(request, env, {
    ok: true,
    comments: (rows.results || []).map(publicComment),
    pagination: { page, pageSize, total, totalPages }
  });
}

async function createComment(request, env) {
  const input = await readJson(request);
  const pageKey = normalizePageKey(input.pageKey);
  const pageUrl = normalizeUrl(input.pageUrl, env.SITE_URL);
  const pageTitle = normalizeText(input.pageTitle, 180) || "Untitled";
  const authorName = normalizeText(input.authorName, 80);
  const authorEmail = normalizeEmail(input.authorEmail);
  const authorLink = normalizeOptionalUrl(input.authorLink);
  const content = normalizeText(input.content, 4000);
  const parentId = Number(input.parentId || 0) || null;

  if (!pageKey) throw httpError("Missing pageKey", 400);
  if (!authorName) throw httpError("Name is required", 400);
  if (!content) throw httpError("Comment content is required", 400);
  if (reservedAdminEmail(authorEmail, env)) throw httpError("This email is reserved", 403);

  const now = timestamp();
  const page = await upsertPage(env, { pageKey, pageUrl, pageTitle, now });
  const parent = parentId ? await getParentComment(env, page.id, parentId) : null;
  const depth = parent ? Math.min(Number(parent.depth || 0) + 1, 4) : 0;
  const rootId = parent ? Number(parent.root_id || parent.id) : null;
  const status = String(env.AUTO_APPROVE || "false").toLowerCase() === "true" ? "approved" : "pending";
  const emailHash = authorEmail ? md5(authorEmail) : null;
  const avatarUrl = emailHash ? `https://www.gravatar.com/avatar/${emailHash}?s=160&d=mp&r=g` : "https://www.gravatar.com/avatar/?s=160&d=mp&r=g";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const userAgent = request.headers.get("user-agent") || "";
  const meta = await ipMetadata(request, ip);
  const ua = parseUserAgent(userAgent);

  const inserted = await env.DB.prepare(
    `INSERT INTO comments (
       page_id, parent_id, root_id, depth, author_name, author_email_hash, author_link, content, status,
       is_admin, source, avatar_url, ip, ip_country, ip_country_code, ip_asn, ip_as_org, browser, os,
       user_agent, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    page.id,
    parent ? parent.id : null,
    rootId,
    depth,
    authorName,
    emailHash,
    authorLink,
    content,
    status,
    avatarUrl,
    ip || null,
    meta.country || null,
    meta.countryCode || null,
    meta.asn || null,
    meta.asOrg || null,
    ua.browser,
    ua.os,
    userAgent || null,
    now,
    now
  ).run();

  const id = Number(inserted.meta?.last_row_id);
  if (!rootId && id) {
    await env.DB.prepare("UPDATE comments SET root_id = ? WHERE id = ?").bind(id, id).run();
  }

  await notifyTelegram(env, {
    id,
    page,
    parentId: parent ? parent.id : null,
    authorName,
    authorEmail,
    content,
    status,
    createdAt: now
  });

  return json(request, env, { ok: true, comment: { id, status } }, status === "approved" ? 201 : 202);
}

async function commentStats(request, env, url) {
  const pageKey = normalizePageKey(url.searchParams.get("pageKey"));
  if (pageKey) {
    const row = await env.DB.prepare(
      `SELECT COUNT(c.id) AS count
         FROM pages p
         LEFT JOIN comments c ON c.page_id = p.id AND c.status = 'approved'
        WHERE p.page_key = ?`
    ).bind(pageKey).first();
    return json(request, env, { ok: true, count: Number(row?.count || 0) });
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'approved'").first();
  return json(request, env, { ok: true, count: Number(row?.count || 0) });
}

async function moderateFromUrl(request, env, url) {
  const token = url.searchParams.get("token") || "";
  if (!env.MODERATION_TOKEN || token !== env.MODERATION_TOKEN) throw httpError("Forbidden", 403);
  const id = Number(url.searchParams.get("id"));
  const action = normalizeAction(url.searchParams.get("action"));
  if (!id || !action) throw httpError("Invalid moderation request", 400);
  await setCommentStatus(env, id, action);
  return new Response(`Comment ${id} marked as ${action}.`, {
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(request, env) }
  });
}

async function telegramWebhook(request, env, url) {
  const pathSecret = url.pathname.split("/").filter(Boolean)[2] || "";
  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (env.TELEGRAM_WEBHOOK_SECRET && pathSecret !== env.TELEGRAM_WEBHOOK_SECRET && headerSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    throw httpError("Forbidden", 403);
  }

  const update = await readJson(request);

  if (update.callback_query) {
    await handleTelegramCallback(env, update.callback_query);
    return json(request, env, { ok: true });
  }

  if (update.message) {
    await handleTelegramMessage(env, update.message);
    return json(request, env, { ok: true });
  }

  return json(request, env, { ok: true });
}

async function handleTelegramCallback(env, callback) {
  if (!isTelegramAdmin(env, callback.from?.id)) return;
  const [action, rawId] = String(callback.data || "").split(":");
  const id = Number(rawId);
  if (!id) return;

  if (action === "reply") {
    await telegramApi(env, "sendMessage", {
      chat_id: callback.message?.chat?.id || env.TELEGRAM_CHAT_ID,
      text: `Reply to comment #${id}`,
      reply_to_message_id: callback.message?.message_id,
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Write the admin reply..."
      }
    });
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Replying to comment ${id}`
    });
    return;
  }

  const status = normalizeAction(action);
  if (!status) return;
  await setCommentStatus(env, id, status);
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: `Comment ${id}: ${status}`
  });
}

async function handleTelegramMessage(env, message) {
  if (!isTelegramAdmin(env, message.from?.id)) return;
  const text = normalizeText(message.text || message.caption || "", 4000);
  if (!text || !message.reply_to_message?.message_id) return;

  let parent = await env.DB.prepare(
    `SELECT c.*, p.page_key, p.page_url, p.page_title
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.telegram_message_id = ?`
  ).bind(Number(message.reply_to_message.message_id)).first();

  if (!parent) {
    const prompt = String(message.reply_to_message.text || message.reply_to_message.caption || "");
    const commentId = Number(prompt.match(/Reply to comment #(\d+)/i)?.[1] || 0);
    if (commentId) {
      parent = await env.DB.prepare(
        `SELECT c.*, p.page_key, p.page_url, p.page_title
           FROM comments c
           JOIN pages p ON p.id = c.page_id
          WHERE c.id = ?`
      ).bind(commentId).first();
    }
  }

  if (!parent) return;

  const now = timestamp();
  const adminName = normalizeText(env.ADMIN_NAME, 80) || "Admin";
  const adminEmail = firstAdminEmail(env);
  const emailHash = adminEmail ? md5(adminEmail) : null;
  const avatarUrl = emailHash ? `https://www.gravatar.com/avatar/${emailHash}?s=160&d=mp&r=g` : "https://www.gravatar.com/avatar/?s=160&d=mp&r=g";

  const inserted = await env.DB.prepare(
    `INSERT INTO comments (
       page_id, parent_id, root_id, depth, author_name, author_email_hash, content, status,
       is_admin, source, avatar_url, telegram_message_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1, 'telegram', ?, ?, ?, ?)`
  ).bind(
    parent.page_id,
    parent.id,
    Number(parent.root_id || parent.id),
    Math.min(Number(parent.depth || 0) + 1, 4),
    adminName,
    emailHash,
    text,
    avatarUrl,
    Number(message.message_id),
    now,
    now
  ).run();

  if (parent.status !== "approved") {
    await setCommentStatus(env, parent.id, "approve");
  }

  await telegramApi(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: `Admin reply posted: #${inserted.meta?.last_row_id || ""}\n${parent.page_url}`,
    reply_to_message_id: message.message_id
  });
}

async function setCommentStatus(env, id, action) {
  const status = action === "delete" ? "deleted" : action === "spam" ? "spam" : "approved";
  const now = timestamp();
  await env.DB.prepare("UPDATE comments SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, id).run();
}

async function upsertPage(env, { pageKey, pageUrl, pageTitle, now }) {
  await env.DB.prepare(
    `INSERT INTO pages (page_key, page_url, page_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_key) DO UPDATE SET page_url = excluded.page_url, page_title = excluded.page_title, updated_at = excluded.updated_at`
  ).bind(pageKey, pageUrl, pageTitle, now, now).run();

  return env.DB.prepare("SELECT id, page_key, page_url, page_title FROM pages WHERE page_key = ?").bind(pageKey).first();
}

async function getParentComment(env, pageId, parentId) {
  const parent = await env.DB.prepare("SELECT id, page_id, root_id, depth, status FROM comments WHERE id = ? AND page_id = ?")
    .bind(parentId, pageId)
    .first();
  if (!parent || parent.status === "deleted" || parent.status === "spam") throw httpError("Parent comment not found", 404);
  return parent;
}

async function notifyTelegram(env, comment) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !comment.id) return;
  const keyboard = comment.status === "pending"
    ? [
        [button("Reply", `reply:${comment.id}`), button("Approve", `approve:${comment.id}`)],
        [button("Spam", `spam:${comment.id}`), button("Delete", `delete:${comment.id}`)]
      ]
    : [
        [button("Reply", `reply:${comment.id}`)],
        [button("Spam", `spam:${comment.id}`), button("Delete", `delete:${comment.id}`)]
      ];
  const text = [
    `New ${comment.status} comment #${comment.id}`,
    `Page: ${comment.page.page_title}`,
    `URL: ${comment.page.page_url}`,
    `Author: ${comment.authorName}${comment.authorEmail ? ` <${comment.authorEmail}>` : ""}`,
    comment.parentId ? `Reply to: #${comment.parentId}` : "",
    "",
    comment.content,
    "",
    "Use Reply below, or reply directly to this Telegram message."
  ].filter(Boolean).join("\n");

  const result = await telegramApi(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });

  const messageId = result?.result?.message_id;
  if (messageId) {
    await env.DB.prepare("UPDATE comments SET telegram_message_id = ? WHERE id = ?").bind(messageId, comment.id).run();
  }
}

function button(text, callback_data) {
  return { text, callback_data };
}

async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function ipMetadata(request, ip) {
  const cf = request.cf || {};
  const countryCode = String(cf.country || "").trim().toUpperCase();
  const native = {
    country: countryName(countryCode),
    countryCode,
    asn: normalizeAsn(cf.asn),
    asOrg: String(cf.asOrganization || "").trim()
  };

  if (!ip || Object.values(native).every(Boolean)) return native;

  try {
    const response = await fetch(`https://api.ipinfo.es/ipinfo?ip=${encodeURIComponent(ip)}`, {
      headers: { "accept": "application/json" }
    });
    if (!response.ok) return native;
    const data = await response.json();
    return {
      country: native.country || data.country_name || data.country || data.countryName || "",
      countryCode: native.countryCode || String(data.country_code || data.countryCode || "").toUpperCase(),
      asn: native.asn || normalizeAsn(data.asn || data.as),
      asOrg: native.asOrg || data.org || data.as_name || data.asn_org || data.isp || ""
    };
  } catch {
    return native;
  }
}

function countryName(countryCode) {
  if (!countryCode) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

function normalizeAsn(value) {
  const asn = String(value || "").trim();
  if (!asn) return "";
  return /^AS/i.test(asn) ? `AS${asn.slice(2)}` : `AS${asn}`;
}

function publicComment(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    rootId: row.root_id,
    depth: row.depth,
    authorName: row.author_name,
    authorLink: row.author_link,
    content: row.content,
    isAdmin: Boolean(row.is_admin),
    source: row.source,
    avatarUrl: row.avatar_url,
    ipCountry: row.ip_country,
    ipCountryCode: row.ip_country_code,
    ipAsn: row.ip_asn,
    ipAsOrg: row.ip_as_org,
    browser: row.browser,
    os: row.os,
    createdAt: row.created_at
  };
}

function parseUserAgent(ua) {
  const input = String(ua || "");
  const browser = input.includes("Edg/") ? "Edge"
    : input.includes("Chrome/") ? "Chrome"
    : input.includes("Safari/") && input.includes("Version/") ? "Safari"
    : input.includes("Firefox/") ? "Firefox"
    : input.includes("Mobile") ? "Mobile Browser"
    : "";
  const os = input.includes("Windows") ? "Windows"
    : input.includes("Mac OS X") ? "macOS"
    : input.includes("iPhone") || input.includes("iPad") ? "iOS"
    : input.includes("Android") ? "Android"
    : input.includes("Linux") ? "Linux"
    : "";
  return { browser, os };
}

function isTelegramAdmin(env, id) {
  const ids = String(env.TELEGRAM_ADMIN_IDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0 && ids.includes(String(id || ""));
}

function firstAdminEmail(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).find(Boolean) || "";
}

function reservedAdminEmail(email, env) {
  if (!email) return false;
  return String(env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).includes(email);
}

function normalizeAction(action) {
  const value = String(action || "").toLowerCase();
  return ["approve", "spam", "delete"].includes(value) ? value : "";
}

function normalizePageKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 300) return "";
  return key.startsWith("/") ? key : `/${key}`;
}

function normalizeText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 160);
}

function normalizeUrl(value, fallback) {
  return normalizeOptionalUrl(value) || fallback || "";
}

function normalizeOptionalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError("Invalid JSON", 400);
  }
}

function json(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || env.SITE_URL || "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ? origin
    : (allowed[0] || "*");
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-telegram-bot-api-secret-token",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function timestamp() {
  return new Date().toISOString().replace("Z", "+00:00");
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function md5(input) {
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function cmn(q, a, b, x, s, t) { return add32((add32(add32(a, q), add32(x, t)) << s) | (add32(add32(a, q), add32(x, t)) >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function md5blk(s) {
    const blocks = [];
    for (let i = 0; i < 64; i += 4) blocks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return blocks;
  }
  function md51(s) {
    const txt = unescape(encodeURIComponent(s));
    const n = txt.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(txt.substring(i - 64, i)));
    const tail = Array(16).fill(0);
    const rest = txt.substring(i - 64);
    for (i = 0; i < rest.length; i++) tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      tail.fill(0);
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) {
    const hex = "0123456789abcdef";
    let s = "";
    for (let j = 0; j < 4; j++) s += hex[(n >> (j * 8 + 4)) & 0x0f] + hex[(n >> (j * 8)) & 0x0f];
    return s;
  }
  return md51(input).map(rhex).join("");
}
