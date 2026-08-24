import { AmazonSource } from './sources/amazon';
import { EbaySource } from './sources/ebay';
import type { Listing } from './sources/base';

export interface Env {
	AMAZON_ACCESS_KEY?: string;
	AMAZON_SECRET_KEY?: string;
	AMAZON_PARTNER_TAG?: string;
	EBAY_APP_ID?: string;
	EBAY_CERT_ID?: string;
	EBAY_CAMPAIGN_ID?: string;
	ALLOWED_ORIGIN?: string;
	INTERNAL_API_TOKEN?: string;
}

function corsHeaders(origin: string): HeadersInit {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const allowedOrigin = env.ALLOWED_ORIGIN ?? 'https://zamble.fr';
		const headers = corsHeaders(allowedOrigin);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers });
		}

		const url = new URL(request.url);

		if (url.pathname === '/price') {
			return handlePrice(request, url, env);
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
