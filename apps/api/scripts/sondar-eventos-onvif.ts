/**
 * SONDAGEM: que eventos cada câmera sabe emitir?
 *
 * Read-only, diagnóstico. Pergunta a cada câmera com ONVIF configurado o
 * catálogo de tópicos que ela publica (`GetEventProperties`) e classifica o
 * que interessa para perímetro:
 *
 *   LineDetector/Crossed        → cruzamento de linha COM direção (tripwire)
 *   FieldDetector/ObjectsInside → intrusão em área
 *   *Motion*                    → movimento genérico (o que já usamos)
 *
 * Por que isto importa: se a câmera resolve tripwire no próprio chip, a
 * detecção sai de graça — sem custo de CPU no servidor e sem construir
 * rastreamento de trajetória. O DRAC já recebe eventos ONVIF destas câmeras;
 * o filtro em onvif-events.service.ts é que descarta tudo que não é movimento.
 *
 * Uso (dentro do container da API):
 *   node --import tsx scripts/sondar-eventos-onvif.ts
 */
import { PrismaClient } from '@prisma/client';
import { createDecipheriv, createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const onvif = require('onvif');

const prisma = new PrismaClient();
const TEMPO_LIMITE_MS = 12_000;

function decifrar(payload: string): string {
  const secret = (process.env.CAMERA_SECRET_KEY ?? '').trim();
  if (!secret) throw new Error('CAMERA_SECRET_KEY ausente');
  const key = createHash('sha256').update(secret).digest();
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** Achata a árvore de tópicos do ONVIF em caminhos "A/B/C". */
function achatarTopicos(no: any, prefixo = '', saida: string[] = []): string[] {
  if (!no || typeof no !== 'object') return saida;
  for (const [chave, valor] of Object.entries(no)) {
    if (chave.startsWith('$') || chave === 'messageDescription') continue;
    const caminho = prefixo ? `${prefixo}/${chave}` : chave;
    // Nó folha de tópico: tem messageDescription ou o atributo topic=true.
    const ehTopico = valor && typeof valor === 'object'
      && ('messageDescription' in (valor as any) || (valor as any)?.$?.topic === true || (valor as any)?.$?.topic === 'true');
    if (ehTopico) saida.push(caminho);
    achatarTopicos(valor, caminho, saida);
  }
  return saida;
}

type Resultado = {
  nome: string;
  ip: string;
  porta: number;
  ok: boolean;
  erro?: string;
  topicos: string[];
  temLinha: boolean;
  temIntrusao: boolean;
  temMovimento: boolean;
};

async function sondar(camera: any): Promise<Resultado> {
  const base: Resultado = {
    nome: camera.name, ip: camera.ip, porta: camera.onvifPort,
    ok: false, topicos: [], temLinha: false, temIntrusao: false, temMovimento: false,
  };
  let senha: string;
  try {
    senha = decifrar(camera.passwordEncrypted);
  } catch (e) {
    return { ...base, erro: `credencial ilegível: ${(e as Error).message}` };
  }

  return new Promise<Resultado>((resolve) => {
    let encerrado = false;
    const terminar = (r: Resultado) => { if (!encerrado) { encerrado = true; resolve(r); } };
    const corte = setTimeout(() => terminar({ ...base, erro: 'sem resposta a tempo' }), TEMPO_LIMITE_MS);

    try {
      const cam = new onvif.Cam(
        { hostname: camera.ip, username: camera.username, password: senha, port: camera.onvifPort, timeout: 8000 },
        (err: any) => {
          if (err) { clearTimeout(corte); return terminar({ ...base, erro: `conexão: ${err.message}` }); }
          // `GetEventProperties` é o catálogo declarado pela câmera: o que ela
          // DIZ que sabe emitir. Não prova que há regra configurada — prova que
          // o equipamento é capaz.
          cam.getEventProperties((e2: any, resposta: any) => {
            clearTimeout(corte);
            if (e2) return terminar({ ...base, erro: `getEventProperties: ${e2.message}` });
            const topicos = achatarTopicos(resposta?.topicSet ?? resposta);
            const texto = topicos.join(' ').toLowerCase();
            terminar({
              ...base,
              ok: true,
              topicos,
              temLinha: /linedetector|crossed|tripwire|linecross/.test(texto),
              temIntrusao: /fielddetector|objectsinside|intrusion|intrus/.test(texto),
              temMovimento: /motion|cellmotion|motionalarm/.test(texto),
            });
          });
        },
      );
      cam.on('error', () => {});
    } catch (e) {
      clearTimeout(corte);
      terminar({ ...base, erro: `exceção: ${(e as Error).message}` });
    }
  });
}

async function main() {
  const cameras = await prisma.camera.findMany({
    where: { onvifPort: { not: null }, enabled: true },
    select: { id: true, name: true, ip: true, onvifPort: true, username: true, passwordEncrypted: true, status: true },
    orderBy: { name: 'asc' },
  });
  console.log(`Sondando ${cameras.length} câmera(s) com ONVIF configurado...\n`);

  // De 3 em 3: rajada contra o mesmo equipamento esgota as sessões dele.
  const resultados: Resultado[] = [];
  for (let i = 0; i < cameras.length; i += 3) {
    resultados.push(...await Promise.all(cameras.slice(i, i + 3).map(sondar)));
  }

  const marca = (v: boolean) => (v ? 'SIM' : ' - ');
  console.log('CÂMERA                          LINHA  INTRUSÃO  MOVIMENTO  OBSERVAÇÃO');
  console.log('─'.repeat(88));
  for (const r of resultados) {
    const obs = r.ok ? `${r.topicos.length} tópicos` : (r.erro ?? 'falhou');
    console.log(`${r.nome.padEnd(31)} ${marca(r.temLinha).padEnd(6)} ${marca(r.temIntrusao).padEnd(9)} ${marca(r.temMovimento).padEnd(10)} ${obs}`);
  }

  const comLinha = resultados.filter((r) => r.temLinha);
  const comIntrusao = resultados.filter((r) => r.temIntrusao);
  console.log('\n' + '─'.repeat(88));
  console.log(`Responderam: ${resultados.filter((r) => r.ok).length}/${resultados.length}`);
  console.log(`Suportam cruzamento de LINHA: ${comLinha.length}`);
  console.log(`Suportam INTRUSÃO em área:   ${comIntrusao.length}`);

  // Detalhe COMPLETO de quem suporta linha/intrusão: são os tópicos exatos que
  // o filtro do onvif-events.service precisa reconhecer.
  for (const r of resultados.filter((x) => x.temLinha || x.temIntrusao)) {
    console.log(`\nTópicos de "${r.nome}" (linha/intrusão):`);
    for (const t of r.topicos) console.log(`  ${t}`);
  }
  const semLinha = resultados.find((r) => r.ok && !r.temLinha);
  if (semLinha) {
    console.log(`\nPara comparar — "${semLinha.nome}" (sem linha):`);
    for (const t of semLinha.topicos) console.log(`  ${t}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
