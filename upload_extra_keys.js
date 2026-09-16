const fs = require('fs');
const { execSync } = require('child_process');

// Read .env file
const envContent = fs.readFileSync('.env', 'utf8');
const lines = envContent.split('\n');

const googleKeys = [];
const openrouterKeys = [];

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
  
  const googleMatch = key.match(/^GOOGLE_API_KEY_(\d+)$/);
  const openrouterMatch = key.match(/^OPENROUTER_API_KEY_(\d+)$/);
  
  if (googleMatch) {
    const num = parseInt(googleMatch[1]);
    if (num > 50) googleKeys.push({ key, value, num });
  }
  if (openrouterMatch) {
    const num = parseInt(openrouterMatch[1]);
    if (num > 3) openrouterKeys.push({ key, value, num });
  }
}

googleKeys.sort((a, b) => a.num - b.num);
openrouterKeys.sort((a, b) => a.num - b.num);

console.log(`Google keys to upload (51-250): ${googleKeys.length}`);
console.log(`OpenRouter keys to upload (4-93): ${openrouterKeys.length}`);

let count = 0;
let errors = 0;
const allKeys = [...googleKeys, ...openrouterKeys];

for (const { key, value } of allKeys) {
  try {
    const cmd = `railway variables set "${key}=${value.replace(/"/g, '\\"')}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 25 === 0) console.log(`Progress: ${count}/${allKeys.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 10) console.error(`Failed ${key}: ${e.message}`);
  }
}

console.log(`\nDone! ${count} keys uploaded, ${errors} errors.`);
