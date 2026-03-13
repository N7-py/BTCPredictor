/**
 * Local dev server with Polymarket API proxy
 * Serves static files AND proxies /api/pm/* to gamma-api.polymarket.com
 * 
 * Usage: node server.js
 * Then open http://localhost:8080
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const GAMMA_API = 'https://gamma-api.polymarket.com';

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check endpoint (for Render deployment)
    if (parsed.pathname === '/health' || parsed.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
    }

    // Scrape Polymarket page for live priceToBeat (openPrice from crypto-prices query)
    if (parsed.pathname.startsWith('/api/pm-price/')) {
        const slug = parsed.pathname.replace('/api/pm-price/', '');
        const pageUrl = `https://polymarket.com/event/${slug}`;

        console.log(`[Scrape] ${pageUrl}`);

        function fetchPage(fetchUrl, depth) {
            if (depth > 3) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many redirects' }));
                return;
            }
            https.get(fetchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml'
                }
            }, (proxyRes) => {
                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                    const redir = proxyRes.headers.location.startsWith('http')
                        ? proxyRes.headers.location
                        : `https://polymarket.com${proxyRes.headers.location}`;
                    console.log(`[Scrape] Redirect ${proxyRes.statusCode} -> ${redir}`);
                    proxyRes.resume(); // drain
                    fetchPage(redir, depth + 1);
                    return;
                }

                // Handle compressed responses
                let stream = proxyRes;
                const encoding = proxyRes.headers['content-encoding'];
                console.log(`[Scrape] Status: ${proxyRes.statusCode}, encoding: ${encoding || 'none'}`);
                if (encoding === 'gzip') {
                    stream = proxyRes.pipe(zlib.createGunzip());
                } else if (encoding === 'deflate') {
                    stream = proxyRes.pipe(zlib.createInflate());
                } else if (encoding === 'br') {
                    stream = proxyRes.pipe(zlib.createBrotliDecompress());
                }

                const chunks = [];
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('error', (err) => {
                    console.error('[Scrape] Stream error:', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Stream error', message: err.message }));
                });
                stream.on('end', () => {
                    const html = Buffer.concat(chunks).toString('utf-8');
                    console.log(`[Scrape] HTML length: ${html.length}, hasNEXT: ${html.includes('__NEXT_DATA__')}`);
                try {
                    // Extract data using targeted string searches (avoid parsing 2MB JSON)
                    let openPrice = null, closePrice = null;
                    let oddsUp = null, oddsDown = null;
                    let title = '', eventId = null;

                    // Find openPrice from crypto-prices data
                    const openPriceMatch = html.match(/"openPrice"\s*:\s*([\d.]+)/);
                    if (openPriceMatch) openPrice = parseFloat(openPriceMatch[1]);

                    const closePriceMatch = html.match(/"closePrice"\s*:\s*([\d.]+)/);
                    if (closePriceMatch) closePrice = parseFloat(closePriceMatch[1]);

                    // Find outcomePrices for odds: "outcomePrices":["0.505","0.495"]
                    const oddsMatch = html.match(/"outcomePrices"\s*:\s*\["([\d.]+)"\s*,\s*"([\d.]+)"\]/);
                    if (oddsMatch) {
                        oddsUp = parseFloat(oddsMatch[1]);
                        oddsDown = parseFloat(oddsMatch[2]);
                    }

                    // Find title
                    const titleMatch = html.match(/"title"\s*:\s*"(Bitcoin Up or Down[^"]+)"/);
                    if (titleMatch) title = titleMatch[1];

                    // Find event ID  
                    const idMatch = html.match(/"id"\s*:\s*"?(\d{5,})"?/);
                    if (idMatch) eventId = parseInt(idMatch[1]);

                    // Find priceToBeat from eventMetadata
                    const ptbMatch = html.match(/"priceToBeat"\s*:\s*"?([\d.]+)"?/);
                    
                    let priceToBeat = openPrice;
                    if (!priceToBeat && ptbMatch) priceToBeat = parseFloat(ptbMatch[1]);

                    const result = {
                        priceToBeat: priceToBeat,
                        openPrice: openPrice,
                        closePrice: closePrice,
                        oddsUp: oddsUp,
                        oddsDown: oddsDown,
                        title: title,
                        eventId: eventId,
                        slug: slug
                    };

                    console.log(`[Scrape] priceToBeat=${priceToBeat}, closePrice=${closePrice}, oddsUp=${oddsUp}`);

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    console.error('[Scrape Error]', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Scrape error', message: err.message }));
                }
            });
            }).on('error', (err) => {
                console.error('[Scrape Error]', err.message);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
            });
        }
        fetchPage(pageUrl, 0);
        return;
    }

    // Proxy requests to Polymarket Gamma API
    if (parsed.pathname.startsWith('/api/pm/')) {
        const gammaPath = parsed.pathname.replace('/api/pm', '');
        const gammaUrl = GAMMA_API + gammaPath + (parsed.search || '');

        console.log(`[Proxy] ${gammaUrl}`);

        https.get(gammaUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(data);
            });
        }).on('error', (err) => {
            console.error('[Proxy Error]', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
        });
        return;
    }

    // Serve static files
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  BTC Predictor running at http://localhost:${PORT}\n`);
    console.log(`  Polymarket proxy at /api/pm/*\n`);
});
