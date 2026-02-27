import { serve } from "bun";
import { join } from "path";

const PORT = 3000;
const DIST_DIR = join(import.meta.dir, "..", "dist");

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    
    if (path === "/") path = "/index.html";
    
    const file = Bun.file(join(DIST_DIR, path));
    if (await file.exists()) {
      return new Response(file);
    }
    
    // Fallback to index.html for SPA routing
    return new Response(Bun.file(join(DIST_DIR, "index.html")));
  },
});

console.log(`Server running at http://localhost:${PORT}`);
