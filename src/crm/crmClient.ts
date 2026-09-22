import crypto from "crypto";

export interface Lead {
    listingId: string;
    name: string;
    phone: string;
    email: string;
    message: string;
}

export interface LeadResult {
    id: string;
    createdAt: string;
}

export class CrmError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "CrmError";
        this.status = status;
    }
}

export interface CrmClientConfig {
    baseUrl?: string;
    token: string;
    timeoutMs?: number;
    maxAttempts?: number;
    fetchImpl?: typeof fetch; // injectable pour les tests
    sleep?: (ms: number) => Promise<void>; // idem, évite d'attendre pour de vrai en test
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 429 et 5xx sont temporaires, on peut réessayer. Les autres 4xx (mauvais payload, token invalide...) ne changeront pas au prochain essai
function isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
}

// 200ms, 400ms, 800ms, 1600ms...
function backoffDelay(attempt: number): number {
    return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

// Le token peut se retrouver dans le corps d'une réponse d'erreur du CRM, on le masque avant de le mettre dans un message qui finira dans les logs
function redactToken(message: string, token: string): string {
    return token ? message.split(token).join("[REDACTED]") : message;
}

// Clé dérivée du contenu du lead plutôt qu'aléatoire : si le même lead est renvoyé (retry manuel, double-clic), le CRM le reconnaît et ne le crée pas une deuxième fois
function buildIdempotencyKey(lead: Lead): string {
    const raw = `${lead.listingId}|${lead.email}|${lead.phone}|${lead.message}`;
    return crypto.createHash("sha256").update(raw).digest("hex");
}

export function createCrmClient(config: CrmClientConfig) {
    const {
        baseUrl = "https://crm.example.com/v1",
        token,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        fetchImpl = fetch,
        sleep = defaultSleep,
    } = config;

    async function doFetch(lead: Lead, idempotencyKey: string): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetchImpl(`${baseUrl}/leads`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "Idempotency-Key": idempotencyKey,
                },
                body: JSON.stringify(lead),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async function buildErrorFromResponse(response: Response): Promise<CrmError> {
        let detail = "";
        try {
            detail = await response.text();
        } catch {
            // corps illisible, tant pis
        }
        return new CrmError(
            redactToken(`CRM a répondu ${response.status}${detail ? `: ${detail}` : ""}`, token),
            response.status
        );
    }

    async function createLead(lead: Lead): Promise<LeadResult> {
        const idempotencyKey = buildIdempotencyKey(lead);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let response: Response;

            try {
                response = await doFetch(lead, idempotencyKey);
            } catch (err) {
                const isTimeout = err instanceof Error && err.name === "AbortError";
                const message = redactToken(
                    isTimeout ? "Timeout CRM dépassé (5s)" : `Erreur réseau CRM: ${(err as Error).message}`,
                    token
                );
                if (attempt === maxAttempts) {
                    throw new CrmError(message);
                }
                await sleep(backoffDelay(attempt));
                continue;
            }

            if (response.ok) {
                return (await response.json()) as LeadResult;
            }

            // 4xx hors 429 : inutile de réessayer, on remonte tout de suite
            if (!isRetryableStatus(response.status)) {
                throw await buildErrorFromResponse(response);
            }

            // Dernier essai épuisé sur une erreur temporaire : on abandonne
            if (attempt === maxAttempts) {
                throw await buildErrorFromResponse(response);
            }

            // Si le CRM indique un délai (429 + Retry-After), on le respecte, sinon backoff exponentiel
            const retryAfterHeader = response.headers.get("Retry-After");
            const delay =
                response.status === 429 && retryAfterHeader
                    ? Number(retryAfterHeader) * 1000
                    : backoffDelay(attempt);

            await sleep(delay);
        }

        // La boucle sort toujours par return ou throw, mais TS ne peut pas le prouver : cette ligne le rassure sur le type de retour
        throw new CrmError("Échec inattendu de création du lead.");
    }

    return { createLead };
}