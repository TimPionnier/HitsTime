import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dailyShards } from './build/dailyShards';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), dailyShards()],
});
