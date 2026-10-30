/**
 * npm run setup  →  crea la D1, escribe el database_id en wrangler.toml y crea las tablas.
 * Requisito previo: npx wrangler login
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PLACEHOLDER = 'PEGA_AQUI_TU_DATABASE_ID';
const sh = (cmd) => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
};

let toml = fs.readFileSync('wrangler.toml', 'utf8');
const current = toml.match(/database_id\s*=\s*"([^"]+)"/);
let dbId = current && current[1] !== PLACEHOLDER ? current[1] : null;

if (dbId) {
  console.log('• database_id ya estaba configurado:', dbId);
} else {
  console.log('• Creando base de datos D1 «rankagent» …');
  const created = sh('npx wrangler d1 create rankagent');
  const mId = created.out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i);
  if (created.ok && mId) {
    dbId = mId[1];
  } else {
    // probablemente ya existe: recuperar el id con `d1 info`
    console.log('• Ya existía (o hubo un aviso). Consultando el id con «wrangler d1 info» …');
    const info = sh('npx wrangler d1 info rankagent');
    const mInfo = info.out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (mInfo) dbId = mInfo[1];
  }

  if (!dbId) {
    console.error('\n✗ No se pudo obtener el database_id.');
    console.error('  Causa habitual: no has iniciado sesión. Ejecuta primero:\n    npx wrangler login\n');
    console.error('  (Salida del comando:\n' + created.out.trim().split('\n').slice(0, 8).map((l) => '    ' + l).join('\n') + ')');
    process.exit(1);
  }

  toml = toml.replace(/database_id\s*=\s*"[^"]+"/, `database_id = "${dbId}"`);
  fs.writeFileSync('wrangler.toml', toml);
  console.log('✓ database_id escrito en wrangler.toml →', dbId);
}

console.log('• Creando tablas en la D1 remota (schema.sql) …');
const exec = sh('npx wrangler d1 execute rankagent --remote --file schema.sql');
if (!exec.ok) {
  console.error('\n✗ Falló la creación de tablas.');
  if (/login|auth|10000/i.test(exec.out)) console.error('  Ejecuta primero: npx wrangler login');
  console.error(exec.out.trim().split('\n').slice(-8).join('\n'));
  process.exit(1);
}
console.log('✓ Tablas listas (users, sessions, clients, runs, settings)');
console.log('\nTodo configurado → ejecuta:  npm run deploy');
