import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'dist/client'},server:{host:'0.0.0.0',proxy:{'/api':'http://localhost:3000'}}});
