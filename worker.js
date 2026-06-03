export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');
    const debug = url.searchParams.get('debug') === 'true';

    // Headers para Cheapshark (requiere User-Agent descriptivo)
    const CS_HEADERS = {
      'User-Agent': 'WishlistDeals/1.0 (github.com/MozzVader/SteamDeals)'
    };

    const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    // ── Cache Strategy (Cloudflare Cache API) ──
    // Steam appdetails:     NOT cached — always fresh (current prices)
    // Steam appreviews:     7 day TTL   — review scores rarely change
    // CheapShark combined:  12h TTL     — historical pricing data

    const cache = caches.default;
    const CACHE_BASE = 'https://steamdeals-cache.local/';

    async function getCached(key) {
      try {
        const res = await cache.match(new Request(CACHE_BASE + key));
        if (res) return await res.json();
      } catch (e) {}
      return null;
    }

    async function setCache(key, data, ttlSec) {
      const res = new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' }
      });
      await cache.put(new Request(CACHE_BASE + key), res, { expirationTtl: ttlSec });
    }

    // ── Debug helper ──
    function timer() {
      const start = Date.now();
      return () => Date.now() - start;
    }

    if (mode === 'wishlist') {
      const steamId = url.searchParams.get('steamid');
      const apiKey = url.searchParams.get('apikey');
      if (!steamId || !apiKey) return new Response('Faltan datos', { status: 400, headers: CORS });

      try {
        const wishlistUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=${apiKey}&steamid=${steamId}`;
        const wishlistRes = await fetch(wishlistUrl);
        const wishlistData = await wishlistRes.json();

        if (!wishlistData.response || !wishlistData.response.items) {
          return new Response(JSON.stringify([]), { headers: CORS });
        }

        const appIds = wishlistData.response.items.map(item => item.appid);
        return new Response(JSON.stringify(appIds), { headers: CORS });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    if (mode === 'deals') {
      const appIdsStr = url.searchParams.get('appids');
      const cc = url.searchParams.get('cc') || 'us';
      if (!appIdsStr) return new Response('Faltan appids', { status: 400 });

      const appIds = appIdsStr.split(',');
      const deals = [];
      const failedAppIds = [];
      const dbg = debug ? {
        subrequests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errors: [],
        games: []
      } : null;
      const totalStart = timer();

      for (const appId of appIds) {
        const gameDbg = debug ? { appId, calls: [] } : null;
        try {
          // ── 1) Steam appdetails (current price) — NOT cached ──
          const t1 = timer();
          const steamPriceUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}`;
          const steamRes = await fetch(steamPriceUrl);
          const appdetailsMs = t1();
          if (debug) { dbg.subrequests++; gameDbg.calls.push({ api: 'appdetails', cached: false, ms: appdetailsMs, ok: steamRes.ok }); }

          if (!steamRes.ok) {
            if (debug) { dbg.errors.push({ appId, api: 'appdetails', error: 'HTTP ' + steamRes.status }); }
            failedAppIds.push(appId);
          }

          if (steamRes.ok) {
            const steamData = await steamRes.json();

            if (steamData[appId] && steamData[appId].success && steamData[appId].data && steamData[appId].data.price_overview) {
              const priceInfo = steamData[appId].data.price_overview;

              if (priceInfo.discount_percent > 0) {
                let gameName = steamData[appId].data.name;
                let lowestEverUsd = null;
                let maxDiscountUs = null;

                // ── 2) CheapShark — Cached 12h ──
                try {
                  const csKey = `cs:${appId}`;
                  const t2 = timer();
                  const cachedCs = await getCached(csKey);
                  const cacheCheckMs = t2();

                  if (cachedCs !== null) {
                    lowestEverUsd = cachedCs.lowestEverUsd;
                    maxDiscountUs = cachedCs.maxDiscountUs;
                    if (debug) { dbg.cacheHits++; gameDbg.calls.push({ api: 'cheapshark', cached: true, ms: cacheCheckMs, ok: true }); }
                  } else {
                    if (debug) { dbg.cacheMisses++; }
                    const t3 = timer();
                    const csSearchUrl = `https://www.cheapshark.com/api/1.0/games?steamAppID=${appId}&limit=1`;
                    const csSearchRes = await fetch(csSearchUrl, { headers: CS_HEADERS });

                    if (csSearchRes.ok) {
                      const csSearchData = await csSearchRes.json();
                      if (csSearchData.length > 0 && csSearchData[0].gameID) {
                        const csGameId = csSearchData[0].gameID;
                        const csGameUrl = `https://www.cheapshark.com/api/1.0/games?id=${csGameId}`;
                        const csGameRes = await fetch(csGameUrl, { headers: CS_HEADERS });
                        if (csGameRes.ok) {
                          const csGameData = await csGameRes.json();
                          if (csGameData.cheapestPriceEver) {
                            const lowestPrice = parseFloat(csGameData.cheapestPriceEver.price);
                            if (lowestPrice > 0) {
                              lowestEverUsd = lowestPrice.toFixed(2);
                              const steamDeal = (csGameData.deals || []).find(d => String(d.storeID) === '1');
                              const normalPrice = steamDeal ? parseFloat(steamDeal.retailPrice) : 0;
                              if (normalPrice > 0) {
                                maxDiscountUs = Math.round((1 - (lowestPrice / normalPrice)) * 100);
                              }
                            }
                          }
                        }
                      }
                      ctx.waitUntil(setCache(csKey, { lowestEverUsd, maxDiscountUs }, 43200));
                    }
                    const csMs = t3();
                    if (debug) { dbg.subrequests += 2; gameDbg.calls.push({ api: 'cheapshark', cached: false, ms: csMs, ok: true }); }
                  }
                } catch (csErr) {
                  if (debug) { dbg.errors.push({ appId, api: 'cheapshark', error: csErr.message }); }
                  console.error("CheapShark error for " + appId + ": " + csErr.message);
                }

                // ── 3) Steam appreviews — Cached 7 days ──
                let reviewScore = null;
                let reviewLabel = '';
                try {
                  const revKey = `rev:${appId}`;
                  const t4 = timer();
                  const cachedRev = await getCached(revKey);
                  const cacheCheckMs = t4();

                  if (cachedRev !== null) {
                    reviewScore = cachedRev.score;
                    reviewLabel = cachedRev.label;
                    if (debug) { dbg.cacheHits++; gameDbg.calls.push({ api: 'reviews', cached: true, ms: cacheCheckMs, ok: true }); }
                  } else {
                    if (debug) { dbg.cacheMisses++; }
                    const t5 = timer();
                    const reviewUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&num_per_page=0&purchase_type=all`;
                    const reviewRes = await fetch(reviewUrl);
                    if (reviewRes.ok) {
                      const reviewData = await reviewRes.json();
                      const qs = reviewData.query_summary;
                      if (qs && qs.total_reviews > 0) {
                        reviewScore = Math.round((qs.total_positive / qs.total_reviews) * 100);
                        if (reviewScore >= 70) reviewLabel = 'positive';
                        else if (reviewScore >= 40) reviewLabel = 'mixed';
                        else reviewLabel = 'negative';
                      }
                      ctx.waitUntil(setCache(revKey, { score: reviewScore, label: reviewLabel }, 604800));
                    }
                    const revMs = t5();
                    if (debug) { dbg.subrequests++; gameDbg.calls.push({ api: 'reviews', cached: false, ms: revMs, ok: reviewRes.ok }); }
                  }
                } catch (revErr) {
                  if (debug) { dbg.errors.push({ appId, api: 'reviews', error: revErr.message }); }
                  console.error('Review fetch error for ' + appId + ': ' + revErr.message);
                }

                deals.push({
                  appId: appId,
                  name: gameName,
                  steamPrice: (priceInfo.final / 100).toFixed(2),
                  originalPrice: (priceInfo.initial / 100).toFixed(2),
                  discount: priceInfo.discount_percent,
                  currency: priceInfo.currency || 'USD',
                  lowestEverUsd: lowestEverUsd,
                  maxDiscountUs: maxDiscountUs,
                  reviewScore: reviewScore,
                  reviewLabel: reviewLabel
                });
                if (debug) gameDbg.dealFound = true;
              }
            }
          }
        } catch (e) {
          if (debug) { dbg.errors.push({ appId, api: 'appdetails', error: e.message }); }
          console.error("Error procesando juego " + appId + ": " + e.message);
          failedAppIds.push(appId);
        }
        if (debug) { gameDbg.totalMs = gameDbg.calls.reduce((s, c) => s + c.ms, 0); dbg.games.push(gameDbg); }
        await new Promise(r => setTimeout(r, 350));
      }

      const totalMs = totalStart();
      const response = { deals, failedAppIds };
      if (debug) {
        response._debug = {
          ...dbg,
          totalMs,
          gamesProcessed: appIds.length,
          dealsFound: deals.length
        };
      }

      return new Response(JSON.stringify(response), { headers: CORS });
    }

    // ── mode=retry: retry rate-limited games with 2s delay ──
    if (mode === 'retry') {
      const appIdsStr = url.searchParams.get('appids');
      const cc = url.searchParams.get('cc') || 'us';
      if (!appIdsStr) return new Response('Faltan appids', { status: 400, headers: CORS });

      const appIds = appIdsStr.split(',');
      const deals = [];
      const failedAppIds = [];
      const dbg = debug ? {
        subrequests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errors: [],
        games: []
      } : null;
      const totalStart = timer();

      for (let idx = 0; idx < appIds.length; idx++) {
        const appId = appIds[idx];
        const gameDbg = debug ? { appId, calls: [] } : null;
        try {
          // ── 1) Steam appdetails (current price) — NOT cached ──
          const t1 = timer();
          const steamPriceUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}`;
          const steamRes = await fetch(steamPriceUrl);
          const appdetailsMs = t1();
          if (debug) { dbg.subrequests++; gameDbg.calls.push({ api: 'appdetails', cached: false, ms: appdetailsMs, ok: steamRes.ok }); }

          if (!steamRes.ok) {
            if (debug) { dbg.errors.push({ appId, api: 'appdetails', error: 'HTTP ' + steamRes.status }); }
            failedAppIds.push(appId);
          }

          if (steamRes.ok) {
            const steamData = await steamRes.json();

            if (steamData[appId] && steamData[appId].success && steamData[appId].data && steamData[appId].data.price_overview) {
              const priceInfo = steamData[appId].data.price_overview;

              if (priceInfo.discount_percent > 0) {
                let gameName = steamData[appId].data.name;
                let lowestEverUsd = null;
                let maxDiscountUs = null;

                // ── 2) CheapShark — Cached 12h ──
                try {
                  const csKey = `cs:${appId}`;
                  const t2 = timer();
                  const cachedCs = await getCached(csKey);
                  const cacheCheckMs = t2();

                  if (cachedCs !== null) {
                    lowestEverUsd = cachedCs.lowestEverUsd;
                    maxDiscountUs = cachedCs.maxDiscountUs;
                    if (debug) { dbg.cacheHits++; gameDbg.calls.push({ api: 'cheapshark', cached: true, ms: cacheCheckMs, ok: true }); }
                  } else {
                    if (debug) { dbg.cacheMisses++; }
                    const t3 = timer();
                    const csSearchUrl = `https://www.cheapshark.com/api/1.0/games?steamAppID=${appId}&limit=1`;
                    const csSearchRes = await fetch(csSearchUrl, { headers: CS_HEADERS });

                    if (csSearchRes.ok) {
                      const csSearchData = await csSearchRes.json();
                      if (csSearchData.length > 0 && csSearchData[0].gameID) {
                        const csGameId = csSearchData[0].gameID;
                        const csGameUrl = `https://www.cheapshark.com/api/1.0/games?id=${csGameId}`;
                        const csGameRes = await fetch(csGameUrl, { headers: CS_HEADERS });
                        if (csGameRes.ok) {
                          const csGameData = await csGameRes.json();
                          if (csGameData.cheapestPriceEver) {
                            const lowestPrice = parseFloat(csGameData.cheapestPriceEver.price);
                            if (lowestPrice > 0) {
                              lowestEverUsd = lowestPrice.toFixed(2);
                              const steamDeal = (csGameData.deals || []).find(d => String(d.storeID) === '1');
                              const normalPrice = steamDeal ? parseFloat(steamDeal.retailPrice) : 0;
                              if (normalPrice > 0) {
                                maxDiscountUs = Math.round((1 - (lowestPrice / normalPrice)) * 100);
                              }
                            }
                          }
                        }
                      }
                      ctx.waitUntil(setCache(csKey, { lowestEverUsd, maxDiscountUs }, 43200));
                    }
                    const csMs = t3();
                    if (debug) { dbg.subrequests += 2; gameDbg.calls.push({ api: 'cheapshark', cached: false, ms: csMs, ok: true }); }
                  }
                } catch (csErr) {
                  if (debug) { dbg.errors.push({ appId, api: 'cheapshark', error: csErr.message }); }
                  console.error("CheapShark error for " + appId + ": " + csErr.message);
                }

                // ── 3) Steam appreviews — Cached 7 days ──
                let reviewScore = null;
                let reviewLabel = '';
                try {
                  const revKey = `rev:${appId}`;
                  const t4 = timer();
                  const cachedRev = await getCached(revKey);
                  const cacheCheckMs = t4();

                  if (cachedRev !== null) {
                    reviewScore = cachedRev.score;
                    reviewLabel = cachedRev.label;
                    if (debug) { dbg.cacheHits++; gameDbg.calls.push({ api: 'reviews', cached: true, ms: cacheCheckMs, ok: true }); }
                  } else {
                    if (debug) { dbg.cacheMisses++; }
                    const t5 = timer();
                    const reviewUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&num_per_page=0&purchase_type=all`;
                    const reviewRes = await fetch(reviewUrl);
                    if (reviewRes.ok) {
                      const reviewData = await reviewRes.json();
                      const qs = reviewData.query_summary;
                      if (qs && qs.total_reviews > 0) {
                        reviewScore = Math.round((qs.total_positive / qs.total_reviews) * 100);
                        if (reviewScore >= 70) reviewLabel = 'positive';
                        else if (reviewScore >= 40) reviewLabel = 'mixed';
                        else reviewLabel = 'negative';
                      }
                      ctx.waitUntil(setCache(revKey, { score: reviewScore, label: reviewLabel }, 604800));
                    }
                    const revMs = t5();
                    if (debug) { dbg.subrequests++; gameDbg.calls.push({ api: 'reviews', cached: false, ms: revMs, ok: reviewRes.ok }); }
                  }
                } catch (revErr) {
                  if (debug) { dbg.errors.push({ appId, api: 'reviews', error: revErr.message }); }
                  console.error('Review fetch error for ' + appId + ': ' + revErr.message);
                }

                deals.push({
                  appId: appId,
                  name: gameName,
                  steamPrice: (priceInfo.final / 100).toFixed(2),
                  originalPrice: (priceInfo.initial / 100).toFixed(2),
                  discount: priceInfo.discount_percent,
                  currency: priceInfo.currency || 'USD',
                  lowestEverUsd: lowestEverUsd,
                  maxDiscountUs: maxDiscountUs,
                  reviewScore: reviewScore,
                  reviewLabel: reviewLabel
                });
                if (debug) gameDbg.dealFound = true;
              }
            }
          }
        } catch (e) {
          if (debug) { dbg.errors.push({ appId, api: 'appdetails', error: e.message }); }
          console.error("Error procesando juego " + appId + ": " + e.message);
          failedAppIds.push(appId);
        }
        if (debug) { gameDbg.totalMs = gameDbg.calls.reduce((s, c) => s + c.ms, 0); dbg.games.push(gameDbg); }
        // 2 second delay between requests to avoid Steam rate limit
        if (idx < appIds.length - 1) await new Promise(r => setTimeout(r, 2000));
      }

      const totalMs = totalStart();
      const response = { deals, failedAppIds };
      if (debug) {
        response._debug = {
          ...dbg,
          totalMs,
          gamesProcessed: appIds.length,
          dealsFound: deals.length
        };
      }

      return new Response(JSON.stringify(response), { headers: CORS });
    }

    return new Response('Modo no válido', { status: 400 });
  }
};
