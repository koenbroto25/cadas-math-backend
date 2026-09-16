const fs = require('fs');
const { execSync } = require('child_process');

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
  
  if (key.startsWith('GOOGLE_API_KEY_')) {
    const num = parseInt(key.replace('GOOGLE_API_KEY_', ''));
    if (num >= 61 && num <= 250) googleKeys.push({ key, value, num });
  }
  if (key.startsWith('OPENROUTER_API_KEY_')) {
    const num = parseInt(key.replace('OPENROUTER_API_KEY_', ''));
    if (num >= 4 && num <= 93) openrouterKeys.push({ key, value, num });
  }
}

googleKeys.sort((a, b) => a.num - b.num);
openrouterKeys.sort((a, b) => a.num - b.num);

console.log(`Google keys (61-250): ${googleKeys.length}`);
console.log(`OpenRouter keys (4-93): ${openrouterKeys.length}`);

let count = 0;
let errors = 0;

for (const { key, value } of googleKeys) {
  try {
    execSync(`railway variables set "${key}=${value.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 25 === 0) console.log(`Google: ${count}/${googleKeys.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`Failed ${key}`);
  }
}

console.log(`Google done: ${count}, errors: ${errors}`);

const gCount = count;
const gErrors = errors;
count = 0;
errors = 0;

for (const { key, value } of openrouterKeys) {
  try {
    execSync(`railway variables set "${key}=${value.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 25 === 0) console.log(`OpenRouter: ${count}/${openrouterKeys.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 5) console.error(`Failed ${key}`);
  }
}

console.log(`\n=== DONE ===`);
console.log(`Google: ${gCount} uploaded, ${gErrors} errors`);
console.log(`OpenRouter: ${count} uploaded, ${errors} errors`);
