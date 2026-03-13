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
                    // Extract data from the page — look for __NEXT_DATA__ JSON first,
                    // then fall back to targeted regex
                    let openPrice = null, closePrice = null;
                    let oddsUp = null, oddsDown = null;
                    let title = '', eventId = null;

                    // Try to extract __NEXT_DATA__ and find the crypto-prices data for THIS slug
                    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                    if (nextDataMatch) {
                        try {
                            const nextData = JSON.parse(nextDataMatch[1]);
                            // Navigate the data structure to find the event matching our slug
                            const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
                            for (const q of queries) {
                                const data = q?.state?.data;
                                if (!data) continue;
                                
                                // Check if this query contains crypto-prices data with openPrice
                                if (data.openPrice !== undefined && typeof data.openPrice === 'number') {
                                    openPrice = data.openPrice;
                                    if (data.closePrice !== undefined && data.closePrice !== null) {
                                        closePrice = data.closePrice;
                                    }
                                    console.log(`[Scrape] Found openPrice from __NEXT_DATA__: ${openPrice}`);
                                }
                                
                                // Check for event data with markets
                                if (data.markets && Array.isArray(data.markets)) {
                                    for (const mkt of data.markets) {
                                        if (mkt.outcomePrices) {
                                            try {
                                                const prices = JSON.parse(mkt.outcomePrices);
                                                oddsUp = parseFloat(prices[0]);
                                                oddsDown = parseFloat(prices[1]);
                                            } catch (e) {}
                                        }
                                    }
                                    if (data.title) title = data.title;
                                    if (data.id) eventId = data.id;
                                    
                                    // Check eventMetadata for priceToBeat
                                    const meta = data.eventMetadata || {};
                                    if (meta.priceToBeat) {
                                        const ptb = parseFloat(meta.priceToBeat);
                                        if (!isNaN(ptb) && ptb > 0) {
                                            openPrice = openPrice || ptb;
                                            console.log(`[Scrape] priceToBeat from metadata: ${ptb}`);
                                        }
                                    }
                                }
                                
                                // Check if it's an array of events
                                if (Array.isArray(data)) {
                                    for (const item of data) {
                                        if (item?.slug === slug || (item?.markets && item?.title?.includes('Bitcoin'))) {
                                            if (item.markets) {
                                                for (const mkt of item.markets) {
                                                    if (mkt.outcomePrices) {
                                                        try {
                                                            const prices = JSON.parse(mkt.outcomePrices);
                                                            oddsUp = parseFloat(prices[0]);
                                                            oddsDown = parseFloat(prices[1]);
                                                        } catch (e) {}
                                                    }
                                                }
                                            }
                                            if (item.title) title = item.title;
                                            if (item.id) eventId = item.id;
                                        }
                                    }
                                }
                            }
                        } catch (jsonErr) {
                            console.log('[Scrape] __NEXT_DATA__ parse failed, using regex fallback');
                        }
                    }

                    // Regex fallback for anything not found from __NEXT_DATA__
                    if (!openPrice) {
                        const openPriceMatch = html.match(/"openPrice"\s*:\s*([\d.]+)/);
                        if (openPriceMatch) openPrice = parseFloat(openPriceMatch[1]);
                    }

                    if (!closePrice) {
                        const closePriceMatch = html.match(/"closePrice"\s*:\s*([\d.]+)/);
                        if (closePriceMatch) closePrice = parseFloat(closePriceMatch[1]);
                    }

                    if (!oddsUp) {
                        const oddsMatch = html.match(/"outcomePrices"\s*:\s*\["([\d.]+)"\s*,\s*"([\d.]+)"\]/);
                        if (oddsMatch) {
                            oddsUp = parseFloat(oddsMatch[1]);
                            oddsDown = parseFloat(oddsMatch[2]);
                        }
                    }

                    if (!title) {
                        const titleMatch = html.match(/"title"\s*:\s*"(Bitcoin Up or Down[^"]+)"/);
                        if (titleMatch) title = titleMatch[1];
                    }

                    if (!eventId) {
                        const idMatch = html.match(/"id"\s*:\s*"?(\d{5,})"?/);
                        if (idMatch) eventId = parseInt(idMatch[1]);
                    }

                    // Find priceToBeat from eventMetadata as fallback
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
