const https = require('https');

const RAILWAY_TOKEN = '-eY5h9SLdbV3bdE6-0_0ChruT-ezb42WHDdNIL7vd5m';
const PROJECT_ID = '0bbcaeeb-b461-4cc5-b2dc-6d3890dc0138';

const query = `
query {
  project(id: "${PROJECT_ID}") {
    services {
      edges {
        node {
          id
          name
        }
      }
    }
  }
}`;

const body = JSON.stringify({ query });

const options = {
  hostname: 'backboard.railway.com',
  path: '/graphql/v2',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${RAILWAY_TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let responseBody = '';
  res.on('data', chunk => responseBody += chunk);
  res.on('end', () => {
    const data = JSON.parse(responseBody);
    if (data.data && data.data.project) {
      const services = data.data.project.services.edges;
      for (const svc of services) {
        console.log(`Service: ${svc.node.name} (${svc.node.id})`);
      }
    } else {
      console.log('Error:', JSON.stringify(data, null, 2));
    }
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
