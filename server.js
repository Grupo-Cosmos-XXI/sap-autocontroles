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

// ═══════════════════════════════════════════════════════════════
// CPK — portado de reports-hub
// ═══════════════════════════════════════════════════════════════

const NORM_CHAR = (col) =>
  `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${col}, CHAR(13), ''), CHAR(10), ''), CHAR(9), '')))`;

function buildCpkWhere(req) {
  const where = [`a.CUANTITATIVA='X'`];
  const inputs = [];
  const tList = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    return v === '' ? [] : [String(v)];
  };
  const addIn = (col, vals, prefix) => {
    if (!vals.length) return;
    const names = vals.map((v, i) => {
      const n = `${prefix}${i}`;
      inputs.push({ name: n, type: sql.NVarChar, value: v });
      return `@${n}`;
    });
    where.push(`${col} IN (${names.join(',')})`);
  };
  addIn('a.CENTRO',                          tList(req.query.centro),         'cen');
  addIn('a.MATERIAL',                        tList(req.query.material),       'mat');
  addIn(NORM_CHAR('a.CARACTERISTICA_T'),     tList(req.query.caracteristica), 'cha');
  const desde = (req.query.desde || '').trim();
  const hasta  = (req.query.hasta  || '').trim();
  if (desde) { inputs.push({ name: 'fDesde', type: sql.NVarChar, value: desde }); where.push('a.FECHA >= @fDesde'); }
  if (hasta)  { inputs.push({ name: 'fHasta', type: sql.NVarChar, value: hasta  }); where.push('a.FECHA <= @fHasta');  }
  return { whereClause: ' WHERE ' + where.join(' AND '), inputs };
}

function applyCpkInputs(request, inputs) {
  for (const i of inputs) request.input(i.name, i.type, i.value);
  return request;
}

function normalCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function andersonDarling(values) {
  const n = values.length;
  if (n < 8) return { stat: null, pValue: null };
  const sorted = [...values].sort((a,b) => a-b);
  const mean = sorted.reduce((a,v) => a+v, 0) / n;
  const variance = sorted.reduce((a,v) => a+(v-mean)**2, 0) / (n-1);
  const std = Math.sqrt(variance);
  if (std === 0) return { stat: 0, pValue: 1 };
  let S = 0;
  for (let i = 0; i < n; i++) {
    const z = (sorted[i] - mean) / std;
    const F = Math.max(1e-15, Math.min(1-1e-15, normalCDF(z)));
    const Frev = Math.max(1e-15, Math.min(1-1e-15, normalCDF((sorted[n-1-i] - mean) / std)));
    S += (2*(i+1) - 1) * (Math.log(F) + Math.log(1 - Frev));
  }
  const A2 = -n - S/n;
  const A2adj = A2 * (1 + 0.75/n + 2.25/(n*n));
  let pv;
  if (A2adj < 0.2)       pv = 1 - Math.exp(-13.436 + 101.14*A2adj - 223.73*A2adj*A2adj);
  else if (A2adj < 0.34) pv = 1 - Math.exp(-8.318 + 42.796*A2adj - 59.938*A2adj*A2adj);
  else if (A2adj < 0.6)  pv = Math.exp(0.9177 - 4.279*A2adj - 1.38*A2adj*A2adj);
  else                   pv = Math.exp(1.2937 - 5.709*A2adj + 0.0186*A2adj*A2adj);
  return { stat: A2adj, pValue: Math.max(0, Math.min(1, pv)) };
}

