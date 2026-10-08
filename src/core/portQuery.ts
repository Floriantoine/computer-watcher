/** Recherche d'un port : « :3000 » ou « port:3000 » (casse et espaces autour ignorés), seule dans la recherche. */
const PORT_QUERY = /^(?:port)?:(\d{1,5})$/i;

/** Port cherché (1–65535), ou null : la recherche est alors une recherche plein texte ordinaire. Pur (main et renderer). */
export function parsePortQuery(q: string): number | null {
  const m = PORT_QUERY.exec(q.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}
