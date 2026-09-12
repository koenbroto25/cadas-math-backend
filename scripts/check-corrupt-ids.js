#!/usr/bin/env node
/** Cek ketersediaan teks sumber di DB untuk 44 file corrupt. */
const db = require('../src/database/db');

const IDS = [
  'L10_P2_023','L10_P2_028','L10_P2_045','L10_P2_049','L10_P2_050','L10_P2_059',
  'L10_P2_061','L10_P2_062','L10_P2_086','L10_P2_087','L10_P2_098','L10_P3_015',
  'L10_P3_073','L10_P3_074','L10_P3_080','L11_P2_039','L11_P2_043','L11_P2_054',
  'L11_P2_085','L12_P1_072','L15_P4_035','L15_P4_084','L1_P1_075','L1_P1_188',
  'L1_P1_190','L1_P1_224','L1_P1_238','L1_P1_239','L1_P1_242','l2_lvl2_020',
  'L4_P1_033','L4_P1_035','L4_P1_038','L4_P1_041','L5_P1_041','L5_P1_066',
  'L5_P1_071','L5_P1_080','L5_P1_098','L5_P1_099','L5_P4_068','L6_P1_049',
  'L9_P5_052','L9_P5_091',
];

async function main() {
  const r = await db.query(
    'SELECT source_id, hint_text, quick_trick FROM exercises WHERE source_id = ANY($1)',
    [IDS],
  );
  const found = new Map(r.rows.map((x) => [x.source_id, x]));
  const notFound = IDS.filter((i) => !found.has(i));
  console.log('FOUND:', r.rows.length, '/', IDS.length);
  console.log('NOT_FOUND:', JSON.stringify(notFound));
  const noHint = [...found.values()].filter((x) => !x.hint_text).map((x) => x.source_id);
  const noTrick = [...found.values()].filter((x) => !x.quick_trick).map((x) => x.source_id);
  console.log('NO_HINT_TEXT:', JSON.stringify(noHint));
  console.log('NO_TRICK_TEXT:', JSON.stringify(noTrick));
  const anom = r.rows.find((x) => x.source_id === 'l2_lvl2_020');
  console.log('ANOMALY l2_lvl2_020:', anom ? `ADA, hint="${(anom.hint_text || '').slice(0, 80)}"` : 'TIDAK ADA');
  // Cari padanan modern bila anomali tidak ada
  if (!anom) {
    const like = await db.query(
      "SELECT source_id, hint_text FROM exercises WHERE source_id ILIKE '%_020' AND source_id ILIKE '%P%' AND hint_text ILIKE '%20%' LIMIT 5",
    );
    console.log('PADANAN_MUNGKIN:', JSON.stringify(like.rows.map((x) => x.source_id)));
  }
  await db.end().catch(() => {});
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });