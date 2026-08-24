import { type Listing, type Source, seededRandom, titleCase } from "./base";

/**
 * Client eBay Browse API (recherche, OAuth2 client credentials) + lien tracké
 * manuel (format Affiliate API classique : mkevt/mkcid/campid en query params).
 *
 * Mode mock tant que EBAY_APP_ID ou EBAY_CERT_ID ne sont pas renseignés. Le lien
 * d'affiliation ne rapporte de commission qu'une fois eBay Partner Network
 * approuvé (EBAY_CAMPAIGN_ID renseigné) — sinon on renvoie l'URL de l'annonce
 * telle quelle (pas de tag cassé), voir project_revenus_passifs en mémoire pour
 * le statut de l'approbation.
 */

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Persiste entre invocations "chaudes" du même isolate Worker — évite de
// redemander un token OAuth à chaque requête (durée de vie ~2h côté eBay).
let cachedToken: CachedToken | null = null;

export class EbaySource implements Source {
  private appId: string;
  private certId: string;
  private campaignId: string;
  private mock: boolean;

  constructor(env: { EBAY_APP_ID?: string; EBAY_CERT_ID?: string; EBAY_CAMPAIGN_ID?: string }) {
    this.appId = env.EBAY_APP_ID ?? "";
    this.certId = env.EBAY_CERT_ID ?? "";
    this.campaignId = env.EBAY_CAMPAIGN_ID ?? "";
    this.mock = !this.appId || !this.certId;
  }

  async search(keyword: string): Promise<Listing[]> {
    if (this.mock) return this.searchMock(keyword);

    const token = await this.getAccessToken();
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    url.searchParams.set("q", keyword);
    url.searchParams.set("limit", "4");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
      },
    });

    if (!response.ok) {
      throw new Error(`eBay Browse API a répondu ${response.status}`);
    }

    const data = (await response.json()) as {
      itemSummaries?: { title: string; price?: { value: string }; itemWebUrl: string }[];
    };

    return (data.itemSummaries ?? [])
      .filter((item) => item.price?.value)
      .map((item) => ({
        source: "ebay" as const,
        title: item.title,
        price: Number(item.price?.value),
        url: item.itemWebUrl,
        affiliateUrl: this.buildAffiliateUrl(item.itemWebUrl),
      }));
  }

  private buildAffiliateUrl(itemUrl: string): string {
    if (!this.campaignId) return itemUrl;
    const url = new URL(itemUrl);
    url.searchParams.set("mkevt", "1");
    url.searchParams.set("mkcid", "1");
    url.searchParams.set("siteid", "71");
    url.searchParams.set("campid", this.campaignId);
    return url.toString();
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 30_000) {
      return cachedToken.token;
    }

    const credentials = btoa(`${this.appId}:${this.certId}`);
    const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope",
      }),
    });

    if (!response.ok) {
      throw new Error(`Authentification eBay OAuth2 échouée (${response.status})`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return cachedToken.token;
  }

  private searchMock(keyword: string): Listing[] {
    const rand = seededRandom(`ebay:${keyword}`);
    const basePrice = 35 + rand() * 340;
    const listings: Listing[] = [];
    for (let i = 0; i < 4; i++) {
      const noise = -0.4 + rand() * 0.55;
      const price = Math.round(basePrice * (1 + noise) * 100) / 100;
      listings.push({
        source: "ebay",
        title: `${titleCase(keyword)} - annonce mock #${i + 1}`,
        price,
        url: `https://www.ebay.fr/itm/MOCK${i}`,
        affiliateUrl: `https://www.ebay.fr/itm/MOCK${i}?campid=${this.campaignId || "CAMPID_MANQUANT"}`,
      });
    }
    return listings;
  }
}