function calcCapability(values, lsl, usl, fueraRangoCount = 0) {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a,v) => a+v, 0) / n;
  const variance = n > 1 ? values.reduce((a,v) => a+(v-mean)**2, 0) / (n-1) : 0;
  const std = Math.sqrt(variance);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const sorted = [...values].sort((a,b) => a-b);
  const median = n % 2 ? sorted[Math.floor(n/2)] : (sorted[n/2-1] + sorted[n/2]) / 2;
  const hasLSL = lsl != null && isFinite(lsl);
  const hasUSL = usl != null && isFinite(usl);
  const cp  = (hasLSL && hasUSL && std > 0) ? (usl - lsl) / (6 * std) : null;
  const cpu = (hasUSL && std > 0) ? (usl - mean) / (3 * std) : null;
  const cpl = (hasLSL && std > 0) ? (mean - lsl) / (3 * std) : null;
  let cpk = null;
  if (cpu != null && cpl != null) cpk = Math.min(cpu, cpl);
  else if (cpu != null) cpk = cpu;
  else if (cpl != null) cpk = cpl;
  let k = null;
  if (hasLSL && hasUSL) {
    const center = (usl + lsl) / 2;
    const halfRange = (usl - lsl) / 2;
    k = halfRange > 0 ? (mean - center) / halfRange : null;
  }
  let dppmTeorico = null;
  if (std > 0) {
    const pBelow = hasLSL ? normalCDF((lsl - mean) / std) : 0;
    const pAbove = hasUSL ? 1 - normalCDF((usl - mean) / std) : 0;
    dppmTeorico = (pBelow + pAbove) * 1e6;
  }
  const dppmReal = n > 0 ? (fueraRangoCount / n) * 1e6 : null;
  const ad = andersonDarling(values);
  const lcl = std > 0 ? mean - 3*std : null;
  const ucl = std > 0 ? mean + 3*std : null;
  return {
    n, mean, std, variance, min: minV, max: maxV, median,
    lsl: hasLSL ? lsl : null, usl: hasUSL ? usl : null,
    cp, cpu, cpl, cpk,
    pp: cp, ppu: cpu, ppl: cpl, ppk: cpk,
    k, lcl, ucl,
    dppmTeorico, dppmReal,
    fueraRangoCount,
    pctFueraRango: n > 0 ? fueraRangoCount / n : null,
    adStat: ad.stat, adPValue: ad.pValue,
    isNormal: ad.pValue == null ? null : ad.pValue > 0.05,
    bilateral: hasLSL && hasUSL
  };
}

function buildHistogram(values, lsl, usl, numBins = 20) {
  if (!values.length) return { bins: [], normalCurve: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const lo = lsl != null ? Math.min(min, lsl) : min;
  const hi = usl != null ? Math.max(max, usl) : max;
  const range = hi - lo;
  const pad = range * 0.05;
  const start = lo - pad;
  const end = hi + pad;
  const binW = (end - start) / numBins;
  const counts = new Array(numBins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - start) / binW);
    if (idx < 0) idx = 0;
    if (idx >= numBins) idx = numBins - 1;
    counts[idx]++;
  }
  const bins = counts.map((c, i) => ({
    from: start + i * binW, to: start + (i+1) * binW,
    mid:  start + (i+0.5) * binW, count: c
  }));
  const n = values.length;
  const mean = values.reduce((a,v) => a+v, 0) / n;
  const variance = n > 1 ? values.reduce((a,v) => a+(v-mean)**2, 0)/(n-1) : 0;
  const std = Math.sqrt(variance);
  const normalCurve = [];
  if (std > 0) {
    const totalArea = n * binW;
    for (let i = 0; i <= numBins * 4; i++) {
      const x = start + (i / (numBins * 4)) * (end - start);
      const y = (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mean) / std) ** 2) * totalArea;
      normalCurve.push({ x, y });
    }
  }
  return { bins, normalCurve, start, end, binW };
}

