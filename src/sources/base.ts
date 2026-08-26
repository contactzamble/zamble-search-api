export interface Listing {
	source: 'amazon' | 'ebay';
	title: string;
	price: number;
	url: string;
	affiliateUrl: string;
	/**
	 * true si ce résultat vient du générateur mock (clés absentes pour CETTE
	 * source), indépendamment du flag global `mock` de la réponse (qui est
	 * true dès qu'UNE SEULE des deux sources est mockée — ne suffit pas à
	 * distinguer "eBay réel + Amazon mock" de "les deux mockés").
	 */
	mock: boolean;
}

export interface ItemPrice {
	price: number;
	url: string;
	affiliateUrl: string;
	available: boolean;
}

export interface Source {
	search(keyword: string): Promise<Listing[]>;
	getPrice(itemId: string): Promise<ItemPrice | null>;
}

/**
 * Générateur pseudo-aléatoire seedé (mulberry32) : même mot-clé => mêmes résultats,
 * pour que le mode mock soit stable et testable (calqué sur random.Random(keyword)
 * côté resellbot-backend).
 */
export function titleCase(s: string): string {
	return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}

export function seededRandom(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return function () {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}
