export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');

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

                // 1) Buscar gameID interno en Cheapshark
                try {
                  const csSearchUrl = `https://www.cheapshark.com/api/1.0/games?steamAppID=${appId}&limit=1`;
                  const csSearchRes = await fetch(csSearchUrl);
                  if (csSearchRes.ok) {
                    const csSearchData = await csSearchRes.json();
                    if (csSearchData.length > 0 && csSearchData[0].gameID) {
                      const csGameId = csSearchData[0].gameID;

                      // 2) Obtener precio historico con gameID
                      const csGameUrl = `https://www.cheapshark.com/api/1.0/games?id=${csGameId}`;
                      const csGameRes = await fetch(csGameUrl);
                      if (csGameRes.ok) {
                        const csGameData = await csGameRes.json();

                        // cheapestPriceEver esta en la raiz del JSON
                        if (csGameData.cheapestPriceEver) {
                          const lowestPrice = parseFloat(csGameData.cheapestPriceEver.price);
                          if (lowestPrice > 0) {
                            lowestEverUsd = lowestPrice.toFixed(2);

                            // Buscar el deal de Steam (storeID=1) para obtener precio normal en USD
                            const steamDeal = (csGameData.deals || []).find(d => String(d.storeID) === '1');
                            const normalPrice = steamDeal ? parseFloat(steamDeal.retailPrice) : 0;

                            if (normalPrice > 0) {
                              maxDiscountUs = Math.round((1 - (lowestPrice / normalPrice)) * 100);
                            }
                          }
                        }
                      }
                    }
                  }
                } catch (csErr) {
                  // Si Cheapshark falla, seguimos sin dato historico
                  console.error("CheapShark error for " + appId + ": " + csErr.message);
                }

                deals.push({
                  appId: appId,
                  name: gameName,
                  steamPrice: (priceInfo.final / 100).toFixed(2),
                  originalPrice: (priceInfo.initial / 100).toFixed(2),
                  discount: priceInfo.discount_percent,
                  currency: priceInfo.currency || 'USD',
                  lowestEverUsd: lowestEverUsd,
                  maxDiscountUs: maxDiscountUs
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
