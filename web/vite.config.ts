import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 /api를 로컬 사이드카로 넘긴다: MSDASH_API=http://127.0.0.1:18081 npm run dev
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: { '/api': process.env.MSDASH_API ?? 'http://127.0.0.1:8080' },
	},
	build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 800 },
});
