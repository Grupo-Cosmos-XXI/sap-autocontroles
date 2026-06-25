# Report de Autocontroles — Hub de análisis con Capacidad CPK

Aplicación web Node.js + Express + SQL Server para análisis de **autocontroles de calidad** en planta.

**Basado en**: Tabla SAP `SAP_AUTOCONTROL` en BD `OLAPS_MZ`.

## Requisitos

- **Node.js ≥ 18 LTS**
- **SQL Server** con acceso a BD `OLAPS_MZ` y tabla `SAP_AUTOCONTROL`
- **Conectividad TCP** a `SRVBI:1433`

## Instalación y arranque

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar credenciales
cp .env.example .env
# Editar .env y rellenar SQL_USER / SQL_PASSWORD

# 3. Arrancar servidor
npm start
# → Abre http://localhost:3001
```

## Endpoints API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/test` | Health check: conexión SQL |
| GET | `/api/autocontroles/filtros-load` | Centros y años disponibles |
| GET | `/api/autocontroles` | Datos filtrados de autocontroles |
| GET | `/api/autocontroles/resumen` | KPIs globales |
| GET | `/api/autocontroles/por-centro-mes` | Datos agrupados por centro y mes |
| GET | `/api/autocontroles/sample-cuant` | Muestra de cuantitativos fuera rango |

## Parámetros filtros

```
?centro=1120,2020        — centros (coma-separado)
?desde=20260101          — fecha inicio (YYYYMMDD)
?hasta=20260331          — fecha fin (YYYYMMDD)
?limit=50000             — máximo de filas
```

## Seguridad

- No requiere autenticación (por ahora integrada en reverse proxy VPN)
- HTML, CSS, vendor y assets son públicos
- `server.js`, `config.js`, `node_modules/` no se exponen

## Estructura

```
.
├── server.js             Backend (Node.js)
├── config.js            Config SQL Server
├── .env.example         Plantilla config
├── package.json
├── autocontroles_hub_v2.0.html  Frontend
├── corporate-style.css
├── img/logo.png
├── vendor/chart.umd.min.js
└── README.md
```

## Variables de entorno

```
PORT=3001                          # Puerto escucha
NODE_ENV=production                # development|production
SQL_SERVER=SRVBI
SQL_DATABASE=OLAPS_MZ
SQL_USER=<usuario>
SQL_PASSWORD=<password>
JWT_SECRET=change-in-production
```

## Desarrollo

```bash
npm run dev    # nodemon con reload automático
```

## Troubleshooting

- **Error conexión SQL**: verificar credenciales en `.env` y acceso red a SRVBI
- **No se cargan datos**: revisar logs del servidor y tabla SAP_AUTOCONTROL
- **Puerto en uso**: cambiar `PORT` en `.env`

---

Creado como parte de la modularización de reports desde reports-hub.
