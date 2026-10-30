// Publica uma versao nova do PDV para a atualizacao automatica.
// Uso (na pasta KanguruPDV):  node scripts/release-pdv.mjs "Notas da versao"
// 1. Gera o instalador assinado (chave em C:\Users\PC\.tauri\kanguru-pdv.key, fora do Git).
// 2. Monta release/latest.json com a versao, a assinatura e o link do instalador.
// 3. Envia instalador + latest.json para o bucket publico "pdv-updates" do Supabase (CLI linkado).
// A versao vem de src-tauri/tauri.conf.json: aumente o numero antes de publicar.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyPath = join(homedir(), '.tauri', 'kanguru-pdv.key');
const bucketUrl = 'https://qnxmboxwluuyjvgiqlbm.supabase.co/storage/v1/object/public/pdv-updates';
const supabaseWorkdir = resolve(root, '..', 'KanguruERP');

if (!existsSync(keyPath)) {
  console.error(`Chave de assinatura não encontrada em ${keyPath}. Sem ela não dá para publicar atualização.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = config.version;
const args = process.argv.slice(2);
const notes = args.find((arg) => !arg.startsWith('--')) || `Versão ${version}`;

// --no-build: publica o instalador ja gerado (assinado) desta versao.
if (!args.includes('--no-build')) {
  console.log(`Gerando o instalador ${version}...`);
  execSync('npx tauri build --bundles nsis', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
  });
}

const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const installer = join(bundleDir, `Kanguru PDV_${version}_x64-setup.exe`);
const signature = `${installer}.sig`;
if (!existsSync(installer) || !existsSync(signature)) {
  console.error('Instalador ou assinatura não foram gerados.');
  process.exit(1);
}

// Nome sem espacos para o link publico.
const remoteName = `Kanguru-PDV_${version}_x64-setup.exe`;
const releaseDir = join(root, 'release');
mkdirSync(releaseDir, { recursive: true });
copyFileSync(installer, join(releaseDir, remoteName));
writeFileSync(join(releaseDir, 'latest.json'), JSON.stringify({
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(signature, 'utf8').trim(),
      url: `${bucketUrl}/${remoteName}`,
    },
  },
}, null, 2));

console.log('Enviando para o Supabase Storage (bucket pdv-updates)...');
// O CLI nao sobrescreve arquivo existente: remove antes (ignora se ainda nao existe).
const upload = (file) => {
  try {
    execSync(`npx supabase storage rm "ss:///pdv-updates/${file}" --linked --experimental --yes`, { cwd: supabaseWorkdir, stdio: 'ignore' });
  } catch {
    // arquivo ainda nao existia
  }
  execSync(
    // Caminho relativo e sem acento: o cmd do Windows estraga o "ç" de "Programação".
    `npx supabase storage cp "../KanguruPDV/release/${file}" "ss:///pdv-updates/${file}" --linked --experimental`,
    { cwd: supabaseWorkdir, stdio: 'inherit' },
  );
};
upload(remoteName);
// Link fixo para instalar em loja nova (sempre a versao mais recente).
copyFileSync(installer, join(releaseDir, 'Kanguru-PDV-setup.exe'));
upload('Kanguru-PDV-setup.exe');
// latest.json por ultimo: so anuncia a versao depois que o instalador ja esta no ar.
upload('latest.json');

console.log(`Pronto: versão ${version} publicada. Os PDVs mostram o aviso ao abrir (ou em até 4 horas).`);
console.log(`Instalação em loja nova: ${bucketUrl}/Kanguru-PDV-setup.exe`);
