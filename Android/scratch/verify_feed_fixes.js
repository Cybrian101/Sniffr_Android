import http from 'http';

function get(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: path,
      method: 'GET',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log("Checking /api/posts endpoint...");
  const posts = await get('/api/posts?page=1&limit=5');
  console.log("Paginated posts result:", posts?.posts?.length, "posts returned, hasMore:", posts?.hasMore);
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
