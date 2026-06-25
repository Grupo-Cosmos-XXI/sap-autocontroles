// ═══════════════════════════════════════════════════════════════
// config.js — Configuración PRO  (RELLENAR ANTES DE ARRANCAR)
// ═══════════════════════════════════════════════════════════════

module.exports = {
  sql: {
    server:   'SRVBI',        // Host SQL Server
    database: 'OLAPS_MZ',     // BD por defecto (las consultas usan FQN [BD].[dbo].[TABLA])
    user:     '<USUARIO_SQL>',// ⚠️ Rellenar
    password: '<PASSWORD_SQL>',// ⚠️ Rellenar
    port: 1433,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      requestTimeout: 120000,
      connectionTimeout: 15000
    }
  },

  // Tablas SAP en SQL Server (mantener si no cambian de nombre)
  tabla_autocontroles:  'SAP_AUTOCONTROL',
  tabla_notificaciones: 'OLAPS_MZ.dbo.NOTIFICACIONES_OFS',
  tabla_ventas:         'OLAPS_MZ.dbo.SAP_COSTES_PLAN',
  tabla_costes_reales:  'OLAPS_MZ.dbo.SAP_COSTES_REALES',
  tabla_cartera:        'OLAPS_MZ.dbo.CARTERA',
  tabla_compras:        'OLAPS_MZ.dbo.SAP_COMPRAS',
  // Mantenimiento (módulo PM SAP) — réplica de avisos + notificaciones
  tabla_avisos_mant:    'OLAPS_MZ.dbo.SAP_AVISOS_MANT',
  tabla_notif_mant:     'OLAPS_MZ.dbo.SAP_NOTIF_MANT',
  // PyG — Olap_PyG (detalle 14M filas) + tabla maestra de clasificación contable
  // Importante: el usuario SQL configurado debe tener lectura sobre ACCESO_INF
  tabla_pyg:            'ACCESO_INF.dbo.Olap_PyG',
  tabla_pyg_clasif:     'ACCESO_INF.dbo.Clasif_Cuentas_PyG',

  // Puerto donde escucha el servidor web. Debe estar abierto en firewall
  // para los usuarios de VPN.
  port: 3001
};
