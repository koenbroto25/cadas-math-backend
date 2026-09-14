const fs = require('fs');
const { execSync } = require('child_process');

// Read .env.railway
const envContent = fs.readFileSync('.env.railway', 'utf8');
const lines = envContent.split('\n');

const variables = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.substring(0, eqIdx).trim();
  let value = trimmed.substring(eqIdx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (key && value) {
    variables.push({ key, value });
  }
}

console.log(`Found ${variables.length} variables to upload`);

let count = 0;
let errors = 0;

for (const { key, value } of variables) {
  try {
    const cmd = `railway variables set "${key}=${value.replace(/"/g, '\\"')}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 10 === 0) {
      console.log(`Progress: ${count}/${variables.length}...`);
    }
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`Failed ${key}: ${e.message}`);
  }
}

console.log(`\nDone! ${count} set, ${errors} errors.`);
