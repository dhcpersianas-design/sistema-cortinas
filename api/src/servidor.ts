import { criarApp } from './app.js';
import { lerConfig } from './config.js';

const config = lerConfig();
const app = await criarApp(config);
await app.listen({ port: config.porta, host: '0.0.0.0' });
