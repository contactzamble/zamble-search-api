import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('zamble-search-api', () => {
	it('renvoie 400 si le paramètre q est manquant', async () => {
		const request = new IncomingRequest('http://example.com/search');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('renvoie 404 pour une route inconnue', async () => {
		const request = new IncomingRequest('http://example.com/autre-chose');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('renvoie des résultats mockés triés par prix croissant pour /search?q=', async () => {
		const request = new IncomingRequest('http://example.com/search?q=lego%20star%20wars');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			query: string;
			mock: boolean;
			results: { source: string; price: number; mock: boolean }[];
		};
		expect(body.query).toBe('lego star wars');
		expect(body.mock).toBe(true);
		expect(body.results.length).toBe(8);
		expect(body.results.some((r) => r.source === 'amazon')).toBe(true);
		expect(body.results.some((r) => r.source === 'ebay')).toBe(true);
		// Le flag global `mock` est vrai dès qu'une source manque de clés, mais
		// chaque annonce porte aussi son propre flag (ici toutes mockées, faute
		// de clés Amazon/eBay dans l'environnement de test).
		expect(body.results.every((r) => r.mock === true)).toBe(true);

		const prices = body.results.map((r) => r.price);
		const sorted = [...prices].sort((a, b) => a - b);
		expect(prices).toEqual(sorted);
	});

	it('répond aux requêtes OPTIONS avec les en-têtes CORS (origine par défaut)', async () => {
		const request = new IncomingRequest('http://example.com/search', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://zamble.fr');
	});

	it('autorise une origine supplémentaire présente dans ALLOWED_ORIGINS', async () => {
		const request = new IncomingRequest('http://example.com/search', {
			method: 'OPTIONS',
			headers: { Origin: 'https://zamble-scan.pages.dev' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, ALLOWED_ORIGINS: 'https://zamble.fr,https://zamble-scan.pages.dev' },
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://zamble-scan.pages.dev');
	});

	it('retombe sur la première origine autorisée si Origin ne correspond à rien', async () => {
		const request = new IncomingRequest('http://example.com/search', {
			method: 'OPTIONS',
			headers: { Origin: 'https://site-inconnu.example' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, ALLOWED_ORIGINS: 'https://zamble.fr,https://zamble-scan.pages.dev' },
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://zamble.fr');
	});

	it('renvoie 401 sur /price sans jeton interne valide', async () => {
		const request = new IncomingRequest('http://example.com/price?source=ebay&itemId=123');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, INTERNAL_API_TOKEN: 'secret' }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('renvoie 400 sur /price pour une source invalide', async () => {
		const request = new IncomingRequest('http://example.com/price?source=cdiscount&itemId=123', {
			headers: { 'X-Internal-Token': 'secret' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, INTERNAL_API_TOKEN: 'secret' }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('renvoie un prix mocké sur /price avec un jeton valide', async () => {
		const request = new IncomingRequest('http://example.com/price?source=ebay&itemId=407067427636', {
			headers: { 'X-Internal-Token': 'secret' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, INTERNAL_API_TOKEN: 'secret' }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as { source: string; itemId: string; mock: boolean; price: number };
		expect(body.source).toBe('ebay');
		expect(body.itemId).toBe('407067427636');
		expect(body.mock).toBe(true);
		expect(typeof body.price).toBe('number');
	});
});
