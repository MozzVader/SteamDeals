export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');

    // Headers para Cheapshark (requiere User-Agent descriptivo)
    const CS_HEADERS = {
      'User-Agent': 'WishlistDeals/1.0 (github.com/MozzVader/SteamDeals)'
    };

    // ── Cache Strategy (Cloudflare Cache API) ──
    // Reduces external subrequests per game from ~4 to ~1 on cache hits.
    //
    // Steam appdetails:     NOT cached — always fresh (current prices)
    // Steam appreviews:     7 day TTL   — review scores rarely change
    // CheapShark combined:  12h TTL     — historical pricing data
    //
    // Cold run (empty cache):  ~4 subrequests/game = ~40/batch (10 games)
    // Warm run (cached):       ~1 subrequest/game  = ~10/batch (only appdetails)

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

    if (mode === 'wishlist') {
      const steamId = url.searchParams.get('steamid');
      const apiKey = url.searchParams.get('apikey');
      if (!steamId || !apiKey) return new Response('Faltan datos', { status: 400 });

      try {
        const wishlistUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=${apiKey}&steamid=${steamId}`;
        const wishlistRes = await fetch(wishlistUrl);
        const wishlistData = await wishlistRes.json();

        if (!wishlistData.response || !wishlistData.response.items) {
          return new Response(JSON.stringify([]), { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
        }

        const appIds = wishlistData.response.items.map(item => item.appid);
        return new Response(JSON.stringify(appIds), { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
      }
    }

    if (mode === 'deals') {
      const appIdsStr = url.searchParams.get('appids');
      const cc = url.searchParams.get('cc') || 'us';
      if (!appIdsStr) return new Response('Faltan appids', { status: 400 });

      const appIds = appIdsStr.split(',');
      const deals = [];

      for (const appId of appIds) {
        try {
          // ── 1) Steam appdetails (current price) — NOT cached ──
          const steamPriceUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}`;
          const steamRes = await fetch(steamPriceUrl);

          if (steamRes.ok) {
            const steamData = await steamRes.json();

            if (steamData[appId] && steamData[appId].success && steamData[appId].data && steamData[appId].data.price_overview) {
              const priceInfo = steamData[appId].data.price_overview;

              if (priceInfo.discount_percent > 0) {
                let gameName = steamData[appId].data.name;
                let lowestEverUsd = null;
                let maxDiscountUs = null;

                // ── 2) CheapShark — Cached 12h (search + game data combined) ──
                try {
                  const csKey = `cs:${appId}`;
                  const cachedCs = await getCached(csKey);

                  if (cachedCs !== null) {
                    lowestEverUsd = cachedCs.lowestEverUsd;
                    maxDiscountUs = cachedCs.maxDiscountUs;
                  } else {
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
                      // Cache result (even if null — game not on CheapShark)
                      ctx.waitUntil(setCache(csKey, { lowestEverUsd, maxDiscountUs }, 43200));
                    }
                  }
                } catch (csErr) {
                  console.error("CheapShark error for " + appId + ": " + csErr.message);
                }

                // ── 3) Steam appreviews — Cached 7 days ──
                let reviewScore = null;
                let reviewLabel = '';
                try {
                  const revKey = `rev:${appId}`;
                  const cachedRev = await getCached(revKey);

                  if (cachedRev !== null) {
                    reviewScore = cachedRev.score;
                    reviewLabel = cachedRev.label;
                  } else {
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
                      // Cache result (even if no reviews: score=null, label='')
                      ctx.waitUntil(setCache(revKey, { score: reviewScore, label: reviewLabel }, 604800));
                    }
                  }
                } catch (revErr) {
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
              }
            }
          }
        } catch (e) {
          console.error("Error procesando juego " + appId + ": " + e.message);
        }
        await new Promise(r => setTimeout(r, 350));
      }

      return new Response(JSON.stringify(deals), {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }

    return new Response('Modo no válido', { status: 400 });
  }
};
