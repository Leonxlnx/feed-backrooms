import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-server only: tools/record.js POSTs rendered frames / the mixed soundtrack here and they land in
// .capture/ (git-ignored), ready for ffmpeg. Nothing of this exists in a production build.
const capture = {
  name: 'feed-capture',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__capture', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
      const q = new URL(req.url, 'http://x').searchParams;
      const clean = (s, d) => (s || d).replace(/[^a-z0-9_-]/gi, '');
      const ext = ['jpg', 'png', 'wav', 'json'].includes(q.get('e')) ? q.get('e') : 'jpg';
      const dir = path.resolve('.capture', clean(q.get('d'), 'misc'));
      fs.mkdirSync(dir, { recursive: true });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(path.join(dir, clean(q.get('n'), 'shot') + '.' + ext), Buffer.concat(chunks));
        res.end('ok');
      });
    });
  },
};

// hmr off: the page only reloads when you press F5, so saving a file never yanks you out of a run
export default defineConfig({ plugins: [capture], server: { hmr: false } });
