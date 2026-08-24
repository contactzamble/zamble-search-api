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
