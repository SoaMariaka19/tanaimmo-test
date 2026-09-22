import type { Request, Response } from "express";
import crypto from "crypto";

interface Db {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface PaymentEvent {
    id: string;
    type: string;
    booking_id: string;
    customer_email: string;
    [key: string]: unknown;
}

interface Dependencies {
    db: Db;
    sendEmail: (to: string, subject: string, body: string) => Promise<void>;
    notifyCrm: (event: PaymentEvent) => Promise<void>;
    buildReceipt: (event: PaymentEvent) => string;
    webhookSecret: string;
}

// En mémoire pour l'instant ; à remplacer par une table dédiée (ou Redis) si l'API tourne sur plusieurs instances
const processedEventIds = new Set<string>();

function isValidSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    // timingSafeEqual exige des buffers de même taille, sinon il throw
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidPayload(body: unknown): body is PaymentEvent {
    if (typeof body !== "object" || body === null) return false;
    const e = body as Record<string, unknown>;
    return (
        typeof e.id === "string" &&
        typeof e.type === "string" &&
        typeof e.booking_id === "string" &&
        typeof e.customer_email === "string"
    );
}

export function createPaymentWebhookHandler(deps: Dependencies) {
    const { db, sendEmail, notifyCrm, buildReceipt, webhookSecret } = deps;

    return async function handlePaymentWebhook(req: Request, res: Response) {
        // rawBody est capturé par express.json({ verify }) en amont ; on retombe sur JSON.stringify seulement si le middleware n'a pas été branché
        const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
        const signature = req.header("X-Signature");

        if (!isValidSignature(rawBody, signature, webhookSecret)) {
            return res.status(401).json({ error: "Signature invalide." });
        }

        if (!isValidPayload(req.body)) {
            return res.status(400).json({ error: "Payload invalide." });
        }

        const event = req.body;

        // Le prestataire réessaie jusqu'à 5 fois : sans ce garde-fou, un simple timeout réseau provoquerait un second email et une seconde notif CRM
        if (processedEventIds.has(event.id)) {
            return res.status(200).send("ok (déjà traité)");
        }

        try {
            if (event.type === "payment.succeeded") {
                // On ne garde en synchrone que ce qui doit être cohérent avant d'accuser réception
                await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["paid", event.booking_id]);
            }

            processedEventIds.add(event.id);

            // Réponse immédiate : le CRM peut prendre 2 à 8 s, on ne veut pas dépasser les 10 s du prestataire et déclencher des réessais
            res.status(200).send("ok");

            // Effets de bord différés. Un échec ici ne doit pas invalider le paiement, d'où le .catch() local plutôt qu'un throw
            if (event.type === "payment.succeeded") {
                void sendEmail(event.customer_email, "Paiement confirmé", buildReceipt(event)).catch((err) => {
                    console.error(`Échec envoi email pour l'événement ${event.id}:`, err);
                });
                void notifyCrm(event).catch((err) => {
                    console.error(`Échec notification CRM pour l'événement ${event.id}:`, err);
                });
            }
        } catch (err) {
            console.error(`Erreur traitement webhook paiement (event ${event.id}):`, err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Erreur interne." });
            }
        }
    };
}