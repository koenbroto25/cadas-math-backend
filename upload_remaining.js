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
  
  if (key.startsWith('GOOGLE_API_KEY_')) {
    const num = parseInt(key.replace('GOOGLE_API_KEY_', ''));
    if (num >= 56 && num <= 250) googleKeys.push({ key, value, num });
  }
  if (key.startsWith('OPENROUTER_API_KEY_')) {
    const num = parseInt(key.replace('OPENROUTER_API_KEY_', ''));
    if (num >= 4 && num <= 93) openrouterKeys.push({ key, value, num });
  }
}

googleKeys.sort((a, b) => a.num - b.num);
openrouterKeys.sort((a, b) => a.num - b.num);

console.log(`Google keys to upload (56-250): ${googleKeys.length}`);
console.log(`OpenRouter keys to upload (4-93): ${openrouterKeys.length}`);

let count = 0;
let errors = 0;

// Upload Google keys
for (const { key, value } of googleKeys) {
  try {
    const cmd = `railway variables set "${key}=${value.replace(/"/g, '\\"')}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 50 === 0) console.log(`Google keys: ${count}/${googleKeys.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 10) console.error(`Failed ${key}: ${e.message}`);
  }
}

console.log(`Google keys done! ${count} uploaded, ${errors} errors.`);

// Reset for OpenRouter
const googleCount = count;
const googleErrors = errors;
count = 0;
errors = 0;

// Upload OpenRouter keys
for (const { key, value } of openrouterKeys) {
  try {
    const cmd = `railway variables set "${key}=${value.replace(/"/g, '\\"')}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 25 === 0) console.log(`OpenRouter keys: ${count}/${openrouterKeys.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 10) console.error(`Failed ${key}: ${e.message}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Google keys (56-250): ${googleCount} uploaded, ${googleErrors} errors`);
console.log(`OpenRouter keys (4-93): ${count} uploaded, ${errors} errors`);
console.log(`Total: ${googleCount + count} keys uploaded, ${googleErrors + errors} errors`);
