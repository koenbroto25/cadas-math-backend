const fs = require('fs');
const { execSync } = require('child_process');

// Read .env file
const envContent = fs.readFileSync('.env', 'utf8');
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
  if (key && value) variables.push({ key, value });
}

// Read existing Railway variables
let existingVars = new Set();
try {
  const result = execSync('railway variables list 2>&1', { encoding: 'utf8', timeout: 15000 });
  const matches = result.matchAll(/║\s*(\S+)\s*║/g);
  for (const m of matches) existingVars.add(m[1]);
} catch (e) {
  console.log('Could not fetch existing variables, will try all');
}

console.log(`Existing Railway variables: ${existingVars.size}`);
console.log(`Local .env variables: ${variables.length}`);

// Filter only new variables
const newVars = variables.filter(v => !existingVars.has(v.key));
console.log(`New variables to upload: ${newVars.length}`);

let count = 0;
let errors = 0;

for (const { key, value } of newVars) {
  try {
    const cmd = `railway variables set "${key}=${value.replace(/"/g, '\\"')}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
    count++;
    if (count % 20 === 0) console.log(`Progress: ${count}/${newVars.length}...`);
  } catch (e) {
    errors++;
    if (errors <= 10) console.error(`Failed ${key}: ${e.message}`);
  }
}

console.log(`\nDone! ${count} new variables uploaded, ${errors} errors.`);
