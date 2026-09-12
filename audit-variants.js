const db = require('./src/database/db');

async function main() {
  // Normalisasi label: algorithmic/shortcut -> quick (kanonik Quick Method)
  const r = await db.query(
    `UPDATE explanations e
     SET variants = (
       SELECT jsonb_agg(
         CASE WHEN v->>'explanation_style' IN ('algorithmic','shortcut')
              THEN jsonb_set(v, '{explanation_style}', '"quick"')
              ELSE v END
       )
       FROM jsonb_array_elements(e.variants::jsonb) v
     )
     WHERE e.variants::text ~* '"(algorithmic|shortcut)"'
     RETURNING e.level_id`
  );
  console.log('Normalized rows:', r.rows.map(x => 'L' + x.level_id).join(', '));

  // Re-audit
  const { rows } = await db.query(
    `SELECT e.level_id, c.code AS concept_code, e.variants, e.speech_variants
     FROM explanations e JOIN concepts c ON c.id = e.concept_id ORDER BY e.level_id`
  );
  let fail = 0;
  for (const row of rows) {
    const problems = [];
    if (!Array.isArray(row.variants) || row.variants.length === 0) {
      problems.push('variants kosong');
    } else {
      row.variants.forEach((v, i) => {
        for (const f of ['content', 'approach_name', 'explanation_style']) {
          if (!v[f] || String(v[f]).trim() === '') problems.push(`variants[${i}].${f} kosong`);
        }
        if (v.explanation_style && !['gasing', 'pmri', 'quick'].includes(v.explanation_style)) {
          problems.push(`variants[${i}].style "${v.explanation_style}" invalid`);
        }
      });
    }
    if (problems.length) {
      fail++;
      console.log('FAIL L' + row.level_id, problems.join('; '));
    } else {
      const styles = row.variants.map(v => v.explanation_style).join(', ');
      console.log('OK   L' + row.level_id, '—', row.variants.length, 'variant (' + styles + ')');
    }
  }
  console.log(`\n=== RE-AUDIT: ${rows.length - fail}/${rows.length} PASS ===`);

  // Bonus: speech_variants coverage
  const speech = await db.query(
    `SELECT e.level_id, jsonb_typeof(e.speech_variants) as jtype,
            CASE WHEN jsonb_typeof(e.speech_variants) = 'array'
                 THEN jsonb_array_length(e.speech_variants)
                 ELSE 0 END as speech_count
     FROM explanations e ORDER BY e.level_id`
  );
  console.log('\n=== speech_variants coverage ===');
  speech.rows.forEach(x => console.log(`L${x.level_id}: ${x.jtype} (${x.speech_count} items)`));

  await db.pool.end();
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });