import { describe, it, expect, vi } from "vitest";
import {createCrmClient, CrmError, type Lead} from "../crmClient.js";

const sampleLead: Lead = {
    listingId: "listing-1",
    name: "Rasoa",
    phone: "0341234567",
    email: "rasoa@example.com",
    message: "Intéressée par cette annonce",
};

// Évite de dépendre d'un vrai fetch : on ne veut tester que la logique du client (retries, idempotence, timeouts), pas la couche réseau
function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (key: string) => headers[key] ?? null,
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

describe("crmClient.createLead", () => {
    it("réussit après un 429 suivi d'un succès (respecte Retry-After)", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(mockResponse(429, { error: "quota" }, { "Retry-After": "1" }))
            .mockResolvedValueOnce(mockResponse(201, { id: "lead-1", createdAt: "2026-09-22T10:00:00Z" }));

        // sleep est injecté pour ne pas attendre 1s pour de vrai pendant le test
        const sleep = vi.fn().mockResolvedValue(undefined);

        const client = createCrmClient({
            token: "secret-token",
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleep,
        });

        const result = await client.createLead(sampleLead);

        expect(result).toEqual({ id: "lead-1", createdAt: "2026-09-22T10:00:00Z" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        // Retry-After: 1 doit se traduire en 1000ms, pas en backoff par défaut
        expect(sleep).toHaveBeenCalledWith(1000);
    });

    it("abandonne après 3 échecs 500 consécutifs", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(mockResponse(500, { error: "internal" }))
            .mockResolvedValueOnce(mockResponse(500, { error: "internal" }))
            .mockResolvedValueOnce(mockResponse(500, { error: "internal" }));

        const sleep = vi.fn().mockResolvedValue(undefined);

        const client = createCrmClient({
            token: "secret-token",
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleep,
            maxAttempts: 3,
        });

        await expect(client.createLead(sampleLead)).rejects.toThrow(CrmError);
        expect(fetchImpl).toHaveBeenCalledTimes(3);

        // Vérifie que le token n'apparaît pas dans le message d'erreur final au cas où le CRM le renverrait dans son corps de réponse
        try {
            await client.createLead(sampleLead);
        } catch (err) {
            expect((err as Error).message).not.toContain("secret-token");
        }
    });
});