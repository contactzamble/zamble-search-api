import { AmazonSource } from './sources/amazon';
import { EbaySource } from './sources/ebay';
import { VisionSource } from './sources/vision';
import type { Listing } from './sources/base';
import { DEFAULT_VISION_QUOTA, incrementQuota, readQuota } from './quota';

export interface Env {
	AMAZON_ACCESS_KEY?: string;
	AMAZON_SECRET_KEY?: string;
	AMAZON_PARTNER_TAG?: string;
	EBAY_APP_ID?: string;
	EBAY_CERT_ID?: string;
	EBAY_CAMPAIGN_ID?: string;
	GOOGLE_VISION_API_KEY?: string;
	GOOGLE_BOOKS_API_KEY?: string;
	VISION_MONTHLY_QUOTA?: string;
	VISION_QUOTA_KV: KVNamespace;
	LOOKUP_CACHE_KV: KVNamespace;
	/** @deprecated remplacé par ALLOWED_ORIGINS (liste), gardé pour compat descendante */
	ALLOWED_ORIGIN?: string;
	/** Liste blanche d'origines autorisées en CORS, séparées par des virgules */
	ALLOWED_ORIGINS?: string;
	INTERNAL_API_TOKEN?: string;
}

// Taille max acceptée pour une image encodée en base64 (~2 Mo binaire réel) —
// borne à la fois l'abus d'upload et la taille de la requête vers Vision.
const MAX_IMAGE_BASE64_LENGTH = 2_800_000;

// Message unique, quel que soit le service externe qui a atteint sa limite
// (Vision, Google Books, UPCitemdb...) — principe voulu : tout reste gratuit
// tant qu'aucune limite n'est touchée, et le jour où une limite l'est (peu
// importe laquelle), même message partout. Base d'une future monétisation
// par abonnement plutôt qu'un blocage brut.
const FREE_QUOTA_MESSAGE =
	"Vous avez atteint le nombre de requêtes maximal pour un usage en mode gratuit. Pour repousser cette limite, abonnez-vous à l'option de votre choix.";

const DEFAULT_ORIGIN = 'https://zamble.fr';

function resolveAllowedOrigins(env: Env): string[] {
	if (env.ALLOWED_ORIGINS) {
		return env.ALLOWED_ORIGINS.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (env.ALLOWED_ORIGIN) return [env.ALLOWED_ORIGIN];
	return [DEFAULT_ORIGIN];
}

function corsHeaders(origin: string): HeadersInit {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		Vary: 'Origin',
	};
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const allowedOrigins = resolveAllowedOrigins(env);
		const requestOrigin = request.headers.get('Origin');
		const allowedOrigin = requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
		const headers = corsHeaders(allowedOrigin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers });
		}

		const url = new URL(request.url);

		if (url.pathname === '/price') {
			return handlePrice(request, url, env);
		}

		if (url.pathname === '/vision-search') {
			return handleVisionSearch(request, env, headers);
		}

		if (url.pathname === '/product-lookup') {
			return handleProductLookup(url, env, headers);
		}

		if (url.pathname === '/book-lookup') {
			return handleBookLookup(url, env, headers);
		}

		if (url.pathname !== '/search') {
			return new Response('Not found', { status: 404, headers });
		}

		const q = url.searchParams.get('q')?.trim();
		if (!q) {
			return new Response(JSON.stringify({ error: "Paramètre 'q' manquant" }), {
				status: 400,
				headers: { ...headers, 'Content-Type': 'application/json' },
			});
		}

		const amazon = new AmazonSource(env);
		const ebay = new EbaySource(env);
		const mock = !env.AMAZON_ACCESS_KEY || !env.AMAZON_SECRET_KEY || !env.EBAY_APP_ID || !env.EBAY_CERT_ID;

		// Promise.allSettled plutôt que Promise.all : une source qui échoue (clé
		// invalide, API indisponible) ne doit pas faire tomber les résultats de
		// l'autre source ni renvoyer une 500 au site.
		const settled = await Promise.allSettled([amazon.search(q), ebay.search(q)]);
		const listings: Listing[] = settled
			.filter((r): r is PromiseFulfilledResult<Listing[]> => r.status === 'fulfilled')
			.flatMap((r) => r.value)
			.sort((a, b) => a.price - b.price);
		const errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason));

		return new Response(JSON.stringify({ query: q, mock, results: listings, errors }), {
			headers: { ...headers, 'Content-Type': 'application/json' },
		});
	},
} satisfies ExportedHandler<Env>;

