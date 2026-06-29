// ═══════════════════════════════════════════════════════════════
// server.js — API REST para Report de Autocontroles
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const sql = require('mssql');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const config = require('./config');

const JWT_SECRET = process.env.JWT_SECRET || 'change-in-production';
const PORT = process.env.PORT || 3101;
const REPORT_SLUG = 'autocontroles';
const REPORT_HTML = 'autocontroles_hub_v2.0.html';
const REPORT_NAME = 'Autocontroles — Hub de análisis';

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ── Middleware: extraer y validar token del portal ───────────────
const extractToken = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.query.token ||
                req.query.appToken ||
                req.body?.token ||
                req.cookies?.reportToken;

  req.user = null;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.app && decoded.app !== REPORT_SLUG) {
      console.warn(`[Auth] Token for app '${decoded.app}' rejected`);
    } else {
      req.user = decoded;
      console.log('[JWT Valid] user:', decoded.email);
    }
  } catch (err) {
    console.warn('[Token invalid]', err.message);
  }
  next();
};

const requireAuth = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    if (!req.user) req.user = { email: 'dev@localhost', role: 'dev' };
    return next();
  }
  if (!req.user) return res.status(401).json({ error: 'Autenticación requerida' });
  next();
};

app.use(extractToken);

// ── Servir assets estáticos ──────────────────────────────────────
const ROOT = __dirname;
app.use('/img',    express.static(path.join(ROOT, 'img')));
app.use('/vendor', express.static(path.join(ROOT, 'vendor')));
app.get('/corporate-style.css', (req, res) => res.sendFile(path.join(ROOT, '/corporate-style.css')));
app.get('/autocontroles.css', (req, res) => res.sendFile(path.join(ROOT, 'autocontroles.css')));

// ── Servir HTML del report en la raíz ───────────────────────────
app.get('/', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token || req.query.appToken;
  if (token) {
    res.cookie('reportToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000
    });
  }
  res.sendFile(path.join(ROOT, REPORT_HTML));
});

// ── Pool de conexión global ──────────────────────────────────────
let pool = null;

async function getPool() {
  if (!pool) {
    console.log(`Conectando a ${config.sql.server}/${config.sql.database}...`);
    pool = await sql.connect(config.sql);
    console.log('✓ Conexión SQL Server establecida');
  }
  return pool;
}

