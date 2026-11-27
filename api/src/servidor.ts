import { criarApp } from './app.js';
import { lerConfig } from './config.js';
import { agendarBackupDiario } from './backup.js';

const config = lerConfig();
const app = await criarApp(config);
await app.listen({ port: config.porta, host: '0.0.0.0' });
if (config.pastaBackups) {
  agendarBackupDiario({
    databaseUrl: config.databaseUrl, pasta: config.pastaBackups,
    manter: config.backupsManter ?? 14, hora: config.backupHora ?? 3,
    log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
  });
}
