import type { Request, Response } from "express";

interface Db {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface ListingRow {
    id: string;
    title: string;
    price: number;
    city: string;
    created_at: string;
    agency: { id: string | null; name: string | null; phone: string | null };
    photos: { url: string }[];
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function createListingsHandler(db: Db) {
    return async function getListings(req: Request, res: Response) {
        const { city } = req.query;

        if (typeof city !== "string" || city.trim() === "") {
            return res.status(400).json({ error: "Le paramètre 'city' est requis." });
        }

        const pageParam = Number(req.query.page);
        const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
        const pageSize = DEFAULT_PAGE_SIZE;
        const offset = (page - 1) * pageSize;

        // Une seule requête pour listings + agence + photos : jsonb_agg évite le N+1 qu'on aurait avec une boucle côté Node
        const sql = `
      SELECT
        l.id, l.title, l.price, l.city, l.created_at,
        jsonb_build_object(
          'id',    a.id,
          'name',  a.name,
          'phone', a.phone
        ) AS agency,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('url', p.url))
            FILTER (WHERE p.id IS NOT NULL),
          '[]'::jsonb
        ) AS photos
      FROM listings l
      LEFT JOIN agencies a ON a.id = l.agency_id
      LEFT JOIN photos   p ON p.listing_id = l.id
      WHERE l.city = $1
      GROUP BY l.id, a.id
      ORDER BY l.created_at DESC
      LIMIT $2 OFFSET $3
    `;

        try {
            const rows = await db.query<ListingRow>(sql, [
                city,
                Math.min(pageSize, MAX_PAGE_SIZE),
                offset,
            ]);
            return res.json(rows);
        } catch (err) {
            console.error("Erreur /api/listings:", err);
            return res.status(500).json({ error: "Erreur interne du serveur." });
        }
    };
}