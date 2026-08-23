import express from "express";
import fs from "node:fs/promises";
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
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const protocol = req.get("x-forwarded-proto")?.split(",")[0] || req.protocol || "https";
  const origin = `${protocol}://${host}`;
  const pageUrl = `${origin}${req.path === "/ajudeotadeu" ? "/ajudeotadeu" : "/"}`;
  const imageUrl = `${origin}/assets/social-share-tadeu.png`;

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

await initDatabase();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tadeuzinho no ar na porta ${PORT}`);
});