// ── ENDPOINT: Test de conexión ───────────────────────────────────
app.get('/api/test', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query('SELECT 1 AS ok');
    res.json({ status: 'ok', message: 'Conexión SQL Server activa', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Helper para parsear decimales
function parseDecimal(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === ' ') return null;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ── ENDPOINT: Valores distintos para filtros previos ──────────────
app.get('/api/autocontroles/filtros-load', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;
    const [rCentros, rAnos] = await Promise.all([
      p.request().query(`SELECT DISTINCT CENTRO FROM ${tabla} WHERE CENTRO IS NOT NULL AND CENTRO <> '' ORDER BY CENTRO`),
      p.request().query(`SELECT DISTINCT LEFT(FECHA,4) AS ANO FROM ${tabla} WHERE FECHA IS NOT NULL AND LEN(FECHA) >= 4 ORDER BY ANO DESC`)
    ]);
    res.json({
      status: 'ok',
      centros: rCentros.recordset.map(x => x.CENTRO),
      anos:    rAnos.recordset.map(x => x.ANO)
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── ENDPOINT: Datos de autocontroles ─────────────────────────────
// GET /api/autocontroles?centro=1120,2020&desde=20260101&hasta=20260331&limit=50000
app.get('/api/autocontroles', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;
    const { centro, desde, hasta, limit } = req.query;

    let where = [];
    const request = p.request();

    if (centro) {
      const centros = centro.split(',').map(c => c.trim());
      centros.forEach((c, i) => {
        request.input('c' + i, sql.NVarChar, c);
      });
      where.push(`CENTRO IN (${centros.map((_, i) => '@c' + i).join(',')})`);
    }
    if (desde) {
      request.input('desde', sql.NVarChar, desde);
      where.push('FECHA >= @desde');
    }
    if (hasta) {
      request.input('hasta', sql.NVarChar, hasta);
      where.push('FECHA <= @hasta');
    }

    const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const limitClause = limit ? `TOP ${parseInt(limit)}` : '';

    const query = `SELECT ${limitClause} * FROM ${tabla}${whereClause} ORDER BY FECHA DESC`;
    console.log(`[${new Date().toISOString().slice(11,19)}] Query: ${query.slice(0, 120)}...`);

    const t0 = Date.now();
    const data = await request.query(query);
    const ms = Date.now() - t0;

    console.log(`[${new Date().toISOString().slice(11,19)}] → ${data.recordset.length} filas en ${ms}ms`);

    // Normalizar columnas para el hub
    const normalized = data.recordset.map(row => {
      row['limte inf'] = parseDecimal(row.MUESTRACT_TOLS);
      row['limte sup'] = parseDecimal(row.MUESTRACT_TOLI);
      row['valor_cuant2'] = parseDecimal(row.VALOR_CUANT);
      return row;
    });

    res.json({
      status: 'ok',
      count: normalized.length,
      ms,
      columns: [...Object.keys(data.recordset.columns || {}), 'limte inf', 'limte sup', 'valor_cuant2'],
      data: normalized
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── ENDPOINT: Resumen rápido (KPIs) ──────────────────────────────
app.get('/api/autocontroles/resumen', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;
    const { desde, hasta } = req.query;

    let where = [];
    const request = p.request();
    if (desde) { request.input('desde', sql.NVarChar, desde); where.push('FECHA >= @desde'); }
    if (hasta) { request.input('hasta', sql.NVarChar, hasta); where.push('FECHA <= @hasta'); }
    const wc = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const query = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN FUERA_RANGO = 'X' THEN 1 ELSE 0 END) AS fuera_rango,
        COUNT(DISTINCT CENTRO) AS centros,
        COUNT(DISTINCT MATERIAL) AS materiales,
        MIN(FECHA) AS fecha_min,
        MAX(FECHA) AS fecha_max
      FROM ${tabla}${wc}
    `;

    const result = await request.query(query);
    res.json({ status: 'ok', ...result.recordset[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── ENDPOINT: Datos agrupados por centro y mes ───────────────────
app.get('/api/autocontroles/por-centro-mes', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;

    const query = `
      SELECT
        CENTRO,
        LEFT(FECHA, 6) AS MES,
        COUNT(*) AS total,
        SUM(CASE WHEN FUERA_RANGO = 'X' THEN 1 ELSE 0 END) AS oor,
        SUM(CASE WHEN VALOR_CUAL = 'NOK' THEN 1 ELSE 0 END) AS nok
      FROM ${tabla}
      GROUP BY CENTRO, LEFT(FECHA, 6)
      ORDER BY CENTRO, MES
    `;

    const result = await p.request().query(query);
    res.json({ status: 'ok', count: result.recordset.length, data: result.recordset });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── ENDPOINT: Muestra de cuantitativos (diagnóstico) ──────────────
app.get('/api/autocontroles/sample-cuant', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;
    const query = `
      SELECT TOP 10
        CENTRO, MATERIAL, DESCRIP, CARACTERISTICA_T,
        CUANTITATIVA, CUALITATIVA,
        MUESTRACT_TOLS, MUESTRACT_TOLI, MUESTRA_CANT,
        VALOR_CUANT, VALOR_CUAL, FUERA_RANGO
      FROM ${tabla}
      WHERE CUANTITATIVA = 'X'
        AND FUERA_RANGO = 'X'
      ORDER BY FECHA DESC
    `;
    const result = await p.request().query(query);
    res.json({ status: 'ok', count: result.recordset.length, data: result.recordset });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Health check y error handling ────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no capturado:', err);
  res.status(500).json({ status: 'error', message: err.message });
});

// ── Iniciar servidor ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${REPORT_NAME}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════════');
});
