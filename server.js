import express from "express";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

const PORT = process.env.PORT || 3000;
const GOAL_CENTS = Number(process.env.GOAL_AMOUNT_CENTS || 600000);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL não configurada. Adicione um PostgreSQL ao projeto no Railway.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return res.status(503).send("Área administrativa ainda não configurada.");
  }

  const auth = req.get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Tadeuzinho Admin", charset="UTF-8"');
    return res.status(401).send("Autenticação necessária.");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    decoded = "";
  }

  const separator = decoded.indexOf(":");
  const user = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (!safeEqual(user, expectedUser) || !safeEqual(password, expectedPassword)) {
    res.set("WWW-Authenticate", 'Basic realm="Tadeuzinho Admin", charset="UTF-8"');
    return res.status(401).send("Usuário ou senha inválidos.");
  }

  next();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBRLFromCents(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function isLikelyBot(req) {
  const ua = req.get("user-agent") || "";
  return /bot|crawler|spider|facebookexternalhit|WhatsApp|TelegramBot|Twitterbot|LinkedInBot|Slackbot|Discordbot/i.test(ua);
}

async function registerPageView(req) {
  if (isLikelyBot(req)) return;
  try {
    await pool.query(
      `INSERT INTO tadeu_page_views (path, created_at) VALUES ($1, NOW())`,
      [req.path]
    );
  } catch (error) {
    console.error("page_view_error", error);
  }
}

app.use(express.json({ limit: "20kb" }));
app.set("trust proxy", 1);

app.use(express.static(process.cwd(), {
  extensions: ["html"],
  index: false,
}));

const indexTemplate = await fs.readFile(
  new URL("./index.html", import.meta.url),
  "utf8"
);

function renderIndex(req, res) {
  void registerPageView(req);
  res.set("Cache-Control", "no-cache");
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const protocol = req.get("x-forwarded-proto")?.split(",")[0] || req.protocol || "https";
  const origin = `${protocol}://${host}`;
  const pageUrl = `${origin}${req.path === "/ajudeotadeu" ? "/ajudeotadeu" : "/"}`;
  const imageUrl = `${origin}/assets/social-share-tadeu-final.png`;

  const page = indexTemplate
    .replaceAll("__PAGE_URL__", pageUrl)
    .replaceAll("__OG_IMAGE_URL__", imageUrl);

  res.type("html").send(page);
}

app.get("/", renderIndex);
app.get("/ajudeotadeu", renderIndex);
app.get("/ajudeotadeu/", (_req, res) => res.redirect(301, "/ajudeotadeu"));

function centsToReais(cents) {
  return Number(cents || 0) / 100;
}

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254) return null;
  const basicEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return basicEmail.test(email) ? email : null;
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tadeu_donations (
      id BIGSERIAL PRIMARY KEY,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      email TEXT,
      submission_token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tadeu_donations_created_at
    ON tadeu_donations(created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tadeu_page_views (
      id BIGSERIAL PRIMARY KEY,
      path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tadeu_page_views_created_at
    ON tadeu_page_views(created_at DESC);
  `);
}

async function getStatus(client = pool) {
  const result = await client.query(`
    SELECT
      COALESCE(SUM(amount_cents), 0)::bigint AS total_cents,
      COUNT(*)::int AS contributions
    FROM tadeu_donations
  `);

  const totalCents = Number(result.rows[0].total_cents || 0);
  return {
    arrecadado: centsToReais(totalCents),
    meta: centsToReais(GOAL_CENTS),
    faltam: centsToReais(Math.max(GOAL_CENTS - totalCents, 0)),
    contribuicoes: Number(result.rows[0].contributions || 0),
    metaAtingida: totalCents >= GOAL_CENTS,
  };
}

app.get("/api/fundraising-status", async (_req, res) => {
  try {
    res.json(await getStatus());
  } catch (error) {
    console.error("status_error", error);
    res.status(500).json({ error: "Não foi possível carregar a arrecadação." });
  }
});

app.post("/api/donations", async (req, res) => {
  return res.status(410).json({
    code: "CAMPAIGN_CLOSED",
    error: "A arrecadação foi encerrada e não são necessárias novas contribuições."
  });

  // Código abaixo mantido apenas como histórico da implementação original.
  const amount = Number(req.body?.amount);
  const website = String(req.body?.website || "").trim();
  const submissionToken = String(req.body?.submissionToken || "").trim();
  const rawEmail = req.body?.email ? String(req.body.email).trim() : "";
  const email = normalizeEmail(rawEmail);

  // Honeypot: silently accept bot-like submissions without changing the total.
  if (website) {
    return res.json({ ok: true, status: await getStatus() });
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: "Informe um valor de contribuição válido." });
  }

  if (rawEmail && !email) {
    return res.status(400).json({ error: "O e-mail informado não é válido." });
  }

  if (!submissionToken || submissionToken.length > 120) {
    return res.status(400).json({ error: "Não foi possível identificar este envio. Atualize a página e tente novamente." });
  }

  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0) {
    return res.status(400).json({ error: "Informe um valor de contribuição válido." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serializes goal checks so the page stops accepting new declarations as soon as the goal is reached.
    await client.query("SELECT pg_advisory_xact_lock(8260823)");

    const duplicate = await client.query(
      "SELECT id FROM tadeu_donations WHERE submission_token = $1 LIMIT 1",
      [submissionToken]
    );

    if (duplicate.rowCount) {
      const status = await getStatus(client);
      await client.query("COMMIT");
      return res.json({ ok: true, duplicate: true, status });
    }

    const before = await getStatus(client);
    if (before.metaAtingida) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        code: "GOAL_REACHED",
        error: "A meta já foi alcançada e não são necessárias novas contribuições.",
        status: before,
      });
    }

    await client.query(
      `INSERT INTO tadeu_donations (amount_cents, email, submission_token)
       VALUES ($1, $2, $3)`,
      [amountCents, email, submissionToken]
    );

    const status = await getStatus(client);
    await client.query("COMMIT");

    return res.status(201).json({ ok: true, status });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("donation_error", error);
    return res.status(500).json({ error: "Não foi possível registrar a contribuição agora." });
  } finally {
    client.release();
  }
});


app.get("/admin", requireAdmin, async (_req, res) => {
  try {
    const [views, donations, emails, recent] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_views,
          COUNT(*) FILTER (
            WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
              AT TIME ZONE 'America/Sao_Paulo'
          )::int AS today_views
        FROM tadeu_page_views
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS contributions,
          COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM tadeu_donations
      `),
      pool.query(`
        SELECT DISTINCT LOWER(email) AS email
        FROM tadeu_donations
        WHERE email IS NOT NULL AND TRIM(email) <> ''
        ORDER BY LOWER(email)
      `),
      pool.query(`
        SELECT amount_cents, email, created_at
        FROM tadeu_donations
        ORDER BY created_at DESC
        LIMIT 20
      `),
    ]);

    const totalViews = Number(views.rows[0]?.total_views || 0);
    const todayViews = Number(views.rows[0]?.today_views || 0);
    const contributions = Number(donations.rows[0]?.contributions || 0);
    const totalCents = Number(donations.rows[0]?.total_cents || 0);
    const emailList = emails.rows.map(row => row.email).filter(Boolean);

    const emailText = emailList.join("; ");

    const recentRows = recent.rows.map(row => `
      <tr>
        <td>${new Date(row.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
        <td>${formatBRLFromCents(row.amount_cents)}</td>
        <td>${escapeHtml(row.email || "—")}</td>
      </tr>
    `).join("");

    res.set("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tadeuzinho — Administração</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f6f1e8;color:#2d2823;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:min(1040px,calc(100% - 32px));margin:40px auto 70px}
  h1{font-size:clamp(2rem,5vw,3.5rem);margin:0 0 8px}
  .sub{color:#746b61;margin-bottom:28px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .card,.panel{background:white;border:1px solid #e5dbcc;border-radius:20px;padding:22px}
  .value{font-size:2rem;font-weight:900;letter-spacing:-.04em}
  .label{font-size:.85rem;color:#746b61;margin-top:4px}
  .panel{margin-top:18px}
  h2{margin:0 0 14px;font-size:1.35rem}
  textarea{width:100%;min-height:110px;border:1px solid #ddd0bf;border-radius:14px;padding:12px;font:inherit;resize:vertical}
  button{margin-top:10px;min-height:44px;border:0;border-radius:999px;padding:0 18px;background:#f4b942;color:#2c2116;font-weight:800;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:.92rem}
  th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #eee6dc}
  th{color:#746b61;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  .note{font-size:.85rem;color:#746b61;margin-top:10px}
  @media(max-width:760px){.cards{grid-template-columns:1fr 1fr}.panel{overflow:auto}}
  @media(max-width:460px){.cards{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
  <h1>Painel do Tadeuzinho 🐾</h1>
  <div class="sub">Esta página é privada e protegida pela senha configurada no Railway.</div>

  <div class="cards">
    <div class="card"><div class="value">${totalViews}</div><div class="label">acessos registrados</div></div>
    <div class="card"><div class="value">${todayViews}</div><div class="label">acessos hoje</div></div>
    <div class="card"><div class="value">${contributions}</div><div class="label">contribuições informadas</div></div>
    <div class="card"><div class="value">${formatBRLFromCents(totalCents)}</div><div class="label">arrecadado informado</div></div>
  </div>

  <section class="panel">
    <h2>E-mails cadastrados (${emailList.length})</h2>
    <textarea id="emails" readonly>${escapeHtml(emailText)}</textarea>
    <button type="button" onclick="copyEmails()">Copiar todos os e-mails</button>
    <div id="copyStatus" class="note"></div>
  </section>

  <section class="panel">
    <h2>Últimas contribuições informadas</h2>
    <table>
      <thead><tr><th>Data</th><th>Valor</th><th>E-mail</th></tr></thead>
      <tbody>${recentRows || '<tr><td colspan="3">Nenhuma contribuição registrada.</td></tr>'}</tbody>
    </table>
  </section>

  <p class="note">O número de acessos conta carregamentos da página. Robôs e crawlers conhecidos são ignorados, mas uma mesma pessoa pode contar mais de uma vez se abrir ou atualizar a página novamente.</p>
</main>
<script>
async function copyEmails(){
  const el=document.getElementById("emails");
  const status=document.getElementById("copyStatus");
  try{
    await navigator.clipboard.writeText(el.value);
    status.textContent="E-mails copiados.";
  }catch{
    el.select();
    document.execCommand("copy");
    status.textContent="E-mails copiados.";
  }
}
</script>
</body>
</html>`);
  } catch (error) {
    console.error("admin_error", error);
    res.status(500).send("Não foi possível carregar o painel administrativo.");
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

await initDatabase();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tadeuzinho no ar na porta ${PORT}`);
});