/**
 * Prix courant d'un item précis (ASIN Amazon / legacy item id eBay). Route
 * serveur-à-serveur uniquement (job de suivi de prix Supabase) : pas de CORS
 * navigateur, protégée par un jeton partagé plutôt que restreinte par origine.
 */
async function handlePrice(request: Request, url: URL, env: Env): Promise<Response> {
	const jsonHeaders = { 'Content-Type': 'application/json' };

	const token = request.headers.get('X-Internal-Token');
	if (!env.INTERNAL_API_TOKEN || token !== env.INTERNAL_API_TOKEN) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: jsonHeaders });
	}

	const source = url.searchParams.get('source');
	const itemId = url.searchParams.get('itemId')?.trim();
	if (source !== 'amazon' && source !== 'ebay') {
		return new Response(JSON.stringify({ error: "Paramètre 'source' invalide (amazon|ebay attendu)" }), {
			status: 400,
			headers: jsonHeaders,
		});
	}
	if (!itemId) {
		return new Response(JSON.stringify({ error: "Paramètre 'itemId' manquant" }), { status: 400, headers: jsonHeaders });
	}

	const client = source === 'amazon' ? new AmazonSource(env) : new EbaySource(env);
	const mock = source === 'amazon' ? !env.AMAZON_ACCESS_KEY || !env.AMAZON_SECRET_KEY : !env.EBAY_APP_ID || !env.EBAY_CERT_ID;

	try {
		const result = await client.getPrice(itemId);
		if (!result) {
			return new Response(JSON.stringify({ error: 'Item not found or delisted' }), { status: 404, headers: jsonHeaders });
		}
		return new Response(JSON.stringify({ source, itemId, mock, ...result }), { headers: jsonHeaders });
	} catch (err) {
		return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: jsonHeaders });
	}
}

/**
 * Nom + marque d'un produit générique (jeu, jouet...) à partir de son code-barres
 * EAN/UPC, via UPCitemdb (API trial, gratuite, sans clé, limitée à 100 requêtes/jour
 * partagées par IP). Contrairement à /search, jamais d'erreur dure côté client :
 * un échec (produit inconnu, quota trial dépassé, panne réseau) renvoie des champs
 * null plutôt qu'un 4xx/5xx — ce lookup n'est qu'un enrichissement facultatif du
 * titre déjà connu (le code brut scanné), jamais bloquant pour l'appli. Seule
 * exception : un 429 (quota des 100 requêtes/jour épuisé) est distingué d'un
 * simple "produit inconnu" via `quotaExceeded`, pour que le frontend affiche
 * le message d'abonnement plutôt que "produit non trouvé" (trompeur ici).
 */
/**
 * Nettoie un titre brut UPCitemdb : les données de certains revendeurs
 * collent marque/nom/référence/langue sans espaces (ex. "Tokyo51315french
 * version"), ce qui casse la recherche côté Vinted/Google. Ne retire aucune
 * information (un numéro peut être l'info clé pour un autre objet, ex. un
 * set LEGO) — corrige juste l'espacement et enlève la marque si elle est
 * déjà répétée en préfixe (affichée séparément comme éditeur ailleurs dans
 * l'appli, la garder ici ferait doublon dans la requête de recherche).
 */
