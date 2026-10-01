import { isErpConfigured, fetchErpPathSafe } from './erpClient.js';

async function main() {
  console.log('=== HERRAMIENTA DE DIAGNÓSTICO Y CONSULTA ERP ===\n');

  if (!isErpConfigured()) {
    console.error('❌ Error: ERP_API_KEY y/o ERP_CERT_FINGERPRINT no están configurados en el entorno.');
    process.exit(1);
  }

  const query = (process.argv[2] || 'S176012A').trim();
  console.log(`Buscando coincidencias con término: "${query}"...\n`);

  console.log('1. Consultando endpoint principal: /api/data/existencia...');
  const res = await fetchErpPathSafe('/api/data/existencia');

  if (!res.ok) {
    console.error(`❌ Falló la consulta a /api/data/existencia: ${res.error}`);
  } else {
    const raw = res.data;
    const rows = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
    console.log(`✅ Consulta exitosa: ${rows.length} registros recibidos.`);

    if (rows.length > 0) {
      const sample = rows[0];
      const columns = Object.keys(sample);
      console.log('\n--- Columnas disponibles en cada registro del ERP ---');
      console.log(columns.join(', '));

      console.log('\n--- Ejemplo de un registro crudo ---');
      console.log(JSON.stringify(sample, null, 2));

      console.log(`\n--- Buscando registros que contengan "${query}" ---`);
      const qLower = query.toLowerCase();
      const matches = [];

      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const matchedCols = [];
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== undefined && String(v).toLowerCase().includes(qLower)) {
            matchedCols.push(k);
          }
        }
        if (matchedCols.length > 0) {
          matches.push({ matchedCols, row: r });
          if (matches.length >= 10) break;
        }
      }

      if (matches.length === 0) {
        console.log(`⚠️ No se encontraron registros con "${query}" en /api/data/existencia.`);
      } else {
        console.log(`✅ Se encontraron ${matches.length} registro(s) de muestra:`);
        matches.forEach((m, idx) => {
          console.log(`\n[Coincidencia #${idx + 1}] (Columnas que coincidieron: ${m.matchedCols.join(', ')})`);
          console.log(JSON.stringify(m.row, null, 2));
        });
      }
    }
  }

  console.log('\n2. Sondeando otros endpoints candidatos en el ERP...');
  const candidates = [
    '/api/data/articulos',
    '/api/data/articulo',
    '/api/data/productos',
    '/api/data/producto',
    '/api/data/precios',
    '/api/data/precio',
    '/api/data/lista-precios',
    '/api/data/catalogo',
    '/api/data/referencias',
  ];

  for (const p of candidates) {
    const probe = await fetchErpPathSafe(p);
    if (probe.ok) {
      const pRaw = probe.data;
      const pRows = Array.isArray(pRaw?.data) ? pRaw.data : (Array.isArray(pRaw) ? pRaw : null);
      const count = pRows ? pRows.length : 1;
      console.log(`  ✅ ${p} -> DISPONIBLE (${count} elementos)`);
      if (pRows && pRows[0]) {
        console.log(`     Campos: ${Object.keys(pRows[0]).slice(0, 8).join(', ')}...`);
      }
    } else {
      console.log(`  ⚪ ${p} -> No disponible (${probe.error.slice(0, 40)})`);
    }
  }

  console.log('\n=== FIN DEL DIAGNÓSTICO ===');
}

main().catch((err) => {
  console.error('Error no controlado:', err);
  process.exit(1);
});
