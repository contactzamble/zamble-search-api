import { type Listing, type Source, seededRandom, titleCase } from './base';

/**
 * Client Amazon Product Advertising API (PA API v5), requête SearchItems
 * signée AWS SigV4 (service ProductAdvertisingAPI, région eu-west-1, hôte
 * webservices.amazon.fr).
 *
 * Mode mock tant que AMAZON_ACCESS_KEY ou AMAZON_SECRET_KEY ne sont pas
 * renseignés. Non testé contre de vraies clés au moment de l'écriture :
 * l'accès à la PA API est bloqué côté Amazon tant que le compte
 * Partenaires n'a pas réalisé 10 ventes éligibles sur les 30 derniers
 * jours (voir project_zamble_comparatifs en mémoire) — à vérifier en
 * conditions réelles dès que des clés sont disponibles.
 */

const HOST = 'webservices.amazon.fr';
const REGION = 'eu-west-1';
const SERVICE = 'ProductAdvertisingAPI';
const TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';

interface PaApiItem {
	ASIN: string;
	ItemInfo?: { Title?: { DisplayValue?: string } };
	Offers?: { Listings?: { Price?: { Amount?: number } }[] };
}

export class AmazonSource implements Source {
	private accessKey: string;
	private secretKey: string;
	private partnerTag: string;
	private mock: boolean;

	constructor(env: { AMAZON_ACCESS_KEY?: string; AMAZON_SECRET_KEY?: string; AMAZON_PARTNER_TAG?: string }) {
		this.accessKey = env.AMAZON_ACCESS_KEY ?? '';
		this.secretKey = env.AMAZON_SECRET_KEY ?? '';
		this.partnerTag = env.AMAZON_PARTNER_TAG ?? '';
		this.mock = !this.accessKey || !this.secretKey;
	}

	async search(keyword: string): Promise<Listing[]> {
		if (this.mock) return this.searchMock(keyword);

		const payload = JSON.stringify({
			Keywords: keyword,
			SearchIndex: 'All',
			ItemCount: 4,
			PartnerTag: this.partnerTag,
			PartnerType: 'Associates',
			Marketplace: 'www.amazon.fr',
			Resources: ['ItemInfo.Title', 'Offers.Listings.Price'],
		});

		const { headers, body } = await this.signRequest(payload);
		const response = await fetch(`https://${HOST}/paapi5/searchitems`, { method: 'POST', headers, body });

		if (!response.ok) {
			throw new Error(`Amazon PA API a répondu ${response.status}`);
		}

		const data = (await response.json()) as { SearchResult?: { Items?: PaApiItem[] } };

		return (data.SearchResult?.Items ?? [])
			.filter((item) => item.Offers?.Listings?.[0]?.Price?.Amount != null)
			.map((item) => {
				const url = `https://www.amazon.fr/dp/${item.ASIN}`;
				return {
					source: 'amazon' as const,
					title: item.ItemInfo?.Title?.DisplayValue ?? item.ASIN,
					price: item.Offers!.Listings![0].Price!.Amount!,
					url,
					affiliateUrl: `${url}?tag=${this.partnerTag || 'TAG_MANQUANT'}`,
				};
			});
	}

	private async signRequest(payload: string): Promise<{ headers: Record<string, string>; body: string }> {
		const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
		const dateStamp = amzDate.slice(0, 8);

		const canonicalHeaders =
			`content-encoding:amz-1.0\n` +
			`content-type:application/json; charset=utf-8\n` +
			`host:${HOST}\n` +
			`x-amz-date:${amzDate}\n` +
			`x-amz-target:${TARGET}\n`;
		const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
		const payloadHash = await sha256Hex(payload);

		const canonicalRequest = `POST\n/paapi5/searchitems\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

		const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
		const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

		const signingKey = await getSignatureKey(this.secretKey, dateStamp, REGION, SERVICE);
		const signature = toHex(await hmacSha256(signingKey, stringToSign));

		const authorization =
			`AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, ` + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

		return {
			headers: {
				'content-encoding': 'amz-1.0',
				'content-type': 'application/json; charset=utf-8',
				host: HOST,
				'x-amz-date': amzDate,
				'x-amz-target': TARGET,
				authorization,
			},
			body: payload,
		};
	}

	private searchMock(keyword: string): Listing[] {
		const rand = seededRandom(`amazon:${keyword}`);
		const basePrice = 40 + rand() * 360;
		const listings: Listing[] = [];
		for (let i = 0; i < 4; i++) {
			const noise = -0.35 + rand() * 0.5;
			const price = Math.round(basePrice * (1 + noise) * 100) / 100;
			listings.push({
				source: 'amazon',
				title: `${titleCase(keyword)} - annonce mock #${i + 1}`,
				price,
				url: `https://www.amazon.fr/dp/MOCK${i}`,
				affiliateUrl: `https://www.amazon.fr/dp/MOCK${i}?tag=${this.partnerTag || 'TAG_MANQUANT'}`,
			});
		}
		return listings;
	}
}

async function sha256Hex(message: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
	return toHex(hash);
}

async function hmacSha256(key: BufferSource, message: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
	const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, service);
	return hmacSha256(kService, 'aws4_request');
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
