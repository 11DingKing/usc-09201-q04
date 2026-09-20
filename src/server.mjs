import { createServer } from './http.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`林权融资占用服务已启动：http://0.0.0.0:${port}`);
  });
}

export { createServer } from './http.mjs';
export { TOKENS } from './http.mjs';
