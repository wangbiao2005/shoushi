import { defineConfig } from 'vite';

export default defineConfig({
  // 使用相对路径 './' 可以确保资源在 GitHub Pages 的子目录（如 /repo-name/）或自定义域名根目录下都能正确加载
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false
  },
  server: {
    host: true
  }
});