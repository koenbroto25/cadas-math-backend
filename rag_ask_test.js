const https = require('https');
const body = JSON.stringify({ student_id: 'b4bcf8c1-c4b9-4ee1-b5dc-275de02fa690', question_text: 'berapa 2 tambah 3', level: 1 });
const req = https.request({ hostname: 'cadas-app-backend-production.up.railway.app', path: '/api/rag/ask', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 120000 }, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => { console.log('STATUS:', res.statusCode); console.log('BODY:', d.substring(0, 900)); });
});
req.on('timeout', () => { console.log('TIMEOUT after 120s'); req.destroy(); });
req.on('error', e => console.log('ERR:', e.message));
req.write(body);
req.end();
