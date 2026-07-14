const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let commit = 'unknown';
let branch = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
  branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
} catch (e) {
  // Silent fallback if git is unavailable
}

const buildTime = new Date().toISOString();
const buildId = buildTime.replace(/[-T:.Z]/g, '').slice(0, 12); // Format: YYYYMMDDHHMM

// Load version from backend package.json
let version = '0.3.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../backend/package.json'), 'utf8'));
  version = pkg.version || version;
} catch (e) {
  // Silent fallback
}

const environment = process.env.APP_ENV || 'production';
const swEnabled = process.env.SERVICE_WORKER_ENABLED !== 'false';

console.log(`[Build Tool] Compiling metadata: Version=${version}, Build=${buildId}, Commit=${commit}, Branch=${branch}, Env=${environment}`);

// 1. Generate customer build-env.js
const buildEnvContent = `// Automatically generated build metadata
window.APP_BUILD = {
  version: "${version}",
  build: "${buildId}",
  commit: "${commit}",
  branch: "${branch}",
  buildTime: "${buildTime}",
  environment: "${environment}",
  serviceWorkerEnabled: ${swEnabled}
};
`;

const jsDir = path.join(__dirname, '../frontend/customer/js');
if (!fs.existsSync(jsDir)) {
  fs.mkdirSync(jsDir, { recursive: true });
}
fs.writeFileSync(path.join(jsDir, 'build-env.js'), buildEnvContent);

// 2. Inject expected build ID into static HTML index.html
const indexHtmlPath = path.join(__dirname, '../frontend/customer/index.html');
if (fs.existsSync(indexHtmlPath)) {
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const htmlBuildRegex = /window\.HTML_BUILD\s*=\s*"[^"]*";/;
  const htmlBuildReplacement = `window.HTML_BUILD = "${buildId}";`;
  
  if (htmlBuildRegex.test(indexHtml)) {
    indexHtml = indexHtml.replace(htmlBuildRegex, htmlBuildReplacement);
  } else {
    // Inject at the end of the head tag
    indexHtml = indexHtml.replace('</head>', `  <script>window.HTML_BUILD = "${buildId}";</script>\n</head>`);
  }
  fs.writeFileSync(indexHtmlPath, indexHtml);
}

// 3. Compile cache naming and service worker placeholders in sw.js
const swPath = path.join(__dirname, '../frontend/customer/sw.js');
if (fs.existsSync(swPath)) {
  let swContent = fs.readFileSync(swPath, 'utf8');
  
  // Replace CACHE_NAME versioning pattern
  swContent = swContent.replace(
    /const CACHE_NAME = '78pricecheck-[^']*';/,
    `const CACHE_NAME = '78pricecheck-${buildId}';`
  );
  
  fs.writeFileSync(swPath, swContent);
}

console.log('[Build Tool] Build compilation completed successfully.');
