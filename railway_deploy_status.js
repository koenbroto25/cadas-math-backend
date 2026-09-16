/**
 * railway_deploy_status.js — Cek status deployment + logs service tertentu.
 *
 *   node railway_deploy_status.js deployments <serviceId>
 *   node railway_deploy_status.js logs <deploymentId>
 *   node railway_deploy_status.js variables <serviceId>
 */
const https = require('https');

const TOKEN = process.env.RAILWAY_TOKEN || 'rAuPeJBejXvw66Cg9uWuRNr03EQzP9jBQcns5Y2P3QG';
const ENV_ID = 'bac785c3-3b27-4568-8233-33f4b3da3e33';
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

function gql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors) reject(new Error(JSON.stringify(json.errors, null, 2)));
            else resolve(json.data);
          } catch (e) {
            reject(new Error(`Parse error: ${data.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'deployments') {
    const d = await gql(
      `query($serviceId: String!, $environmentId: String!) {
         deployments(input: { serviceId: $serviceId, environmentId: $environmentId }, first: 5) {
           edges { node { id status createdAt url } }
         }
       }`,
      { serviceId: arg, environmentId: ENV_ID }
    );
    console.log(JSON.stringify(d.deployments.edges.map((e) => e.node), null, 2));
    return;
  }

  if (cmd === 'logs') {
    try {
      const d = await gql(
        `query($deploymentId: String!) {
           deploymentLogs(deploymentId: $deploymentId, limit: 100) { message severity timestamp }
         }`,
        { deploymentId: arg }
      );
      const lines = (d.deploymentLogs || []).map((l) => `[${l.severity}] ${l.message}`);
      console.log(lines.slice(-60).join('\n'));
    } catch (e) {
      console.error('deploymentLogs failed:', e.message);
    }
    const b = await gql(
      `query($deploymentId: String!) {
         buildLogs(deploymentId: $deploymentId) { message severity }
       }`,
      { deploymentId: arg }
    );
    const lines = (b.buildLogs || []).map((l) => `[build:${l.severity}] ${l.message}`);
    console.log(lines.slice(-40).join('\n'));
    return;
  }

  if (cmd === 'instance') {
    const d = await gql(
      `query($serviceId: String!, $environmentId: String!) {
         serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
           id
           latestDeployment { id status }
           domains { serviceDomains { domain } customDomains { domain } }
         }
       }`,
      { serviceId: arg, environmentId: ENV_ID }
    );
    console.log(JSON.stringify(d.serviceInstance, null, 2));
    return;
  }

  if (cmd === 'variables') {
    const d = await gql(
      `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
         variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
       }`,
      {
        projectId: '0bbcaeeb-b461-4cc5-b2dc-6d3890dc0138',
        environmentId: ENV_ID,
        serviceId: arg,
      }
    );
    console.log(JSON.stringify(d.variables, null, 2));
    return;
  }

  console.log('Usage: node railway_deploy_status.js <deployments|logs|variables> <id>');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
