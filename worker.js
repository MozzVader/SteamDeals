export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const mode = url.searchParams.get('mode');

    const CS_HEADERS = {
      'User-Agent': 'WishlistDeals/1.0 (github.com/MozzVader/SteamDeals)'
    };
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    // ── Steam OpenID config ──
    const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
    const REALM = 'https://steamdeals.mozz05.workers.dev';
    // URL donde está alojado el index.html
    const FRONTEND_URL = 'https://mozzvader.github.io/SteamDeals/index.html';

    // ── CC → Currency code mapping ──
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

    // ══════════════════════════════════════════════════════════════
    // Steam OpenID Login
    // ══════════════════════════════════════════════════════════════

    // action=login → redirige a Steam
    if (action === 'login') {
      const returnTo = `${REALM}/?action=callback`;
      const loginUrl = `${STEAM_OPENID}?` + new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': REALM,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
      }).toString();
      return Response.redirect(loginUrl, 302);
    }

    // action=callback → Steam devuelve params por GET (query string)
    if (action === 'callback') {
      try {
        // Usar el query string crudo DIRECTO (sin searchParams)
        // para preservar el encoding y orden exacto que Steam firmó
        const rawSearch = url.search.substring(1);

        if (!rawSearch.includes('openid.mode=id_res')) {
          return new Response(
            `<html><body style="background:#111;color:#eee;font-family:monospace;padding:20px"><h2>Error: modo inesperado</h2><pre>${rawSearch}</pre><p><a href="${FRONTEND_URL}" style="color:#66c0f4">Volver</a></p></body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
          );
        }

        // Filtrar solo openid.* params, preservar encoding y orden original
        // Cambiar openid.mode=id_res → openid.mode=check_authentication
        const verifyParts = rawSearch.split('&')
          .filter(p => p.startsWith('openid.'))
          .map(p => p === 'openid.mode=id_res'
            ? 'openid.mode=check_authentication'
            : p);
        const verifyBody = verifyParts.join('&');

        const verifyRes = await fetch(STEAM_OPENID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: verifyBody
        });
        const verifyText = await verifyRes.text();

        if (verifyText.includes('is_valid:true')) {
          // Extraer steamid del claimed_id (puede estar URL-encoded con %2F)
          const claimed = rawSearch.match(/openid\.claimed_id=([^&]+)/);
          if (claimed) {
            const decoded = decodeURIComponent(claimed[1]);
            const match = decoded.match(/\/id\/(\d+)/);
            if (match) {
              return Response.redirect(`${FRONTEND_URL}?steamid=${match[1]}`, 302);
            }
          }
        }

        return new Response(
          `<html><body style="background:#111;color:#eee;font-family:monospace;padding:20px"><h2>OpenID Verification Failed</h2><pre>verifyResult:\n${verifyText}\n\nverifyBody:\n${verifyBody}\n\nrawSearch:\n${rawSearch}</pre><p><a href="${FRONTEND_URL}" style="color:#66c0f4">Volver</a></p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );

      } catch (e) {
        return new Response(
          `<html><body style="background:#111;color:#eee;font-family:monospace;padding:20px"><h2>OpenID Error</h2><pre>${e.message}</pre><p><a href="${FRONTEND_URL}" style="color:#66c0f4">Volver</a></p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
    }

    // ── Best price from appdetails (individual or package) ──
    function findBestPrice(appData, cc) {
      if (appData.price_overview && appData.price_overview.discount_percent > 0) {
        return {
          final: appData.price_overview.final,
          initial: appData.price_overview.initial,
          discount_percent: appData.price_overview.discount_percent,
          currency: appData.price_overview.currency || currencyForCc(cc),
          source: 'individual'
        };
      }
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

    // ── Cache (Cloudflare Cache API) ──
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
      const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      await cache.put(new Request(CACHE_BASE + key), res, { expirationTtl: ttlSec });
    }

    // ══════════════════════════════════════════════════════════════
    // mode=scrape: obtiene appids scrapeando el HTML de la wishlist
    // ══════════════════════════════════════════════════════════════
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
          return new Response(JSON.stringify({
            error: `HTTP ${res.status}`,
            blocked: true,
            rate_limited: res.status === 429
          }), { status: res.status, headers: CORS });
        }

        const html = await res.text();

        // Parsear g_rgWishlistData
        const startMatch = html.match(/g_rgWishlistData\s*=\s*\{/);
        if (startMatch) {
          const startIdx = startMatch.index + startMatch[0].length;
          const scriptEnd = html.indexOf('</script>', startIdx);
          const chunk = html.substring(startIdx, scriptEnd > 0 ? scriptEnd : startIdx + 500000);
          const appIds = [...chunk.matchAll(/(\d+)\s*:\s*\{/g)].map(m => m[1]);
          const unique = [...new Set(appIds)];
          if (unique.length > 0) {
            return new Response(JSON.stringify(unique), { headers: CORS });
          }
        }

        return new Response(JSON.stringify({ error: 'No se encontraron appids', blocked: true }), {
          status: 404, headers: CORS
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // mode=wishlist: obtiene appids via Steam Web API (API Key)
    // ══════════════════════════════════════════════════════════════
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

    // ══════════════════════════════════════════════════════════════
    // processGame: precio + CheapShark + Reviews
    // ══════════════════════════════════════════════════════════════
    async function processGame(appId, cc, ctx) {
      try {
        const steamRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}`);
        if (!steamRes.ok) return { deal: null, failed: true };

        const steamData = await steamRes.json();
        if (!(steamData[appId] && steamData[appId].success && steamData[appId].data)) {
          return { deal: null, failed: false };
        }

        const priceInfo = findBestPrice(steamData[appId].data, cc);
        if (!priceInfo) return { deal: null, failed: false };

        let gameName = steamData[appId].data.name;
        let lowestEverUsd = null;
        let maxDiscountUs = null;

        // CheapShark (cached 12h)
        try {
          const csKey = `cs:${appId}`;
          const cachedCs = await getCached(csKey);
          if (cachedCs !== null) {
            lowestEverUsd = cachedCs.lowestEverUsd;
            maxDiscountUs = cachedCs.maxDiscountUs;
          } else {
            const csSearchRes = await fetch(`https://www.cheapshark.com/api/1.0/games?steamAppID=${appId}&limit=1`, { headers: CS_HEADERS });
            if (csSearchRes.ok) {
              const csSearchData = await csSearchRes.json();
              if (csSearchData.length > 0 && csSearchData[0].gameID) {
                const csGameRes = await fetch(`https://www.cheapshark.com/api/1.0/games?id=${csSearchData[0].gameID}`, { headers: CS_HEADERS });
                if (csGameRes.ok) {
                  const csGameData = await csGameRes.json();
                  if (csGameData.cheapestPriceEver) {
                    const lowestPrice = parseFloat(csGameData.cheapestPriceEver.price);
                    if (lowestPrice > 0) {
                      lowestEverUsd = lowestPrice.toFixed(2);
                      const steamDeal = (csGameData.deals || []).find(d => String(d.storeID) === '1');
                      const normalPrice = steamDeal ? parseFloat(steamDeal.retailPrice) : 0;
                      if (normalPrice > 0) maxDiscountUs = Math.round((1 - (lowestPrice / normalPrice)) * 100);
                    }
                  }
                }
              }
              ctx.waitUntil(setCache(csKey, { lowestEverUsd, maxDiscountUs }, 43200));
            }
          }
        } catch (csErr) {
          console.error("CheapShark error for " + appId + ": " + csErr.message);
        }

        // Reviews (cached 7 days)
        let reviewScore = null;
        let reviewLabel = '';
        try {
          const revKey = `rev:${appId}`;
          const cachedRev = await getCached(revKey);
          if (cachedRev !== null) {
            reviewScore = cachedRev.score;
            reviewLabel = cachedRev.label;
          } else {
            const reviewRes = await fetch(`https://store.steampowered.com/appreviews/${appId}?json=1&num_per_page=0&purchase_type=all`);
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
          }
        } catch (revErr) {
          console.error('Review fetch error for ' + appId + ': ' + revErr.message);
        }

        return {
          deal: {
            appId, name: gameName,
            steamPrice: (priceInfo.final / 100).toFixed(2),
            originalPrice: (priceInfo.initial / 100).toFixed(2),
            discount: priceInfo.discount_percent,
            currency: priceInfo.currency || 'USD',
            lowestEverUsd, maxDiscountUs, reviewScore, reviewLabel
          },
          failed: false
        };

      } catch (e) {
        console.error("Error procesando juego " + appId + ": " + e.message);
        return { deal: null, failed: true };
      }
    }

    // ══════════════════════════════════════════════════════════════
    // mode=deals: enriquece lote de appids con precios + historicos
    // ══════════════════════════════════════════════════════════════
    if (mode === 'deals') {
      const appIdsStr = url.searchParams.get('appids');
      const cc = url.searchParams.get('cc') || 'us';
      if (!appIdsStr) return new Response('Faltan appids', { status: 400 });

      const appIds = appIdsStr.split(',');
      const deals = [];
      const failedAppIds = [];

      for (const appId of appIds) {
        const result = await processGame(appId, cc, ctx);
        if (result.deal) deals.push(result.deal);
        if (result.failed) failedAppIds.push(appId);
        await new Promise(r => setTimeout(r, 350));
      }

      return new Response(JSON.stringify({ deals, failedAppIds }), { headers: CORS });
    }

    // ══════════════════════════════════════════════════════════════
    // mode=retry: reintentos con delay más largo para rate-limited
    // ══════════════════════════════════════════════════════════════
    if (mode === 'retry') {
      const appIdsStr = url.searchParams.get('appids');
      const cc = url.searchParams.get('cc') || 'us';
      if (!appIdsStr) return new Response('Faltan appids', { status: 400, headers: CORS });

      const appIds = appIdsStr.split(',');
      const deals = [];
      const failedAppIds = [];

      for (let idx = 0; idx < appIds.length; idx++) {
        const result = await processGame(appIds[idx], cc, ctx);
        if (result.deal) deals.push(result.deal);
        if (result.failed) failedAppIds.push(appIds[idx]);
        if (idx < appIds.length - 1) await new Promise(r => setTimeout(r, 2000));
      }

      return new Response(JSON.stringify({ deals, failedAppIds }), { headers: CORS });
    }

    return new Response('Modo no válido', { status: 400 });
  }
};
