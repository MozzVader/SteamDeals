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

    // ── CC → Currency code mapping (for package pricing fallback) ──
    const CC_CURRENCY = {
      us:'USD', gb:'GBP', eu:'EUR', ar:'ARS', br:'BRL', ca:'CAD', au:'AUD',
      jp:'JPY', cn:'CNY', kr:'KRW', mx:'MXN', cl:'CLP', co:'COP', pe:'PEN',
      ru:'RUB', tr:'TRY', in:'INR', nz:'NZD', no:'NOK', se:'SEK', dk:'DKK',
      pl:'PLN', ch:'CHF', za:'ZAR', sa:'SAR', ae:'AED', sg:'SGD', hk:'HKD',
      tw:'TWD', th:'THB', ph:'PHP', my:'MYR', id:'IDR', vn:'VND', ua:'UAH',
      kz:'KZT', uy:'UYU', cr:'CRC', gt:'GTQ', sv:'SVC', hn:'HNL', ni:'NIO',
      pa:'PAB', py:'PYG', bo:'BOB', ec:'USD', de:'EUR', fr:'EUR', es:'EUR',
      it:'EUR', nl:'EUR', be:'EUR', at:'EUR', pt:'EUR', ie:'EUR', fi:'EUR',
      gr:'EUR', cy:'EUR', mt:'EUR', lv:'EUR', lt:'EUR', sk:'EUR', si:'EUR',
      ee:'EUR', lu:'EUR', bg:'BGN', hr:'EUR', cz:'CZK', hu:'HUF', ro:'RON',
      is:'ISK'
    };
    function currencyForCc(cc) {
      return CC_CURRENCY[cc.toLowerCase()] || cc.toUpperCase();
    }

    // ── Helper: find best deal price from appdetails (individual or package) ──
    // This replicates Augmented Steam's "bestPurchaseOption" logic:
    // the appdetails API's price_overview only shows individual app pricing,
    // but a game might be discounted only as part of a package/bundle.
    // We check package_groups[].subs[] for any with percent_savings > 0.
    function findBestPrice(appData, cc) {
      // 1) Individual price (primary — this is what price_overview returns)
      if (appData.price_overview && appData.price_overview.discount_percent > 0) {
        return {
          final: appData.price_overview.final,
          initial: appData.price_overview.initial,
          discount_percent: appData.price_overview.discount_percent,
          currency: appData.price_overview.currency || currencyForCc(cc),
          source: 'individual'
        };
      }
      // 2) Package fallback — check all package_groups for discounted subs
      if (appData.package_groups && Array.isArray(appData.package_groups)) {
        let bestPkg = null;
        for (const group of appData.package_groups) {
          if (!group.subs || !Array.isArray(group.subs)) continue;
          for (const sub of group.subs) {
            const savings = sub.percent_savings || 0;
            const finalCents = sub.price_in_cents_with_discount || 0;
            if (savings > 0 && !sub.is_free_license && finalCents >= 0) {
              if (!bestPkg || savings > bestPkg.discount_percent) {
                bestPkg = {
                  final: finalCents,
                  initial: finalCents > 0 ? Math.round(finalCents / (1 - savings / 100)) : 0,
                  discount_percent: savings,
                  currency: currencyForCc(cc),
                  source: `package:${sub.packageid}`
                };
              }
            }
          }
        }
        if (bestPkg) return bestPkg;
      }
      return null;
    }

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

    // ── mode=scrape: extrae appids del HTML de la wishlist pública ──
    // No necesita API key. Funciona para wishlists públicas.
    // Usa vanity ID (/wishlist/id/{name}/) o Steam64 ID (/wishlist/profiles/{id}/)
    if (mode === 'scrape') {
      const profile = url.searchParams.get('profile');
      if (!profile) return new Response('Faltan datos', { status: 400, headers: CORS });

      let wishlistUrl;
      if (/^\d+$/.test(profile)) {
        wishlistUrl = `https://store.steampowered.com/wishlist/profiles/${profile}/`;
      } else {
        wishlistUrl = `https://store.steampowered.com/wishlist/id/${profile}/`;
      }

      try {
        const res = await fetch(wishlistUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });

        if (!res.ok) {
          // 429 = rate limit temporal (recuperable con retry)
          // Otros errores = bloqueo permanente
          const is429 = res.status === 429;
          return new Response(JSON.stringify({
            error: `HTTP ${res.status}`,
            blocked: true,
            rate_limited: is429,
            retry_after: is429 ? 5 : null
          }), {
            status: res.status, headers: CORS
          });
        }

        const html = await res.text();

        // Parsear g_rgWishlistData: buscar el inicio del objeto, extraer hasta </script>
        const startMatch = html.match(/g_rgWishlistData\s*=\s*\{/);
        if (startMatch) {
          const startIdx = startMatch.index + startMatch[0].length;
          const scriptEnd = html.indexOf('</script>', startIdx);
          const chunk = html.substring(startIdx, scriptEnd > 0 ? scriptEnd : startIdx + 500000);
          // Keys numéricas top-level = appids (formato Steam: 730:{ ... }, 570:{ ... }, ...)
          const appIds = [...chunk.matchAll(/(\d+)\s*:\s*\{/g)].map(m => m[1]);
          const unique = [...new Set(appIds)];
          if (unique.length > 0) {
            return new Response(JSON.stringify(unique), { headers: CORS });
          }
        }

        // Fallback: buscar patrón "appid":numero en todo el HTML
        const fallbackIds = [...html.matchAll(/"appid"\s*:\s*(\d+)/g)].map(m => m[1]);
        const uniqueFallback = [...new Set(fallbackIds)];
        if (uniqueFallback.length > 0) {
          return new Response(JSON.stringify(uniqueFallback), { headers: CORS });
        }

        return new Response(JSON.stringify({ error: 'No se encontraron appids en la wishlist', blocked: true }), {
          status: 404, headers: CORS
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    // ── mode=wishlistdata: obtiene TODA la wishlist con precios en 1 request ──
    // Usa el endpoint público de Steam Store (igual que Augmented Steam).
    // NOTA: Steam puede bloquear requests desde IPs de cloud (302 redirect).
    // El frontend debe ofrecer fallback: JSON import o Wishlist API.
    if (mode === 'wishlistdata') {
      const steamId = url.searchParams.get('steamid');
      const cc = url.searchParams.get('cc') || 'us';
      if (!steamId) return new Response('Faltan steamid', { status: 400, headers: CORS });

      try {
        const wlUrl = `https://store.steampowered.com/wishlist/profiles/${steamId}/wishlistdata/`;
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://store.steampowered.com/wishlist/profiles/' + steamId + '/',
          'Cookie': `cc=${cc}; l=english`
        };
        // redirect:'manual' para detectar 302 sin seguirlo
        const wlRes = await fetch(wlUrl, { headers, redirect: 'manual' });

        // 302/301 = Steam bloquea la request (IP de cloud, bot detection)
        if (wlRes.status >= 300 && wlRes.status < 400) {
          const loc = wlRes.headers.get('Location') || 'unknown';
          return new Response(JSON.stringify({
            error: 'Steam bloqueó la solicitud (redirect 302). Steam está bloqueando requests desde IPs de cloud/servidor.',
            blocked: true,
            redirectTo: loc
          }), { status: 503, headers: CORS });
        }

        if (!wlRes.ok) {
          return new Response(JSON.stringify({ error: `Steam respondió con ${wlRes.status}` }), { status: 502, headers: CORS });
        }

        const text = await wlRes.text();
        // Verificar que no recibimos HTML (otro tipo de bloqueo)
        if (text.trim().startsWith('<') || text.trim().startsWith('<!')) {
          return new Response(JSON.stringify({
            error: 'Steam devolvió HTML en vez de JSON (posible captcha o bloqueo).',
            blocked: true
          }), { status: 503, headers: CORS });
        }

        const wlRaw = JSON.parse(text);

        // Transformar a array con campos relevantes
        const games = [];
        for (const [appId, info] of Object.entries(wlRaw)) {
          games.push({
            appId,
            name: info.name || '',
            discount_percent: info.discount_percent || 0,
            original_price: info.original_price || 0,
            final_price: info.final_price || 0,
            currency: info.currency || 'USD'
          });
        }

        return new Response(JSON.stringify({ totalGames: games.length, games }), { headers: CORS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    // ── Process a single game: find deal price + CheapShark + Reviews ──
    async function processGame(appId, cc, ctx, dbg) {
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
          return { deal: null, failed: true };
        }

        const steamData = await steamRes.json();

        if (!(steamData[appId] && steamData[appId].success && steamData[appId].data)) {
          return { deal: null, failed: false }; // success:false or no data, not a real failure
        }

        const priceInfo = findBestPrice(steamData[appId].data, cc);

        if (priceInfo) {
          let gameName = steamData[appId].data.name;
          let lowestEverUsd = null;
          let maxDiscountUs = null;

          if (debug) {
            if (priceInfo.source !== 'individual') {
              dbg.errors.push({ appId, api: 'appdetails', info: `Deal found via ${priceInfo.source} (not individual price)` });
            }
          }

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

          if (debug) gameDbg.dealFound = true;

          return {
            deal: {
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
            },
            failed: false
          };
        }

        return { deal: null, failed: false };
      } catch (e) {
        if (debug) { dbg.errors.push({ appId, api: 'appdetails', error: e.message }); }
        console.error("Error procesando juego " + appId + ": " + e.message);
        return { deal: null, failed: true };
      } finally {
        if (debug) { gameDbg.totalMs = gameDbg.calls.reduce((s, c) => s + c.ms, 0); dbg.games.push(gameDbg); }
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
        const result = await processGame(appId, cc, ctx, dbg);
        if (result.deal) deals.push(result.deal);
        if (result.failed) failedAppIds.push(appId);
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
        const result = await processGame(appId, cc, ctx, dbg);
        if (result.deal) deals.push(result.deal);
        if (result.failed) failedAppIds.push(appId);
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