function cleanProductTitle(rawTitle: string, brand: string | null): string {
	let title = rawTitle
		.replace(/([a-zà-ÿ])([A-ZÀ-Ÿ0-9])/g, '$1 $2')
		.replace(/([0-9])([A-Za-zÀ-ÿ])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim();

	if (brand) {
		const prefixMatch = title.match(/^([\s:.\-]*)/);
		const withoutLeadingPunct = title.slice(prefixMatch ? prefixMatch[0].length : 0);
		if (withoutLeadingPunct.toLowerCase().startsWith(brand.toLowerCase())) {
			title = withoutLeadingPunct
				.slice(brand.length)
				.replace(/^[\s:.\-]+/, '')
				.trim() || title;
		}
	}

	return title;
}

/**
 * Cache KV partagé (tous utilisateurs confondus) des lookups produit/livre
 * déjà résolus avec succès — un code-barre/ISBN identifie une fiche
 * catalogue essentiellement immuable (titre/auteur/éditeur ne changent pas),
 * donc un cache permanent (pas de TTL) est sûr et fait durer beaucoup plus
 * longtemps les quotas gratuits externes (UPCitemdb 100/jour, Google Books).
 * Volontairement PAS de cache sur un échec/quota dépassé : un raté est
 * souvent transitoire (429, 503 intermittent de Google Books...), le
 * mettre en cache figerait un faux "introuvable" pour toujours.
 */
async function readLookupCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
	const cached = await kv.get(key);
	return cached ? (JSON.parse(cached) as T) : null;
}
async function writeLookupCache(kv: KVNamespace, key: string, value: unknown): Promise<void> {
	await kv.put(key, JSON.stringify(value));
}

async function handleProductLookup(url: URL, env: Env, headers: HeadersInit): Promise<Response> {
	const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
	const upc = url.searchParams.get('upc')?.trim();
	if (!upc) {
		return new Response(JSON.stringify({ error: "Paramètre 'upc' manquant" }), { status: 400, headers: jsonHeaders });
	}

	const cacheKey = `upc:${upc}`;
	const cached = await readLookupCache<{ title: string; brand: string | null }>(env.LOOKUP_CACHE_KV, cacheKey);
	if (cached) {
		return new Response(JSON.stringify(cached), { headers: jsonHeaders });
	}

	try {
		const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
		if (response.status === 429) {
			return new Response(
				JSON.stringify({ title: null, brand: null, quotaExceeded: true, message: FREE_QUOTA_MESSAGE }),
				{ headers: jsonHeaders }
			);
		}
		if (!response.ok) {
			return new Response(JSON.stringify({ title: null, brand: null }), { headers: jsonHeaders });
		}
		const data = (await response.json()) as { items?: { title?: string; brand?: string }[] };
		const item = data.items?.[0];
		const brand = item?.brand || null;
		const title = item?.title ? cleanProductTitle(item.title, brand) : null;
		const result = { title, brand };
		if (title) await writeLookupCache(env.LOOKUP_CACHE_KV, cacheKey, result);
		return new Response(JSON.stringify(result), { headers: jsonHeaders });
	} catch {
		return new Response(JSON.stringify({ title: null, brand: null }), { headers: jsonHeaders });
	}
}

/**
 * Titre/auteur(s)/éditeur/couverture d'un livre par ISBN, via Google Books.
 * Filet de sécurité côté serveur pour quand Open Library (appelé directement
 * par le navigateur, sans clé) ne connaît pas le livre — l'API Google Books
 * appelée SANS clé partage un quota anonyme mondial qui se retrouve à sec
 * en pratique (constaté en prod : 429 "quota_limit_value: 0"), d'où le
 * passage par une clé dédiée ici plutôt qu'un appel client direct. Même
 * philosophie best-effort que /product-lookup : jamais d'erreur dure, un
 * échec renvoie des champs null. Deux tentatives : l'API Google Books
 * elle-même s'est révélée instable en pratique (503 par intermittence,
 * observé sur ~2 appels sur 3 lors du diagnostic), pas seulement un
 * problème de quota/clé. Si les DEUX tentatives renvoient un 429 (quota du
 * projet Google Cloud dépassé), c'est distingué via `quotaExceeded` plutôt
 * que traité comme "livre inconnu".
 */
