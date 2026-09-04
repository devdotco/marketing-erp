const PEXELS_API = "https://api.pexels.com/v1";

export interface PexelsPhoto {
  id: number;
  url: string;
  src: {
    original: string;
    large2x: string;
    large: string;
  };
  alt: string;
}

export async function searchPhotos(query: string, count = 3): Promise<PexelsPhoto[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY not set");

  const res = await fetch(
    `${PEXELS_API}/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
    { headers: { Authorization: key } }
  );

  if (!res.ok) throw new Error(`Pexels search failed (${res.status})`);

  const data = await res.json() as { photos: PexelsPhoto[] };
  return data.photos.slice(0, count);
}

export async function downloadPhoto(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo download failed (${res.status})`);
  return res.arrayBuffer();
}
