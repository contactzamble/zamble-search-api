import { seededRandom } from './base';

/**
 * Client Google Cloud Vision (Web Detection) pour la reconnaissance de
 * couverture par photo. Mode mock tant que GOOGLE_VISION_API_KEY n'est pas
 * renseignée — même convention que AmazonSource/EbaySource.
 */

export interface VisionResult {
	label: string | null;
	thumbnailUrl: string | null;
	mock: boolean;
}

interface WebDetectionResponse {
	responses?: {
		webDetection?: {
			bestGuessLabels?: { label?: string }[];
			webEntities?: { description?: string; score?: number }[];
			pagesWithMatchingImages?: { pageTitle?: string }[];
			visuallySimilarImages?: { url?: string }[];
		};
		error?: { message?: string };
	}[];
}

const MOCK_LABELS = [
	'Le Seigneur des Anneaux - tome 1',
	'Astérix - Le Combat des Chefs',
	'Catan - jeu de société',
	"Harry Potter à l'école des sorciers",
	'Les Aventures de Tintin - Objectif Lune',
	'7 Wonders - jeu de société',
	'Le Petit Prince',
	'Dixit - jeu de société',
];

export class VisionSource {
	private apiKey: string;
	private mock: boolean;

	constructor(env: { GOOGLE_VISION_API_KEY?: string }) {
		this.apiKey = env.GOOGLE_VISION_API_KEY ?? '';
		this.mock = !this.apiKey;
	}

	get isMock(): boolean {
		return this.mock;
	}

	async identify(base64Image: string): Promise<VisionResult> {
		if (this.mock) return this.identifyMock(base64Image);

		const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${this.apiKey}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				requests: [
					{
						image: { content: base64Image },
						features: [{ type: 'WEB_DETECTION', maxResults: 8 }],
					},
				],
			}),
		});

		if (!response.ok) {
			throw new Error(`Google Vision API a répondu ${response.status}`);
		}

		const data = (await response.json()) as WebDetectionResponse;
		const first = data.responses?.[0];
		if (first?.error) {
			throw new Error(`Google Vision API a renvoyé une erreur : ${first.error.message ?? 'inconnue'}`);
		}

		const web = first?.webDetection;
		// Priorité : une page où Google a retrouvé LA MÊME image (signal le plus
		// fiable — souvent une fiche produit/librairie avec un titre précis) >
		// l'entité web la mieux notée (identification sémantique) > le "best
		// guess" de Google, qui est un résumé générique et se rabat souvent sur
		// une catégorie vague (ex. "art") quand l'objet précis n'est pas reconnu.
		const bestEntity = [...(web?.webEntities ?? [])]
			.filter((e) => e.description)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
		const label = web?.pagesWithMatchingImages?.[0]?.pageTitle ?? bestEntity?.description ?? web?.bestGuessLabels?.[0]?.label ?? null;
		const thumbnailUrl = web?.visuallySimilarImages?.[0]?.url ?? null;

		return { label, thumbnailUrl, mock: false };
	}

	private identifyMock(base64Image: string): VisionResult {
		const rand = seededRandom(`vision:${base64Image.slice(0, 64)}`);
		const label = MOCK_LABELS[Math.floor(rand() * MOCK_LABELS.length)];
		return { label, thumbnailUrl: null, mock: true };
	}
}
