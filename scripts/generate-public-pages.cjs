const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '../dist');
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const homeUrlTag = '<meta property="og:url" content="https://zafirobarlounge.github.io/" />';

if (!html.includes(homeUrlTag)) {
  throw new Error('Built index.html is missing the expected home og:url metadata.');
}

// Only public routes get HTML entry points; private routes keep the SPA fallback.
for (const route of ['menu']) {
  const routeDir = path.join(distDir, route);
  const routeUrlTag = `<meta property="og:url" content="https://zafirobarlounge.github.io/${route}" />`;
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, 'index.html'), html.replace(homeUrlTag, routeUrlTag));
  console.log(`Generated ${route}/index.html with public sharing metadata.`);
}
