import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['src/test-setup.ts'],
		alias: {
			'$lib': path.resolve('./src/lib'),
			'$env/dynamic/private': path.resolve('./src/lib/server/__env_shim__.ts')
		}
	}
});