async function handleBookLookup(url: URL, env: Env, headers: HeadersInit): Promise<Response> {
	const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
	const isbn = url.searchParams.get('isbn')?.trim();
	if (!isbn) {
		return new Response(JSON.stringify({ error: "Paramètre 'isbn' manquant" }), { status: 400, headers: jsonHeaders });
	}

	const empty = { title: null, author: null, publisher: null, cover: null };

	const cacheKey = `isbn:${isbn}`;
	const cached = await readLookupCache<typeof empty>(env.LOOKUP_CACHE_KV, cacheKey);
	if (cached) {
		return new Response(JSON.stringify(cached), { headers: jsonHeaders });
	}

	if (!env.GOOGLE_BOOKS_API_KEY) {
		return new Response(JSON.stringify(empty), { headers: jsonHeaders });
	}

	try {
		const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&key=${env.GOOGLE_BOOKS_API_KEY}`;
		let response = await fetch(apiUrl);
		if (!response.ok) response = await fetch(apiUrl);
		if (!response.ok) response = await fetch(apiUrl);
		if (response.status === 429) {
			return new Response(JSON.stringify({ ...empty, quotaExceeded: true, message: FREE_QUOTA_MESSAGE }), { headers: jsonHeaders });
		}
		if (!response.ok) {
			return new Response(JSON.stringify(empty), { headers: jsonHeaders });
		}
		const data = (await response.json()) as {
			items?: { volumeInfo?: { title?: string; authors?: string[]; publisher?: string; imageLinks?: Record<string, string> } }[];
		};
		const info = data.items?.[0]?.volumeInfo;
		if (!info?.title) {
			return new Response(JSON.stringify(empty), { headers: jsonHeaders });
		}
		const cover =
			(info.imageLinks?.extraLarge || info.imageLinks?.large || info.imageLinks?.medium || info.imageLinks?.thumbnail || null)
				?.replace('http://', 'https://') || null;
		const result = {
			title: info.title,
			author: (info.authors || []).join(', ') || null,
			publisher: info.publisher || null,
			cover,
		};
		await writeLookupCache(env.LOOKUP_CACHE_KV, cacheKey, result);
		return new Response(
			JSON.stringify(result),
			{ headers: jsonHeaders }
		);
	} catch {
		return new Response(JSON.stringify(empty), { headers: jsonHeaders });
	}
}

/**
 * Reconnaissance d'une couverture de livre/jeu par photo (Google Cloud
 * Vision, Web Detection). Appelée depuis le navigateur (CORS actif,
 * contrairement à /price). Le quota mensuel est vérifié AVANT tout appel
 * réel à Vision (jamais dépassé), et incrémenté seulement APRÈS un appel
 * réel réussi (un appel qui échoue ne consomme pas de quota).
 */
async function handleVisionSearch(request: Request, env: Env, headers: HeadersInit): Promise<Response> {
	const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Méthode non autorisée (POST attendu)' }), { status: 405, headers: jsonHeaders });
	}

	let body: { image?: string };
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Corps JSON invalide' }), { status: 400, headers: jsonHeaders });
	}

	const image = body.image?.trim();
	if (!image) {
		return new Response(JSON.stringify({ error: "Champ 'image' manquant" }), { status: 400, headers: jsonHeaders });
	}
	if (image.length > MAX_IMAGE_BASE64_LENGTH) {
		return new Response(JSON.stringify({ error: 'Image trop volumineuse' }), { status: 413, headers: jsonHeaders });
	}

	const vision = new VisionSource(env);
	const limit = Number(env.VISION_MONTHLY_QUOTA) || DEFAULT_VISION_QUOTA;

	if (!vision.isMock) {
		const count = await readQuota(env.VISION_QUOTA_KV);
		if (count >= limit) {
			return new Response(
				JSON.stringify({
					error: 'quota_exceeded',
					message: FREE_QUOTA_MESSAGE,
					count,
					limit,
				}),
				{ status: 429, headers: jsonHeaders }
			);
		}
	}

	try {
		const result = await vision.identify(image);
		const count = result.mock ? await readQuota(env.VISION_QUOTA_KV) : await incrementQuota(env.VISION_QUOTA_KV);
		return new Response(JSON.stringify({ ...result, quota: { count, limit } }), { headers: jsonHeaders });
	} catch (err) {
		return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: jsonHeaders });
	}
}
