const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = path.join(__dirname, '../pwa/screenshots');
const DIST_DIR = path.join(__dirname, '../dist');

async function generateScreenshots() {
  console.log('📸 Génération des screenshots PWA avec Playwright...');
  
  // Ensure screenshots directory exists
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  // Check if screenshots already exist
  const requiredScreenshots = [
    'mobile-1.png',
    'mobile-2.png', 
    'desktop-1.png'
  ];

  const existingScreenshots = requiredScreenshots.filter(file => 
    fs.existsSync(path.join(SCREENSHOTS_DIR, file))
  );

  if (existingScreenshots.length === requiredScreenshots.length) {
    console.log('✅ Les screenshots existent déjà, génération sautée.');
    return;
  }

  console.log('🚀 Lancement du serveur pour les screenshots...');
  
  // Start a simple HTTP server for the app
  const http = require('http');
  const server = http.createServer((req, res) => {
    const filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url);
    
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentType = ext === '.png' ? 'image/png' : 
                          ext === '.ico' ? 'image/x-icon' :
                          ext === '.js' ? 'application/javascript' :
                          ext === '.json' ? 'application/json' :
                          'text/html';
      
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(3000);
  
  try {
    const browser = await chromium.launch();
    const context = await browser.newContext();

    // Mobile screenshots
    console.log('📱 Capture mobile 1...');
    const mobilePage = await context.newPage();
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await mobilePage.goto('http://localhost:3000');
    await mobilePage.waitForTimeout(2000); // Wait for app to load
    await mobilePage.screenshot({ 
      path: path.join(SCREENSHOTS_DIR, 'mobile-1.png'),
      fullPage: false 
    });

    console.log('📱 Capture mobile 2...');
    // Simulate menu interaction or different state
    await mobilePage.click('body'); // Simple interaction to change state
    await mobilePage.waitForTimeout(500);
    await mobilePage.screenshot({ 
      path: path.join(SCREENSHOTS_DIR, 'mobile-2.png'),
      fullPage: false 
    });

    // Desktop screenshot
    console.log('🖥️  Capture desktop...');
    const desktopPage = await context.newPage();
    await desktopPage.setViewportSize({ width: 1280, height: 720 });
    await desktopPage.goto('http://localhost:3000');
    await desktopPage.waitForTimeout(2000);
    await desktopPage.screenshot({ 
      path: path.join(SCREENSHOTS_DIR, 'desktop-1.png'),
      fullPage: false 
    });

    await browser.close();
    console.log('✅ Screenshots générés avec succès!');
    
  } catch (error) {
    console.error('❌ Erreur lors de la génération des screenshots:', error);
    throw error;
  } finally {
    server.close();
  }
}

// Run if called directly
if (require.main === module) {
  generateScreenshots().catch(console.error);
}

module.exports = { generateScreenshots };
