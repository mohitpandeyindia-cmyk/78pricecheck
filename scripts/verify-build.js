const fs = require('fs');
const path = require('path');

const requiredFiles = [
  '../frontend/customer/index.html',
  '../frontend/customer/css/customer.css',
  '../frontend/customer/css/scanner.css',
  '../frontend/customer/js/customer.js',
  '../frontend/customer/js/scanner.js',
  '../frontend/customer/js/build-env.js',
  '../frontend/customer/js/libs/html5-qrcode.min.js',
  '../frontend/customer/manifest.json',
  '../frontend/customer/sw.js',
  '../frontend/customer/assets/logo.png',
  '../frontend/customer/assets/mascot.png',
  '../frontend/customer/assets/esl-off-template.png',
  '../frontend/customer/assets/esl-wholesale-template.png',
  '../frontend/customer/assets/fonts/DigitalNumbers-Regular.woff'
];

console.log('================================================');
console.log('      RUNNING BUILD VERIFICATION GATE           ');
console.log('================================================');

let passed = true;

// 1. Verify existence of static assets
requiredFiles.forEach(file => {
  const filePath = path.resolve(__dirname, file);
  if (fs.existsSync(filePath)) {
    console.log(`  \u2705 File exists: ${path.basename(file)}`);
  } else {
    console.error(`  \u274c MISSING REQUIRED FILE: ${file}`);
    passed = false;
  }
});

// 2. Verify html5-qrcode minified content is not empty
try {
  const libPath = path.resolve(__dirname, '../frontend/customer/js/libs/html5-qrcode.min.js');
  if (fs.existsSync(libPath) && fs.statSync(libPath).size > 100000) {
    console.log('  \u2705 Local html5-qrcode.min.js file size is valid.');
  } else {
    console.error('  \u274c Local html5-qrcode.min.js file is empty or corrupted!');
    passed = false;
  }
} catch (e) {
  passed = false;
}

// 3. Ensure runtime artifact wholesale_seed.json is included in compiled dist output
try {
  const srcSeed = path.resolve(__dirname, '../backend/src/data/wholesale_seed.json');
  const distDir = path.resolve(__dirname, '../backend/dist/data');
  const distSeed = path.join(distDir, 'wholesale_seed.json');
  
  if (fs.existsSync(srcSeed)) {
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    fs.copyFileSync(srcSeed, distSeed);
    const parsed = JSON.parse(fs.readFileSync(distSeed, 'utf8'));
    if (Array.isArray(parsed) && parsed.length === 122) {
      console.log(`  \u2705 Compiled runtime seed verified: dist/data/wholesale_seed.json (${parsed.length} records)`);
    } else {
      console.error(`  \u274c Invalid seed record count in compiled runtime: ${parsed.length} (expected 122)`);
      passed = false;
    }
  } else {
    console.error('  \u274c Source wholesale_seed.json not found in backend/src/data/');
    passed = false;
  }
} catch (e) {
  console.error('  \u274c Wholesale seed build verification failed:', e.message);
  passed = false;
}

// 4. Verify HTML and JS build IDs match
try {
  const indexHtmlPath = path.resolve(__dirname, '../frontend/customer/index.html');
  const buildEnvPath = path.resolve(__dirname, '../frontend/customer/js/build-env.js');
  
  if (fs.existsSync(indexHtmlPath) && fs.existsSync(buildEnvPath)) {
    const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
    const buildEnvContent = fs.readFileSync(buildEnvPath, 'utf8');
    
    const htmlBuildMatch = indexContent.match(/window\.HTML_BUILD\s*=\s*"([^"]*)";/);
    const jsBuildMatch = buildEnvContent.match(/build:\s*"([^"]*)"/);
    
    if (htmlBuildMatch && jsBuildMatch) {
      if (htmlBuildMatch[1] === jsBuildMatch[1]) {
        console.log(`  \u2705 Build IDs match: ${htmlBuildMatch[1]}`);
      } else {
        console.error(`  \u274c BUILD ID MISMATCH: HTML=${htmlBuildMatch[1]}, JS=${jsBuildMatch[1]}`);
        passed = false;
      }
    } else {
      console.error('  \u274c Failed to extract Build IDs from static assets.');
      passed = false;
    }
  }
} catch (e) {
  console.error('  \u274c Build ID verification failed:', e.message);
  passed = false;
}

console.log('================================================');
if (passed) {
  console.log('  \u2705 acceptance check: PASSED');
  console.log('================================================');
  process.exit(0);
} else {
  console.error('  \u274c acceptance check: FAILED');
  console.log('================================================');
  process.exit(1);
}