function cpkBaseQuery(whereClause) {
  const safeNum = (col) => `
    CASE
      WHEN LTRIM(RTRIM(${col})) = '' THEN NULL
      WHEN REPLACE(LTRIM(RTRIM(${col})),',','.') LIKE '%[^0-9.-]%' THEN NULL
      WHEN ISNUMERIC(REPLACE(LTRIM(RTRIM(${col})),',','.') + 'e0') <> 1 THEN NULL
      ELSE CAST(REPLACE(LTRIM(RTRIM(${col})),',','.') AS NUMERIC(22,6))
    END`;
  return `(
    SELECT * FROM (
      SELECT
        a.CENTRO, a.MATERIAL, a.DESCRIP,
        ${NORM_CHAR('a.CARACTERISTICA_T')} AS Caracteristica,
        a.FECHA, a.FUERA_RANGO, a.ORDEN,
        ${safeNum('a.VALOR_CUANT')}    AS Valor,
        ${safeNum('a.MUESTRACT_TOLI')} AS USL,
        ${safeNum('a.MUESTRACT_TOLS')} AS LSL
      FROM ${config.tabla_autocontroles} a
      ${whereClause}
    ) parsed
    WHERE Valor IS NOT NULL
  )`;
}

// GET /api/cpk/filtros
app.get('/api/cpk/filtros', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const tabla = config.tabla_autocontroles;
    const [rCen, rMat, rCha] = await Promise.all([
      p.request().query(`SELECT DISTINCT a.CENTRO AS centro FROM ${tabla} a WHERE a.CUANTITATIVA='X' AND a.CENTRO IS NOT NULL ORDER BY a.CENTRO`),
      p.request().query(`SELECT a.MATERIAL AS material, MAX(a.DESCRIP) AS descrip, COUNT(*) AS n FROM ${tabla} a WHERE a.CUANTITATIVA='X' AND a.VALOR_CUANT IS NOT NULL GROUP BY a.MATERIAL ORDER BY n DESC`),
      p.request().query(`SELECT LTRIM(RTRIM(a.CARACTERISTICA_T)) AS caracteristica, COUNT(*) AS n FROM ${tabla} a WHERE a.CUANTITATIVA='X' AND a.VALOR_CUANT IS NOT NULL GROUP BY LTRIM(RTRIM(a.CARACTERISTICA_T)) ORDER BY n DESC`)
    ]);
    res.json({
      status: 'ok',
      centros: rCen.recordset.map(r => r.centro),
      materiales: rMat.recordset.map(r => ({ material: r.material, descrip: r.descrip || '', n: r.n })),
      caracteristicas: rCha.recordset.map(r => ({ caracteristica: r.caracteristica, n: r.n }))
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/cpk/ranking
app.get('/api/cpk/ranking', requireAuth, async (req, res) => {
  try {
    const p = await getPool();
    const { whereClause, inputs } = buildCpkWhere(req);
    const nMin = Math.max(1, parseInt(req.query.nMin, 10) || 5);
    const query = `
      WITH base AS (
        SELECT * FROM ${cpkBaseQuery(whereClause)} q
      ),
      lastDate AS (
        SELECT CENTRO, MATERIAL, Caracteristica, MAX(FECHA) AS maxF
        FROM base GROUP BY CENTRO, MATERIAL, Caracteristica
      ),
      currentSpec AS (
        SELECT b.CENTRO, b.MATERIAL, b.Caracteristica,
               MAX(b.LSL) AS curLSL, MAX(b.USL) AS curUSL
        FROM base b
        INNER JOIN lastDate ld
          ON b.CENTRO=ld.CENTRO AND b.MATERIAL=ld.MATERIAL
         AND b.Caracteristica=ld.Caracteristica AND b.FECHA=ld.maxF
        GROUP BY b.CENTRO, b.MATERIAL, b.Caracteristica
      ),
      totals AS (
        SELECT CENTRO, MATERIAL, Caracteristica, COUNT(*) AS nTotal
        FROM base GROUP BY CENTRO, MATERIAL, Caracteristica
      )
      SELECT
        b.CENTRO, b.MATERIAL, MAX(b.DESCRIP) AS DESCRIP, b.Caracteristica,
        COUNT(*) AS n, MAX(tot.nTotal) AS nTotal,
        AVG(CAST(b.Valor AS FLOAT)) AS mean,
        STDEV(CAST(b.Valor AS FLOAT)) AS std,
        MIN(b.Valor) AS minV, MAX(b.Valor) AS maxV,
        MAX(cs.curUSL) AS USL, MIN(cs.curLSL) AS LSL,
        SUM(CASE WHEN b.FUERA_RANGO='X' THEN 1 ELSE 0 END) AS fueraRango
      FROM base b
      INNER JOIN currentSpec cs
        ON b.CENTRO=cs.CENTRO AND b.MATERIAL=cs.MATERIAL AND b.Caracteristica=cs.Caracteristica
      INNER JOIN totals tot
        ON b.CENTRO=tot.CENTRO AND b.MATERIAL=tot.MATERIAL AND b.Caracteristica=tot.Caracteristica
      WHERE (b.LSL=cs.curLSL OR (b.LSL IS NULL AND cs.curLSL IS NULL))
        AND (b.USL=cs.curUSL OR (b.USL IS NULL AND cs.curUSL IS NULL))
      GROUP BY b.CENTRO, b.MATERIAL, b.Caracteristica
      HAVING COUNT(*) >= ${nMin}
         AND MAX(cs.curUSL) IS NOT NULL AND MIN(cs.curLSL) IS NOT NULL
         AND MAX(cs.curUSL) <> MIN(cs.curLSL)
      ORDER BY b.Caracteristica`;
    const t0 = Date.now();
    const r = await applyCpkInputs(p.request(), inputs).query(query);
    const rows = r.recordset.map(x => {
      const n = x.n, mean = Number(x.mean)||0, std = Number(x.std)||0;
      const lsl = x.LSL != null ? Number(x.LSL) : null;
      const usl = x.USL != null ? Number(x.USL) : null;
      const cpu = (usl!=null && std>0) ? (usl-mean)/(3*std) : null;
      const cpl = (lsl!=null && std>0) ? (mean-lsl)/(3*std) : null;
      const cp  = (lsl!=null && usl!=null && std>0) ? (usl-lsl)/(6*std) : null;
      let cpk = null;
      if (cpu!=null && cpl!=null) cpk = Math.min(cpu,cpl);
      else cpk = cpu ?? cpl;
      const pBelow = (lsl!=null && std>0) ? normalCDF((lsl-mean)/std) : 0;
      const pAbove = (usl!=null && std>0) ? 1-normalCDF((usl-mean)/std) : 0;
      const dppmTeorico = std>0 ? (pBelow+pAbove)*1e6 : null;
      const nTotal = Number(x.nTotal)||n;
      return {
        centro: x.CENTRO, material: x.MATERIAL, descrip: x.DESCRIP||'',
        caracteristica: x.Caracteristica,
        n, nTotal, excluidos: nTotal-n,
        mean, std, min: Number(x.minV), max: Number(x.maxV),
        lsl, usl, cp, cpu, cpl, cpk,
        dppmTeorico, dppmReal: n>0 ? (x.fueraRango/n)*1e6 : null,
        fueraRango: x.fueraRango, bilateral: lsl!=null && usl!=null
      };
    });
    res.json({ status: 'ok', ms: Date.now()-t0, rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/cpk/detalle
app.get('/api/cpk/detalle', requireAuth, async (req, res) => {
  try {
    if (!req.query.caracteristica) return res.status(400).json({ status: 'error', message: 'Falta ?caracteristica=' });
    const p = await getPool();
    const { whereClause, inputs } = buildCpkWhere(req);
    const query = `
      SELECT CENTRO, MATERIAL, DESCRIP, Caracteristica, FECHA, FUERA_RANGO, Valor, USL, LSL, ORDEN
      FROM ${cpkBaseQuery(whereClause)} q ORDER BY FECHA`;
    const t0 = Date.now();
    const r = await applyCpkInputs(p.request(), inputs).query(query);
    const ms = Date.now()-t0;
    if (!r.recordset.length) {
      let diag = '';
      try {
        const diagInputs = inputs.filter(i => !i.name.startsWith('cha'));
        const diagReq = p.request();
        for (const i of diagInputs) diagReq.input(i.name, i.type, i.value);
        const wlNoChar = [`a.CUANTITATIVA='X'`];
        for (const i of diagInputs) {
          if (i.name.startsWith('cen')) wlNoChar.push(`a.CENTRO = @${i.name}`);
          else if (i.name.startsWith('mat')) wlNoChar.push(`a.MATERIAL = @${i.name}`);
          else if (i.name==='fDesde') wlNoChar.push(`a.FECHA >= @${i.name}`);
          else if (i.name==='fHasta') wlNoChar.push(`a.FECHA <= @${i.name}`);
        }
        const dq = await diagReq.query(`SELECT TOP 5 ${NORM_CHAR('a.CARACTERISTICA_T')} AS c, COUNT(*) AS n FROM ${config.tabla_autocontroles} a WHERE ${wlNoChar.join(' AND ')} GROUP BY ${NORM_CHAR('a.CARACTERISTICA_T')} ORDER BY COUNT(*) DESC`);
        diag = dq.recordset.length
          ? 'Características encontradas para este centro+material: ' + dq.recordset.map(x => `"${x.c}" (${x.n})`).join(', ')
          : 'No hay mediciones cuantitativas para este centro+material en el rango de fechas.';
      } catch(e) { diag = ''; }
      return res.json({ status:'ok', ms, n:0, mensaje:'Sin mediciones en el rango', diagnostico: diag, buscado: req.query.caracteristica });
    }
    const allRecs = r.recordset;
    const specKey = x => `${x.LSL==null?'':Number(x.LSL)}|${x.USL==null?'':Number(x.USL)}`;
    const distinctSpecs = [...new Set(allRecs.map(specKey))];
    const lastRec = allRecs[allRecs.length-1];
    const usl = lastRec.USL!=null ? Number(lastRec.USL) : null;
    const lsl = lastRec.LSL!=null ? Number(lastRec.LSL) : null;
    const specHistory = [];
    let cur = null;
    for (const x of allRecs) {
      const k = specKey(x);
      if (!cur || cur.key!==k) {
        cur = { key:k, lsl:x.LSL!=null?Number(x.LSL):null, usl:x.USL!=null?Number(x.USL):null, desde:x.FECHA, hasta:x.FECHA, n:1 };
        specHistory.push(cur);
      } else { cur.n++; cur.hasta=x.FECHA; }
    }
    const recsSpec = allRecs.filter(x => specKey(x)===specKey(lastRec));
    const values = recsSpec.map(x => Number(x.Valor));
    const fueraRangoCount = recsSpec.filter(x => x.FUERA_RANGO==='X').length;
    const stats = calcCapability(values, lsl, usl, fueraRangoCount);
    const histogram = buildHistogram(values, lsl, usl, 25);
    const specInfo = { distinct: distinctSpecs.length, currentLsl: lsl, currentUsl: usl, nWithCurrentSpec: recsSpec.length, nTotal: allRecs.length, history: specHistory };
    const mediciones = allRecs.slice(0,2000).map(x => ({
      fecha: x.FECHA, centro: x.CENTRO, material: x.MATERIAL, descrip: x.DESCRIP,
      of: x.ORDEN ? String(x.ORDEN).trim() : null,
      valor: Number(x.Valor),
      lsl: x.LSL!=null?Number(x.LSL):null, usl: x.USL!=null?Number(x.USL):null,
      fueraRango: x.FUERA_RANGO==='X', inCurrentSpec: specKey(x)===specKey(lastRec)
    }));
    res.json({ status:'ok', ms, caracteristica: req.query.caracteristica, stats, histogram, specInfo, mediciones });
  } catch(err) {
    res.status(500).json({ status:'error', message: err.message });
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
