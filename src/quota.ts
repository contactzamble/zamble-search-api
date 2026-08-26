export const DEFAULT_VISION_QUOTA = 900;

/** Clé KV mensuelle, ex. "vision-quota:2026-08". */
export function quotaKey(date: Date = new Date()): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `vision-quota:${y}-${m}`;
}

export async function readQuota(kv: KVNamespace): Promise<number> {
	const raw = await kv.get(quotaKey());
	return raw ? Number(raw) : 0;
}

/**
 * Incrémente le compteur du mois courant. KV n'a pas d'incrément atomique et
 * est éventuellement cohérent : une lecture-puis-écriture concurrente peut se
 * chevaucher (compteur sous-évalué de 1 dans le pire cas). Accepté ici : usage
 * solo/duo, jamais de vraie concurrence côté brocante — le seul risque est de
 * sous-compter (jamais bloquer à tort), absorbé par la marge de sécurité entre
 * le seuil (900) et le vrai plafond Google (1000). Si l'usage devenait
 * multi-utilisateur concurrent, remplacer par un Durable Object (compteur
 * mono-thread, incrément vraiment atomique).
 */
export async function incrementQuota(kv: KVNamespace): Promise<number> {
	const next = (await readQuota(kv)) + 1;
	// expirationTtl ~40 jours : les compteurs des mois passés s'auto-nettoient,
	// pas besoin d'un job de ménage séparé.
	await kv.put(quotaKey(), String(next), { expirationTtl: 60 * 60 * 24 * 40 });
	return next;
}
