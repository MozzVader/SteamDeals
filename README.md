<p align="center">
  <img src="https://svgshare.com/i/18E7.svg" alt="WishlistDeals Logo" width="280">
</p>

<h3 align="center">Monitor de ofertas de Steam en tiempo real para tu wishlist</h3>

<p align="center">
  <img src="https://img.shields.io/badge/frontend-GitHub%20Pages-black?style=flat-square" alt="Frontend">
  <img src="https://img.shields.io/badge/backend-Cloudflare%20Workers-orange?style=flat-square" alt="Backend">
  <img src="https://img.shields.io/badge/auth-Steam%20OpenID%202.0-1b2838?style=flat-square&labelColor=66c0f4" alt="Auth">
  <img src="https://img.shields.io/badge/costo-$0%2Fmes-00E205?style=flat-square" alt="Free">
</p>

---

## Que es WishlistDeals?

WishlistDeals es una app web que rastrea tu wishlist de Steam y te muestra **solo los juegos que estan en oferta**, comparando los precios actuales contra el historico de precios mas bajo de todos los tiempos (via CheapShark). Incluye scores de reviews, un carrito de compras con presupuesto, y deteccion de cambios entre sesiones.

No necesitas instalar nada, no necesita base de datos, no necesita un servidor propio. Todo corre en el browser del usuario + un Cloudflare Worker que hace de proxy/API.

**Demo**: [https://mozzvader.github.io/SteamDeals/](https://mozzvader.github.io/SteamDeals/)

---

## Como funciona

### Arquitectura

```
[ Browser (GitHub Pages) ]
        |
        |-- Scrape wishlist ----> [ Cloudflare Worker ] --scrape--> steamcommunity.com
        |-- Fallback API key --> [ Cloudflare Worker ] --API----> api.steampowered.com
        |-- Precios/appdetails -> [ Cloudflare Worker ] --------> store.steampowered.com
        |-- Reviews             -> [ Cloudflare Worker ] --------> store.steampowered.com
        |-- Historico precios   -> [ Cloudflare Worker ] --------> cheapshark.com
        |-- Login Steam OpenID  -> [ Cloudflare Worker ] -------> steamcommunity.com/openid
        |-- Perfil usuario      -> [ Cloudflare Worker ] -------> steamcommunity.com/profiles
```

### Flujo principal

1. **Login con Steam** (OpenID 2.0) — obtiene tu Steam64 ID automaticamente. Sin registro, sin password.
2. **Obtener wishlist** — scrapea el HTML de tu wishlist publica. Si Steam rate-limitea (429), pide tu API Key como fallback.
3. **Enriquecer datos** — para cada juego en oferta: precio actual, descuento, precio historico mas bajo (CheapShark), score de reviews (Steam).
4. **Mostrar resultados** — cards con cover, precio, barras comparativas, badges historicos, y review dots con glow.
5. **Carrito** — selecciona juegos y lleva un total con control de presupuesto.

### Metodos de obtencion de la wishlist

| Metodo | Requiere API Key? | Velocidad | Limitacion |
|---|---|---|---|
| **Scrape** (primario) | No | Rapido | Puede ser rate-limited (429) por IPs de Cloudflare |
| **Steam Web API** (fallback) | Si | Siempre funciona | Necesitas generar una API Key en steamcommunity.com/dev |

### Caché

| Dato | Donde | TTL |
|---|---|---|
| Resultados completos | localStorage (browser) | 6hs (se invalida a las 14hs AR) |
| Reviews de Steam | Cloudflare Cache API | 7 dias |
| Precio historico (CheapShark) | Cloudflare Cache API | 12hs |

---

## Tecnologias

- **Frontend**: HTML + CSS + JavaScript vanilla. Cero dependencias de build, cero framework.
- **Backend**: Cloudflare Worker (serverless, cold start, gratis)
- **Auth**: Steam OpenID 2.0
- **Hosting**: GitHub Pages (frontend) + Cloudflare Workers (API)
- **Estilo**: Dark theme con dot grid, Font Awesome icons, CSS-only price bars (sin Chart.js)
- **Datos**: Steam Store API + CheapShark API + Steam Community

---

## Estructura del proyecto

```
SteamDeals/
  index.html    -- App completa (frontend, UI, logica JS, estilos CSS)
  worker.js     -- Cloudflare Worker (proxy, scraping, cache, OpenID)
  README.md     -- Este archivo
  ROADMAP.md    -- Ideas y mejoras futuras
```

Si, toda la app esta en dos archivos.

---

## Worker API Reference

Endpoint base: `https://steamdeals.mozz05.workers.dev/`

| Param `mode` | Descripcion | Parametros adicionales |
|---|---|---|
| `scrape` | Obtiene appids scrapeando el HTML de la wishlist | `profile` (vanity ID o steam64) |
| `wishlist` | Obtiene appids via Steam Web API | `steamid`, `apikey` |
| `deals` | Enriquece lote de appids con precios e info | `appids` (comma-sep), `cc` (country code) |
| `retry` | Igual que `deals` pero con delays para rate-limited | `appids` (comma-sep), `cc` |
| `profile` | Obtiene avatar + nombre de un perfil publico | `steamid` |
| (sin `mode`) | `action=login` redirige a Steam OpenID | — |
| (sin `mode`) | `action=callback` recibe el callback de Steam | (parametros OpenID) |

---

## Steam OpenID Login

El flujo de autenticacion usa OpenID 2.0 de Steam:

```
1. Usuario hace click en "Steam" --> Worker redirige a steamcommunity.com/openid/login
2. Usuario autoriza en Steam --> Steam redirige de vuelta al Worker con assertion firmada
3. Worker verifica la firma con Steam (POST check_authentication)
4. Si valida: extrae Steam64 ID del claimed_id --> redirige al frontend con ?steamid=xxx
5. Frontend guarda el ID, carga el perfil (avatar + nombre), y auto-inicia la busqueda
```

**Importante**: OpenID solo identifica al usuario y proporciona su Steam64 ID. No proporciona sesiones, cookies, ni permisos adicionales para acceder a la API de Steam.

---

## Problemas conocidos (por que no es un IsThereAnyDeal)

### Rate Limiting de Steam (429)
Las IPs de salida de Cloudflare Workers estan compartidas entre todos los desarrolladores que usan la plataforma. Steam las tiene rate-limited por exceso de peticiones. El scrape de la wishlist puede fallar con 429, aunque funcione perfectamente desde un browser o una extension.

**Mitigacion actual**: 3 reintentos con delays crecientes (0s, 5s, 15s). Si falla, cae al fallback con API Key.

### Cache API por PoP
El Cache API de Cloudflare (`caches.default`) no es global — esta fragmentado por nodo perimetral (Point of Presence). Un cache hit en Buenos Aires no sirve en Santiago. Para cachear globalmente se necesitaria Cloudflare KV (que requiere configuracion adicional).

### Precios limitados a Steam Store
No comparamos precios de Humble Bundle, Fanatical, Green Man Gaming, ni otros stores. Solo Steam + CheapShark como referencia historica.

---

## Configuracion

### Variables de entorno (Worker)

No hay variables de entorno obligatorias. Los valores estan hardcodeados en `worker.js`:

```javascript
const REALM = 'https://steamdeals.mozz05.workers.dev';     // URL del Worker
const FRONTEND_URL = 'https://mozzvader.github.io/SteamDeals/index.html'; // URL del frontend
```

Si deployas en otra URL, actualiza estos valores.

### Deploy

1. **Frontend**: Subi `index.html` a GitHub Pages (o cualquier host estatico).
2. **Worker**: Crear un Cloudflare Worker, pegar el contenido de `worker.js`.
3. Actualizar `WORKER_URL` en `index.html` con la URL de tu Worker.
4. Actualizar `FRONTEND_URL` en `worker.js` con la URL de tu frontend.

---

## Licencia

Libre de usar, modificar, y romper como te plazca. Si te sirve, un cafecito en [cafecito.app/mozz_vader](https://cafecito.app/mozz_vader) siempre ayuda.

---

<p align="center">
  <a href="https://github.com/MozzVader/SteamDeals">
    <img src="https://img.shields.io/badge/GitHub-MozzVader%2FSteamDeals-181717?style=for-the-badge&logo=github" alt="Repo">
  </a>
</p>
