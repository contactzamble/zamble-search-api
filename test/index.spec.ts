import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("zamble-search-api", () => {
	it("renvoie 400 si le paramètre q est manquant", async () => {
		const request = new IncomingRequest("http://example.com/search");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it("renvoie 404 pour une route inconnue", async () => {
		const request = new IncomingRequest("http://example.com/autre-chose");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it("renvoie des résultats mockés triés par prix croissant pour /search?q=", async () => {
		const request = new IncomingRequest("http://example.com/search?q=lego%20star%20wars");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			query: string;
			mock: boolean;
			results: { source: string; price: number }[];
		};
		expect(body.query).toBe("lego star wars");
		expect(body.mock).toBe(true);
		expect(body.results.length).toBe(8);
		expect(body.results.some((r) => r.source === "amazon")).toBe(true);
		expect(body.results.some((r) => r.source === "ebay")).toBe(true);

		const prices = body.results.map((r) => r.price);
		const sorted = [...prices].sort((a, b) => a - b);
		expect(prices).toEqual(sorted);
	});

	it("répond aux requêtes OPTIONS avec les en-têtes CORS", async () => {
		const request = new IncomingRequest("http://example.com/search", { method: "OPTIONS" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://zamble.fr");
	});
});
